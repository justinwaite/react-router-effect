/**
 * The app: React Router, its client build and the app's own routes, as
 * Effect HTTP layers. The server build of `react-router build` bundles this
 * module, and in development `server.js` loads it through Vite for each
 * request, so an edit to it, the route factory or a route applies on the
 * next request.
 */
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ReactRouter, ReactRouterAssets } from "react-router-effect/server";

import { routeFactory } from "../app/lib/route-factory.server";
import { RequestInfo } from "../app/lib/services.server";

/** Every request to React Router starts with its `RequestInfo`. */
const RequestServices = HttpRouter.middleware((app) =>
  Effect.provideServiceEffect(
    app,
    RequestInfo,
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.succeed({
        id: request.headers["x-request-id"] ?? crypto.randomUUID(),
        startedAt: Date.now(),
      }),
    ),
  ),
).layer;

/** The app's own routes, outside React Router. */
const Api = HttpRouter.add("GET", "/health", HttpServerResponse.text("ok"));

export const App = Layer.mergeAll(
  ReactRouter.routes.pipe(Layer.provide(RequestServices)),
  // Serves `build/client` in production. Vite serves the client in development.
  ReactRouterAssets.layer.pipe(Layer.provide(HttpRouter.disableLogger)),
  Api,
).pipe(
  Layer.provide(
    ReactRouter.layer({
      build: () => import("virtual:react-router/server-build"),
      factory: routeFactory,
    }),
  ),
);

export { routeFactory };
export { RequestInfo };

/** The React Router build, for the benchmark's baseline server. */
export const loadBuild = () => import("virtual:react-router/server-build");
