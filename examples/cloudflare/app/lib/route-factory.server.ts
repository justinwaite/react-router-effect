/**
 * The route factory: the runtime, request context and error model every
 * Effect loader, action and middleware runs with.
 */
import { env } from "cloudflare:workers";
import { Data, Layer, ManagedRuntime } from "effect";
import { createContext } from "react-router";
import { makeEffectRouteFactory, type RequestContextKey } from "react-router-effect";

import { type Connection, Format, WorkerEnv, type WorkerExecutionContext } from "./services.server";

/** A domain error: the factory throws it to the error boundary as a 404. */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}

/**
 * The app-wide services. The runtime builds them on the first request, and
 * they last as long as the isolate. `env` comes from `cloudflare:workers`, so
 * the runtime needs no request to build.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(Format.layer, Layer.succeed(WorkerEnv)(env)),
);

/**
 * The request's services: the execution context, which `workers/app.ts`
 * passes with the request, and the connection of `server/app.ts`.
 */
export const requestContext: RequestContextKey<WorkerExecutionContext | Connection> =
  createContext();

export const routeFactory = makeEffectRouteFactory<NotFound>()((Respond) => ({
  runtime,
  requestContext,
  errorHandlers: {
    NotFound: (error) => Respond.throw({ message: `${error.what} was not found` }, 404),
  },
}));

export const { Respond } = routeFactory;
