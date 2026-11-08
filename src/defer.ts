import { Cause, Context, Effect, Exit, Option, Scope } from "effect";
import {
  data,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
  type ErrorResponse,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
} from "react-router";

import { ReturnableDataError, ThrowableDataError, type AnyRouteError } from "./errors.ts";
import type { FailureResponse, IsAny, NameError } from "./factory.ts";

// ---------------------------------------------------------------------------
// The scope of deferred work.
// ---------------------------------------------------------------------------

/**
 * The scope that deferred work forks into. The route runner sets it for each
 * loader or action run, and closes it when the request aborts or the route
 * Effect fails. Outside a route runner it is unset, and deferred work runs
 * detached.
 */
export const DeferScope = Context.Reference<Scope.Scope | undefined>(
  "react-router-effect/DeferScope",
  { defaultValue: () => undefined },
);

/**
 * Gives a route Effect a scope for its deferred work. The scope closes, and
 * interrupts the deferred fibers, when `signal` aborts or the Effect fails: a
 * failed loader sends no data, so no `<Await>` waits for the work.
 */
export const withDeferScope = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const scope = Scope.makeUnsafe("parallel");
    const close = <X, Y>(exit: Exit.Exit<X, Y>) => Scope.close(scope, exit);
    signal.addEventListener("abort", () => Effect.runFork(close(Exit.interrupt())), {
      once: true,
    });
    return effect.pipe(
      Effect.provideService(DeferScope, scope),
      Effect.onError((cause) => close(Exit.failCause(cause))),
    );
  });

// ---------------------------------------------------------------------------
// The deferred promise.
// ---------------------------------------------------------------------------

/**
 * The compile-time diagnostic of the factory's `defer`. A deferred Effect
 * runs after the response started, so a failure cannot change the response.
 * The Effect must handle every error it can fail with before it is deferred,
 * except the `Handled` ones, which the error handlers turn into a value or an
 * `ErrorResponse`. Resolves to `unknown` (a no-op intersection) when every
 * error is handled.
 *
 * @stability unstable
 */
export type DeferDiagnose<E, Handled> =
  IsAny<E> extends true
    ? unknown
    : [Exclude<E, Handled>] extends [never]
      ? unknown
      : {
          "react-router-effect": "A deferred effect runs after the response started, so it can fail only with the factory's domain errors, Respond.early and Respond.throw. Handle the other errors before defer: recover them into data (e.g. Effect.catchTag), or make them defects with Effect.orDie.";
          unhandledErrors: NameError<Exclude<E, Handled>>;
        };

/**
 * The promise that the factory's `defer` gives: a `Promise` of the deferred Effect's
 * success, which React Router streams to `<Await>`. The work started when the
 * Effect was deferred.
 *
 * It is a type of its own so that an Effect that succeeds with it states
 * that the promise is not awaited on purpose. The language service's
 * `promiseInEffectSuccess` rule reports only the global `Promise` type.
 *
 * @stability unstable
 */
export interface DeferredPromise<A> extends Promise<A> {}

/**
 * The message every deferred rejection has. The server logs the cause.
 *
 * @stability unstable
 */
export const deferredFailureMessage = "Deferred route data failed";

/**
 * The rejection the browser gets for a defect or an interrupt: a constant
 * message and no stack, in every server mode. React Router removes server
 * details only in production.
 */
const deferredFailure = (): Error => {
  const error = new Error(deferredFailureMessage);
  error.stack = undefined;
  return error;
};

/**
 * Forks `self` into the run's defer scope and gives a promise of its result.
 * A failure rejects the promise with its `ErrorResponse`, which React Router
 * streams to `useAsyncError`. A defect or interrupt rejects it with
 * `deferredFailure`, and the server logs a defect's full cause.
 */
export const forkDeferred = <A, R>(
  self: Effect.Effect<A, ErrorResponse, R>,
): Effect.Effect<DeferredPromise<A>, never, R> =>
  Effect.gen(function* () {
    const scope = yield* DeferScope;
    const work = self.pipe(
      Effect.tapCause((cause) =>
        Cause.hasDies(cause) ? Effect.logError(deferredFailureMessage, cause) : Effect.void,
      ),
    );
    const fiber = yield* scope === undefined ? Effect.forkDetach(work) : Effect.forkIn(work, scope);
    const promise: DeferredPromise<A> = new Promise<A>((resolve, reject) => {
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) return resolve(exit.value);
        reject(
          Cause.hasDies(exit.cause)
            ? deferredFailure()
            : Option.getOrElse(Cause.findErrorOption(exit.cause), deferredFailure),
        );
      });
    });
    // Marks the rejection handled, so a promise that React Router never reads,
    // because the loader failed after it deferred, is not an unhandled rejection.
    // `<Await>` still reads the rejection from `promise` itself.
    promise.catch(() => undefined);
    return promise;
  });

// ---------------------------------------------------------------------------
// Route errors in deferred work.
// ---------------------------------------------------------------------------

/** A thrown `data(...)` as an `ErrorResponse`, with React Router's defaults. */
const toErrorResponse = (thrown: DataWithResponseInit<unknown>): ErrorResponse =>
  new ErrorResponseImpl(
    thrown.init?.status ?? 500,
    thrown.init?.statusText ?? "Internal Server Error",
    thrown.data,
  );

/**
 * A library route error raised in deferred work: `Respond.early` resolves the
 * promise with its value, and `Respond.throw` rejects it with an
 * `ErrorResponse`. A redirect cannot happen after the response started, so it
 * is a defect.
 */
export const deferRouteError = (e: AnyRouteError): Effect.Effect<unknown, ErrorResponse> => {
  if (e instanceof ReturnableDataError) return Effect.succeed(e.data);
  if (e instanceof ThrowableDataError) return Effect.fail(toErrorResponse(data(e.data, e.init)));
  return Effect.die(e);
};

/**
 * A handler's `Effect.fail(response)` in deferred work, as an `ErrorResponse`:
 * a `data(...)` as React Router converts a thrown one, and a `Response` with
 * its body read as React Router reads it, JSON or text. A redirect is a defect.
 */
export const deferFailureResponse = (
  failure: FailureResponse,
): Effect.Effect<never, ErrorResponse> => {
  if (!(failure instanceof Response)) return Effect.fail(toErrorResponse(failure));
  if (failure.status >= 300 && failure.status < 400) return Effect.die(failure);
  const isJson = /\bapplication\/json\b/.test(failure.headers.get("Content-Type") ?? "");
  return Effect.promise(() =>
    isJson && failure.body !== null ? failure.json() : failure.text(),
  ).pipe(
    Effect.flatMap((body) =>
      Effect.fail(new ErrorResponseImpl(failure.status, failure.statusText, body)),
    ),
  );
};
