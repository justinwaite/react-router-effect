import { type Context, Effect, type ManagedRuntime } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import {
  data,
  redirect,
  type ActionFunctionArgs,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
  type LoaderFunctionArgs,
  type RouterContext,
} from "react-router";

import {
  isRouteError,
  Respond as baseRespond,
  ReturnableDataError,
  ThrowableDataError,
  type AnyRouteError,
} from "./errors.ts";

/** The library's base `Respond` helpers (`early` / `throw` / `redirect`). */
type BaseRespond = typeof baseRespond;

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

/** What a handler may return: a library route error or an `Effect` failing with a response. */
type HandlerReturn = AnyRouteError | Effect.Effect<unknown, FailureResponse>;

/**
 * The inferred map of handler RETURN types, keyed by domain-error tag. Making the
 * factory generic over *this* (rather than the whole handler map) is what lets
 * `errorHandlers` contextually type each handler's `error` param from its key —
 * no annotation needed — while still capturing precise return types for recovery.
 */
type HandlerReturns<DomainError extends Tagged> = Partial<
  Record<DomainError["_tag"], HandlerReturn>
>;

/**
 * The `errorHandlers` field shape for a given return map: one entry per registered
 * tag, whose `error` is the matching domain error (so it autocompletes and types
 * itself) and whose return is the precise, inferred `Returns[Tag]`.
 */
type ErrorHandlers<DomainError extends Tagged, Returns> = {
  [Tag in keyof Returns]: (error: Extract<DomainError, { readonly _tag: Tag }>) => Returns[Tag];
};

/**
 * What the registered handlers recover into loader/action data — from each
 * handler's return type, but only for handlers whose error can actually occur in
 * `E`:
 *  - a remapped `ReturnableDataError<B>` recovers as `DataWithResponseInit<B>`;
 *  - an `Effect.succeed(value)` recovers as `value`;
 *  - throwables, redirects and `Effect.fail(...)` contribute nothing.
 */
type RecoverOf<DomainError extends Tagged, Returns, E> = {
  [Tag in keyof Returns]: [Extract<E, Extract<DomainError, { readonly _tag: Tag }>>] extends [never]
    ? never
    :
        | (Returns[Tag] extends ReturnableDataError<infer B> ? DataWithResponseInit<B> : never)
        | (Returns[Tag] extends Effect.Effect<infer SuccessValue, any, any> ? SuccessValue : never);
}[keyof Returns];

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

// ---------------------------------------------------------------------------
// The call-site diagnostic.
// ---------------------------------------------------------------------------

/**
 * A readable compile-time diagnostic. It's intersected onto the *effect return type*
 * of `fn` — so the effect's `A`/`E`/`R` still infer directly (naked), while a mismatch
 * reports this message, and the offending types, *at the `makeLoader`/`makeAction`
 * call* instead of the opaque "Expected 2 arguments". Resolves to `unknown` (a no-op
 * intersection) when the effect is fully handled and all its requirements are provided:
 *
 *  - **Unhandled error** — the effect can fail with something that isn't a declared
 *    domain error, a library route error, or respondable; `unhandledErrors` names them.
 *  - **Missing requirement** — the effect requires a service that neither the
 *    `runtime` nor the `requestContext` provides; `missingRequirements` names them.
 *
 * The message lives in an *inline* object literal (no named alias) so tsc/tsgo print
 * its text verbatim rather than collapsing it to an alias name.
 */
/**
 * Names the unhandled errors for the diagnostic: a tagged error becomes its `_tag`
 * (the string you'd pass to `Effect.catchTag`), anything untagged stays as its type.
 */
type NameError<U> = U extends { readonly _tag: infer Tag extends string } ? Tag : U;

type Diagnose<E, R, DomainError, Provided> = [Unhandled<E, DomainError>] extends [never]
  ? [Exclude<R, Provided>] extends [never]
    ? unknown
    : {
        "react-router-effect": "This loader/action requires a service the factory does not provide. Add it to your runtime or requestContext, or handle it in the effect.";
        missingRequirements: Exclude<R, Provided>;
      }
  : {
      "react-router-effect": "This loader/action can fail with an error the library does not handle. Catch it in the effect (e.g. Effect.catchTag), make it Respondable, or add it to your DomainError union.";
      unhandledErrors: NameError<Unhandled<E, DomainError>>;
    };

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
// Per-request context.
// ---------------------------------------------------------------------------

