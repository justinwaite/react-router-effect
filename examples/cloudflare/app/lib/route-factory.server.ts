import { Data, ManagedRuntime } from "effect";
import { createContext } from "react-router";
import { makeEffectRouteFactory, type RequestContextKey } from "react-router-effect";
import type { WorkerContext } from "react-router-effect/worker";

import { type Connection, Format } from "./services.server";

/** A domain error: the factory throws it to the error boundary as a 404. */
export class NotFound extends Data.TaggedError("NotFound")<{ readonly what: string }> {}

/** App-wide services. Built on the first request, it lasts as long as the isolate. */
export const runtime = ManagedRuntime.make(Format.layer);

/** The services of one request: the Worker, and the request layer's connection. */
export const requestContext: RequestContextKey<WorkerContext | Connection> = createContext();

export const routeFactory = makeEffectRouteFactory<NotFound>()((Respond) => ({
  runtime,
  requestContext,
  errorHandlers: {
    NotFound: (error) => Respond.throw({ message: `${error.what} was not found` }, 404),
  },
}));

export const { Respond } = routeFactory;

declare module "react-router-effect" {
  interface Register {
    /** Types `WorkerContext`'s env with the env that `wrangler types` generates. */
    workerEnv: Env;
  }
}
