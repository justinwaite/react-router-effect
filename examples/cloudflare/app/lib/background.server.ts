import { waitUntil } from "cloudflare:workers";
import { Effect, type Scope } from "effect";

/**
 * Runs an Effect after the response, with Cloudflare's `waitUntil`, and keeps
 * the Worker alive until it ends. The Effect gets the services of the route
 * that calls this, but not the request's scope: that scope closes when the
 * response body ends. So the Effect runs in a scope of its own, and opens its
 * own resources. A failure goes to the app's loggers.
 */
export const runInBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Exclude<R, Scope.Scope>> =>
  Effect.flatMap(Effect.context<Exclude<R, Scope.Scope>>(), (context) =>
    Effect.sync(() => {
      waitUntil(
        Effect.runPromiseWith(context)(
          effect.pipe(
            Effect.scoped,
            Effect.catchCause((cause) => Effect.logError("A background Effect failed", cause)),
          ),
        ),
      );
    }),
  );