/**
 * A React Router context key holding a per-request effect `Context.Context`. Set
 * it in middleware and pass it to the factory's `requestContext` — the runner
 * reads it on every request and provides its services to the loader/action.
 *
 * It's just a `RouterContext`; create one with React Router's `createContext`:
 *
 * ```ts
 * import { createContext } from "react-router";
 * import { Context } from "effect";
 * import type { RequestContextKey } from "react-router-effect";
 *
 * class RequestContext extends Context.Service<RequestContext, {
 *   readonly userId: string;
 * }>()("app/RequestContext") {}
 *
 * export const requestContext: RequestContextKey<RequestContext> = createContext();
 *
 * // middleware:
 * export const middleware: Route.MiddlewareFunction[] = [
 *   ({ context, request }, next) => {
 *     context.set(requestContext, Context.make(RequestContext, { userId: readUser(request) }));
 *     return next();
 *   },
 * ];
 * ```
 */
export type RequestContextKey<ReqServices> = RouterContext<Context.Context<ReqServices>>;

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/**
 * Build `makeLoader` / `makeAction` for an application, wired to its domain errors.
 *
 * Declare the app's **domain errors** as the type argument, then register an
 * *optional* handler per domain error in `errorHandlers`. The handler keys
 * autocomplete to your domain-error tags and each `error` parameter is typed from
 * its key — no annotation needed. It's curried so you can pin the domain errors
 * while the handler return types are still inferred:
 *
 * ```ts
 * type DomainErrors = MyDomainError | DbError | NotAuthorizedError;
 *
 * export const { makeLoader, makeAction, Respond } =
 *   makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
 *     errorHandlers: {
 *       // `error` is typed as MyDomainError automatically. throw → error boundary
 *       MyDomainError: (error) => Respond.throw({ message: error.message }, 400),
 *       // DbError has no handler → falls through to the 500 default.
 *     },
 *   }));
 * ```
 *
 * The inner config is a **builder** — it receives the library's `Respond` helpers so
 * your handlers can recover/throw with them, and returns the config. `Respond` is
 * also returned from the factory (extended with any `respond` helpers you add), so
 * your app imports a *single* `Respond` — no auto-import ambiguity with a library one.
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
 *
 * Pass a `runtime` (a `ManagedRuntime`, e.g. from `ManagedRuntime.make(AppLayer)`)
 * to provide your app's services once. Loader/action effects may then require those
 * services directly — no per-call `Effect.provide`:
 *
 * ```ts
 * const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()(() => ({
 *   runtime: getAppRuntime(), // provides Database, MyService, ...
 *   errorHandlers: { ... },
 * }));
 *
 * // `MyService` is satisfied by the runtime, not provided here:
 * const loader = makeLoader((args: Route.LoaderArgs) =>
 *   Effect.gen(function* () {
 *     const svc = yield* MyService;
 *     return { data: yield* svc.load(args) };
 *   }),
 * );
 * ```
 */
