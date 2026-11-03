/**
 * React Router as an Effect HTTP app. The server build of `react-router build`
 * bundles this module, and in development Vite loads it.
 */
import { Context } from "effect";
import { ReactRouterHttp } from "react-router-effect/server";

import { routeFactory } from "../app/lib/route-factory.server";
import { RequestInfo } from "../app/lib/services.server";

export const reactRouterApp = ReactRouterHttp.make({
  build: () => import("virtual:react-router/server-build"),
  factory: routeFactory,
  // Serves `build/client` in production. Vite serves the client in development.
  clientAssets: true,
  // Every request starts with its `RequestInfo`.
  requestContext: (request) =>
    Context.make(RequestInfo, {
      id: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      startedAt: Date.now(),
    }),
});

export { routeFactory };
export { RequestInfo };

/** The React Router build, for the benchmark's baseline server. */
export const loadBuild = () => import("virtual:react-router/server-build");
