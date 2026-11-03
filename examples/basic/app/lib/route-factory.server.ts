/**
 * The route factory: the runtime, request context and error model every
 * Effect loader, action and middleware runs with. The server adapter runs
 * route functions that return an Effect through it.
 */
import { Context, ManagedRuntime } from "effect";
import { createContext } from "react-router";
import { makeEffectRouteFactory, type RequestContextKey } from "react-router-effect";

import { type InvalidTodo, RequestInfo, Todos, type Visitor } from "./services.server";

/** The app's long-lived services. */
export const runtime = ManagedRuntime.make(Todos.layer);

/**
 * The request's services. The adapter's `requestContext` adds `RequestInfo`,
 * and the root middleware provides `Visitor` around `next()`.
 */
export const requestContext: RequestContextKey<RequestInfo | Visitor> = createContext();

export const routeFactory = makeEffectRouteFactory<InvalidTodo>()((Respond) => ({
  runtime,
  requestContext,
  errorHandlers: {
    // A form error goes back to the form as data, with a 422.
    InvalidTodo: (error) => Respond.early({ error: error.message }, 422),
  },
  // Every action's data includes the request id under `__meta`.
  actionMeta: ({ context }) => ({
    requestId: Context.get(context.get(requestContext), RequestInfo).id,
  }),
}));

export const { Respond } = routeFactory;

// What the factory adds to route data, for `useLoaderData`, `useFetcher` and
// `Route.ComponentProps`. `route-effects.check.ts` fails when this disagrees
// with the factory.
declare module "react-router-effect" {
  interface Register {
    recover: { InvalidTodo: { error: string } };
    actionMeta: { requestId: string };
  }
}
