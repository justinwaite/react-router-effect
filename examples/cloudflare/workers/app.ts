/**
 * The Worker. `ReactRouterWorker.make` is its fetch handler: it runs every
 * Effect loader, action and middleware with the route factory, and builds the
 * request layer for each request.
 */
import { RouterContextProvider } from "react-router";
import { ReactRouterWorker } from "react-router-effect/worker";

import { cloudflareContext } from "../app/lib/cloudflare-context";
import { routeFactory } from "../app/lib/route-factory.server";
import { ConnectionLive } from "../app/lib/services.server";

export default ReactRouterWorker.make({
  build: () => import("virtual:react-router/server-build"),
  factory: routeFactory,
  mode: import.meta.env.MODE,
  // A connection for each request, closed when its response ends.
  requestLayer: () => ConnectionLive,
  // Promise route functions read the Worker from a React Router context key.
  getLoadContext: (_request, { env, ctx }) => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return context;
  },
}) satisfies ExportedHandler<Env>;
