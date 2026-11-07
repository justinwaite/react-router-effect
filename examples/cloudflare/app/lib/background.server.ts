import { Effect, type Scope } from "effect";

import { WorkerExecutionContext } from "./services.server";

/**
 * Runs an Effect after the response, with the `waitUntil` of the request's
 * execution context, and keeps the Worker alive until it ends. The Effect
 * gets the services of the route that calls this, but not the request's
 * scope: that scope closes at the end of the response body. So the Effect
 * runs in a scope of its own, and opens its own resources. A failure goes to
 * the app's loggers.
 */
export const runInBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, WorkerExecutionContext | Exclude<R, Scope.Scope>> =>
  Effect.gen(function* () {
    const executionContext = yield* WorkerExecutionContext;
    const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
    executionContext.waitUntil(
      Effect.runPromiseWith(context)(
        effect.pipe(
          Effect.scoped,
          Effect.catchCause((cause) => Effect.logError("A background Effect failed", cause)),
        ),
      ),
    );
  });
