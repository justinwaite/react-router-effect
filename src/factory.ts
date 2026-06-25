import { Effect } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
  type LoaderFunctionArgs,
} from "react-router";

import {
  isRouteError,
  ReturnableDataError,
  ThrowableDataError,
  type AnyRouteError,
} from "./errors.ts";

// ---------------------------------------------------------------------------
// Type-level plumbing.
// ---------------------------------------------------------------------------

type Tagged = { readonly _tag: string };

/**
 * Everything a failure branch rejects with. React Router routes a thrown
 * `DataWithResponseInit` to the boundary as an `ErrorResponse`, and a thrown
 * `Response` (including `redirect(...)`) as-is. Pinning every `Effect.fail` branch
 * to this union keeps inference from fixing the error channel to the first one.
 */
type FailureResponse = DataWithResponseInit<unknown> | Response;

/**
 * What a handler may return, to *remap* a domain error:
 *  - a **library route error** — `Respond.early(value)` (recover), `Respond.throw(data)`
 *    or `Respond.redirect(url)` (throw) — which the library then processes; or
 *  - an **`Effect`** — `Effect.succeed(value)` to recover with `value`, or
 *    `Effect.fail(response)` to throw `response`.
 */
export type ErrorHandler<Err> = (
  error: Err,
) => AnyRouteError | Effect.Effect<unknown, FailureResponse>;

/** The body of every `ReturnableDataError` raised directly in `E` (`Respond.early`). */
type ReturnableBodyOf<E> = E extends ReturnableDataError<infer Body> ? Body : never;

/**
 * The recover contribution of a `Respond.early` raised directly in the loader.
 * Guarded so a loader that never recovers directly doesn't leak
 * `DataWithResponseInit<never>` into its return type.
 */
type DirectRecover<E> = [ReturnableBodyOf<E>] extends [never]
  ? never
  : DataWithResponseInit<ReturnableBodyOf<E>>;

/** The domain errors a handler map registers — derived from the handlers' params. */
type RegisteredError<Handlers> = {
  [Tag in keyof Handlers]: Handlers[Tag] extends (error: infer Err) => unknown ? Err : never;
}[keyof Handlers];

/**
 * What the registered handlers recover into loader/action data — derived from the
 * handlers' returns, but only for handlers whose error can actually occur in `E`:
 *  - a remapped `ReturnableDataError<B>` recovers as `DataWithResponseInit<B>`;
 *  - an `Effect.succeed(value)` recovers as `value`;
 *  - throwables, redirects and `Effect.fail(...)` contribute nothing.
 */
type RecoverOf<Handlers, E> = {
  [Tag in keyof Handlers]: Handlers[Tag] extends (error: infer Err) => infer R
    ? [Extract<E, Err>] extends [never]
      ? never
      :
          | (R extends ReturnableDataError<infer B> ? DataWithResponseInit<B> : never)
          | (R extends Effect.Effect<infer SuccessValue, any, any> ? SuccessValue : never)
    : never;
}[keyof Handlers];

/** Shape every handler must satisfy: return a library route error or an `Effect` failing with a response. */
type ValidHandlers = Record<
  string,
  (error: never) => AnyRouteError | Effect.Effect<unknown, FailureResponse>
>;

// ---------------------------------------------------------------------------
// Internal runtime helpers.
// ---------------------------------------------------------------------------

const internalServerError = () =>
  Effect.fail<FailureResponse>(new Response("Internal Server Error", { status: 500 }));

