/**
 * The app: React Router as Effect HTTP layers. It is the same kind of `App`
 * that the Node example serves. Only `workers/app.ts`, which serves it, is
 * specific to Cloudflare. Cloudflare serves the client build from the
 * Worker's static assets, so the app has no `ReactRouterAssets.layer`.
 */
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RouterContextProvider } from "react-router";
import { ReactRouter } from "react-router-effect/server";

import { workerEnvContext } from "../app/lib/env-context";
import { routeFactory } from "../app/lib/route-factory.server";
import { ConnectionLive } from "../app/lib/services.server";

/**
 * Opens a connection for every request to React Router, in the request's
 * scope. Effect closes that scope when the response body ends, also for a
 * body that streams a promise.
 */
const Connections = HttpRouter.middleware((app) =>
  Effect.flatMap(Layer.build(ConnectionLive), (context) => Effect.provideContext(app, context)),
).layer;

export const App = ReactRouter.routes.pipe(
  Layer.provide(Connections),
  Layer.provide(
    ReactRouter.layer({
      build: () => import("virtual:react-router/server-build"),
      factory: routeFactory,
      mode: import.meta.env.MODE,
      // Promise route functions read the Worker's env from a React Router context key.
      loadContext: () =>
        Effect.sync(() => {
          const context = new RouterContextProvider();
          context.set(workerEnvContext, env);
          return context;
        }),
    }),
  ),
);