export function makeLoaderOrActionFactory<DomainError extends Tagged = never>() {
  return function defineErrorHandlers<
    const Returns extends HandlerReturns<DomainError> = {},
    RServices = never,
    ReqServices = never,
    const ExtraRespond extends Record<string, (...args: never[]) => unknown> = {},
  >(
    /**
     * Builds the factory config. It receives the library's base `Respond` helpers
     * (`early` / `throw` / `redirect`) so your `errorHandlers` can recover/throw
     * with them, and returns the config object.
     */
    builder: (respond: BaseRespond) => {
      /**
       * An optional handler per declared domain error, keyed by its tag. The keys
       * autocomplete to your domain-error tags and each handler's `error` parameter
       * is typed automatically — no annotation needed. A handler *remaps* the error
       * by returning a library route error (the builder's `Respond.early` / `throw`
       * / `redirect`) or an `Effect` (`Effect.succeed`/`fail`). Omit to register none.
       */
      errorHandlers?: ErrorHandlers<DomainError, Returns>;
      /**
       * The app runtime that provides services to loader/action effects. When
       * set, effects may require its services (`RServices`, inferred from here)
       * without providing layers, and runs go through `runtime.runPromise`. When
       * omitted, `RServices` is `never` and effects must require nothing.
       */
      runtime?: ManagedRuntime.ManagedRuntime<RServices, any>;
      /**
       * A React Router context key (a {@link RequestContextKey}) holding a
       * per-request effect `Context.Context`. Middleware sets it for each request;
       * the runner reads `args.context.get(requestContext)` and provides those
       * services to the effect. Loader/action effects may then require
       * `ReqServices` (inferred from here) in addition to the runtime's services.
       */
      requestContext?: RequestContextKey<ReqServices>;
      /**
       * App-specific `Respond` helpers — merged onto the base `Respond` that the
       * factory returns, so your app imports one `Respond`. Typically opinionated
       * error constructors; annotate their parameters, e.g.
       * `{ formError: (reply: string) => new FormError({ reply }) }`. The base
       * helpers (`early` / `throw` / `redirect`) always win the merge.
       */
      respond?: ExtraRespond;
    },
  ) {
    const config = builder(baseRespond);
    const runtime = config.runtime;
    const requestContextKey = config.requestContext;
    // The single `Respond` an app uses: base helpers plus any app-specific ones.
    // Base wins the merge so core helpers can't be shadowed.
    const Respond = { ...config.respond, ...baseRespond } as BaseRespond & ExtraRespond;

    // Uniform call signature for dispatch (the per-tag handler types are narrower).
    // Defaults to an empty map when `errorHandlers` is omitted.
    const userHandlers = (config.errorHandlers ?? {}) as unknown as Record<
      string,
      ErrorHandler<DomainError>
    >;

    const isUserError = (e: unknown): e is DomainError =>
      typeof e === "object" && e !== null && "_tag" in e && (e as Tagged)._tag in userHandlers;

    function makeLoaderOrAction<Args extends LoaderFunctionArgs | ActionFunctionArgs, A, E, R>(
      // `A`/`E`/`R` infer directly from the effect (naked, so inference stays robust).
      // The diagnostic is intersected onto the effect's return type: when the effect
      // requires a service the factory doesn't provide (`R` ⊄ runtime+requestContext),
      // or can fail with something the library won't handle, `Diagnose` becomes a
      // message object the effect isn't assignable to — so this argument fails to
      // type-check with a readable explanation, and the offending types, right here.
      fn: (
        args: Args,
      ) => Effect.Effect<A, E, R> & Diagnose<E, R, DomainError, RServices | ReqServices>,
    ): (args: Args) => Promise<A | DirectRecover<E> | RecoverOf<DomainError, Returns, E>> {
      // The diagnostic is irrelevant inside the body (it's `unknown` for any valid
      // call); treat `fn` as the plain effect-returning function it is.
      const run = fn as unknown as (
        args: Args,
      ) => Effect.Effect<unknown, E, RServices | ReqServices>;
      return (args: Args) => {
        // The internal channel is deliberately loose (`unknown` success); the outer
        // cast restores the precise resolved type (computed from `E` and the handler
        // map). Sound at runtime — the values produced are exactly those types.
        const program = run(args).pipe(
          // Catch the whole error channel and dispatch. The refinement is `e is E`
          // (provably ⊆ E, and a *refinement* not a bare predicate — the predicate
          // overload crashes tsc over a generic `E`). A declared domain error with no
          // handler (and not respondable) falls through to the 500 default.
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
        );
        // Provide the per-request context (set by middleware) so `ReqServices` are
        // satisfied, leaving only the runtime's `RServices` in the requirements.
        // The cast is sound: `provideContext` removes `ReqServices`, and when no
        // `requestContext` is configured `ReqServices` is `never` (nothing removed).
        const provided = (
          requestContextKey
            ? Effect.provideContext(program, args.context.get(requestContextKey))
            : program
        ) as Effect.Effect<unknown, FailureResponse, RServices>;
        // Run against the configured runtime so its services satisfy the effect's
        // `R`; with no runtime, the effect requires nothing and runs standalone.
        const result = runtime
          ? runtime.runPromise(provided)
          : Effect.runPromise(provided as Effect.Effect<unknown, FailureResponse>);
        return result as Promise<A | DirectRecover<E> | RecoverOf<DomainError, Returns, E>>;
      };
    }

    return {
      makeLoader: makeLoaderOrAction,
      makeAction: makeLoaderOrAction,
      Respond,
    };
  };
}