/** The internal dispatch for a library route error: recover, throw, or redirect. */
const processRouteError = (
  e: AnyRouteError,
): Effect.Effect<DataWithResponseInit<unknown>, FailureResponse> => {
  if (e instanceof ReturnableDataError) return Effect.succeed(data(e.data, e.init));
  if (e instanceof ThrowableDataError) return Effect.fail<FailureResponse>(data(e.data, e.init));
  return Effect.fail<FailureResponse>(redirect(e.url, e.init));
};

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Build `makeLoader` / `makeAction` for an application, wired to its domain errors.
 *
 * Register a handler per domain error in `errorHandlers` (**annotate each handler's
 * param** — the registered set and recover types are derived from the map). A
 * handler *remaps* the error by returning either a library route error
 * (`Respond.early` to recover; `Respond.throw` / `Respond.redirect` to throw) or an
 * `Effect` (`Effect.succeed(value)` to recover `value`; `Effect.fail(response)` to
 * throw). Recovered values become loader/action data, typed precisely (non-generic).
 *
 * Handling is optional: an *unregistered* error is allowed. If it implements
 * `HttpServerRespondable` it's rendered automatically; otherwise it rejects to the
 * error boundary as a 500.
 *
 * @example
 * ```ts
 * const { makeLoader, makeAction } = makeLoaderOrActionFactory({
 *   errorHandlers: {
 *     // throw → error boundary
 *     MyDomainError: (error: MyDomainError) =>
 *       Effect.fail(new Response(error.message, { status: 400 })),
 *     // remap → recover via a library returnable
 *     FormError: (error: FormError) => Respond.early({ reply: error.reply }),
 *   },
 * });
 * ```
 */
export function makeLoaderOrActionFactory<const Handlers>(
  config: { errorHandlers: Handlers },
  // Validation: a handler that doesn't return a route error or a failing `Effect`
  // makes this rest parameter required, forcing a compile error at the call.
  ..._validate: Handlers extends ValidHandlers
    ? []
    : [eachHandlerMustReturnARouteErrorOrAnEffectFailingWithAResponse: ValidHandlers]
) {
  /** Domain errors this factory has handlers for. */
  type UserError = Extract<RegisteredError<Handlers>, Tagged>;

  const isUserError = (e: unknown): e is UserError =>
    typeof e === "object" &&
    e !== null &&
    "_tag" in e &&
    (e as Tagged)._tag in (config.errorHandlers as object);

  // Uniform call signature for dispatch (the per-tag handler types are narrower).
  const userHandlers = config.errorHandlers as unknown as Record<string, ErrorHandler<UserError>>;

  function makeLoaderOrAction<Args extends LoaderFunctionArgs | ActionFunctionArgs, A, E>(
    fn: (args: Args) => Effect.Effect<A, E>,
    // The resolved value: the loader's own success, the body of any `Respond.early`
    // raised directly, plus everything the registered (and reachable) handlers
    // recover with.
  ): (args: Args) => Promise<A | DirectRecover<E> | RecoverOf<Handlers, E>> {
    return (args: Args) =>
      // The internal channel is deliberately loose (`unknown` success); the outer
      // cast restores the precise resolved type (computed from `E` and the handler
      // map). Sound at runtime — the values produced are exactly those types.
      Effect.runPromise(
        fn(args).pipe(
          // Catch the whole error channel and dispatch. The refinement is `e is E`
          // (provably ⊆ E, and a *refinement* not a bare predicate — the predicate
          // overload crashes tsc over a generic `E`). Unregistered, non-respondable
          // errors fall through to the 500 default.
          Effect.catchIf(
            (_e): _e is E => true,
            (e): Effect.Effect<unknown, FailureResponse> => {
              // Registered domain error → remap. A library-error return is processed
              // by the internal dispatch; an `Effect` return is used as-is.
              if (isUserError(e)) {
                const out = userHandlers[e._tag](e);
                return isRouteError(out) ? processRouteError(out) : out;
              }
              // A library route error raised directly in the loader → recover/throw.
              if (isRouteError(e)) return processRouteError(e);
              // Respondable → render its own response and throw it.
              if (HttpServerRespondable.isRespondable(e)) {
                return HttpServerRespondable.toResponse(e).pipe(
                  Effect.flatMap((res) =>
                    Effect.fail<FailureResponse>(HttpServerResponse.toWeb(res)),
                  ),
                );
              }
              return internalServerError();
            },
          ),
        ),
      ) as Promise<A | DirectRecover<E> | RecoverOf<Handlers, E>>;
  }

  return {
    makeLoaderOrAction,
    makeLoader: makeLoaderOrAction,
    makeAction: makeLoaderOrAction,
  };
}
