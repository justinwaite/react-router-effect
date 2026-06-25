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

/**
 * Errors the library deals with on the loader's behalf — so the loader needn't
 * handle them itself:
 *  - the app's **declared domain errors** (`DomainError`) — handled by a registered
 *    handler, or left to the 500 / auto-respond default;
 *  - **library route errors** raised directly via `Respond`;
 *  - anything that renders itself via **`HttpServerRespondable`**.
 */
type LibraryHandled<DomainError> = DomainError | AnyRouteError | HttpServerRespondable.Respondable;

/**
 * What remains in a loader/action's error channel that the library will NOT handle
 * — i.e. service-specific errors the route consumes that aren't declared domain
 * errors. The loader/action must handle these itself (catch or map them).
 */
type Unhandled<E, DomainError> = Exclude<E, LibraryHandled<DomainError>>;

/**
 * The shape a handler map must satisfy: an OPTIONAL handler per declared domain
 * error, keyed by its tag, taking that error and returning a library route error
 * or an `Effect` failing with a response. Used only as a validation constraint —
 * the concrete handler types stay precise via the `const Handlers` inference.
 */
type ValidHandlers<DomainError extends Tagged> = {
  [Tag in DomainError["_tag"]]?: (
    error: Extract<DomainError, { readonly _tag: Tag }>,
  ) => AnyRouteError | Effect.Effect<unknown, FailureResponse>;
};

/**
 * True when every registered handler is keyed by a declared domain error's tag and
 * returns a library route error or a failing `Effect`. A handler for an unknown tag
 * (`keyof Handlers` escaping the domain tags) or with a bad return makes it `false`.
 */
type HandlersAreValid<Handlers, DomainError extends Tagged> = [keyof Handlers] extends [
  DomainError["_tag"],
]
  ? Handlers extends ValidHandlers<DomainError>
    ? true
    : false
  : false;

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
 * Declare the app's **domain errors** as the type argument, then register an
 * *optional* handler per domain error in `errorHandlers` (**annotate each handler's
 * param**). It's curried so you can pin the domain errors while the handler types
 * are still inferred:
 *
 * ```ts
 * type DomainErrors = MyDomainError | DbError | NotAuthorizedError;
 *
 * const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
 *   errorHandlers: {
 *     // throw → error boundary
 *     MyDomainError: (error: MyDomainError) =>
 *       Effect.fail(new Response(error.message, { status: 400 })),
 *     // DbError has no handler → falls through to the 500 default.
 *   },
 * });
 * ```
 *
 * A handler *remaps* the error by returning either a library route error
 * (`Respond.early` to recover; `Respond.throw` / `Respond.redirect` to throw) or an
 * `Effect` (`Effect.succeed(value)` to recover `value`; `Effect.fail(response)` to
 * throw). Recovered values become loader/action data, typed precisely.
 *
 * **Declared domain errors** may be left unhandled: if one implements
 * `HttpServerRespondable` it's rendered automatically, otherwise it falls through
 * to a 500. **Any other error** — a service-specific error the route consumes that
 * isn't a declared domain error — *must* be handled in the loader/action, or
 * `makeLoader`/`makeAction` fails to type-check.
 */
export function makeLoaderOrActionFactory<DomainError extends Tagged = never>() {
  return function defineErrorHandlers<const Handlers>(
    config: { errorHandlers: Handlers },
    // Validation: a handler for a non-domain error, or one that doesn't return a
    // route error / failing `Effect`, makes this rest parameter required and forces
    // a compile error at the call.
    ..._validate: HandlersAreValid<Handlers, DomainError> extends true
      ? []
      : [
          eachHandlerMustBeForADeclaredDomainErrorAndReturnARouteErrorOrAnEffect: ValidHandlers<DomainError>,
        ]
  ) {
    const isUserError = (e: unknown): e is DomainError =>
      typeof e === "object" &&
      e !== null &&
      "_tag" in e &&
      (e as Tagged)._tag in (config.errorHandlers as object);

    // Uniform call signature for dispatch (the per-tag handler types are narrower).
    const userHandlers = config.errorHandlers as unknown as Record<
      string,
      ErrorHandler<DomainError>
    >;

    function makeLoaderOrAction<Args extends LoaderFunctionArgs | ActionFunctionArgs, A, E>(
      fn: (args: Args) => Effect.Effect<A, E>,
      // If the effect can still fail with something the library won't handle — a
      // service-specific error that isn't a declared domain error, a library route
      // error, or respondable — this rest parameter becomes required and the call
      // fails to type-check, forcing the loader/action to handle it.
      ..._handle: [Unhandled<E, DomainError>] extends [never]
        ? []
        : [
            theseErrorsAreNotDomainErrorsAndMustBeHandledInTheLoaderOrAction: Unhandled<
              E,
              DomainError
            >,
          ]
    ): (args: Args) => Promise<A | DirectRecover<E> | RecoverOf<Handlers, E>> {
      return (args: Args) =>
        // The internal channel is deliberately loose (`unknown` success); the outer
        // cast restores the precise resolved type (computed from `E` and the handler
        // map). Sound at runtime — the values produced are exactly those types.
        Effect.runPromise(
          fn(args).pipe(
            // Catch the whole error channel and dispatch. The refinement is `e is E`
            // (provably ⊆ E, and a *refinement* not a bare predicate — the predicate
            // overload crashes tsc over a generic `E`). A declared domain error with
            // no handler (and not respondable) falls through to the 500 default.
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
      makeLoader: makeLoaderOrAction,
      makeAction: makeLoaderOrAction,
    };
  };
}
