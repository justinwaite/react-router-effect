/**
 * How the benchmarks serve the example's production build.
 *
 * - The adapter: the example's `App`, on Effect's HTTP server, without the
 *   example's compression middleware.
 * - The baselines: React Router's own request handler, without Effect's HTTP
 *   server. Their route functions run through the same route factory, which
 *   runs the Effects with the runtime and the request's services, maps their
 *   errors, and attaches the action metadata, as an app without the adapter
 *   does with `makeLoader` wrappers. Both sides run the same route code, and
 *   the difference is the server and the adapter.
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Context } from "effect";
import {
  createRequestHandler,
  type MiddlewareFunction,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import type { RouteHandlers } from "react-router-effect";

import type * as ServerModule from "../server/app.ts";

/** The example's directory. */
export const root = fileURLToPath(new URL("..", import.meta.url));

/** The server build of `react-router build`, which bundles `server/app.ts`. */
export const loadServer = (): Promise<typeof ServerModule> =>
  import(pathToFileURL(join(root, "build/server/index.js")).href);

/** Runs a build's loaders, actions and middleware through the factory, as the adapter does. */
export const wrapBuild = (build: ServerBuild, handlers: RouteHandlers): ServerBuild => ({
  ...build,
  routes: Object.fromEntries(
    Object.entries(build.routes).map(([id, route]) => [
      id,
      route === undefined
        ? undefined
        : {
            ...route,
            module: {
              ...route.module,
              loader: route.module.loader && handlers.loader(route.module.loader),
              action: route.module.action && handlers.action(route.module.action),
              middleware: route.module.middleware?.map(
                (fn) => handlers.middleware(fn) as MiddlewareFunction<Response>,
              ),
            },
          },
    ]),
  ),
});

/** The baseline's router context: the request's services, as `RequestServices` provides them. */
export const baselineContext = (server: typeof ServerModule, requestId: string | undefined) => {
  const context = new RouterContextProvider();
  context.set(
    server.routeFactory.handlers.requestContext,
    Context.make(server.RequestInfo, {
      id: requestId ?? crypto.randomUUID(),
      startedAt: Date.now(),
    }),
  );
  return context;
};

/** The baseline's build: the example's build with its route functions run through the factory. */
export const baselineBuild = async (server: typeof ServerModule) =>
  wrapBuild(await server.loadBuild(), server.routeFactory.handlers);

/** React Router's request handler for the baseline build, called without an HTTP server. */
export const baselineHandler = async (server: typeof ServerModule) => {
  const handler = createRequestHandler(await baselineBuild(server), "production");
  return (request: Request) =>
    handler(request, baselineContext(server, request.headers.get("x-request-id") ?? undefined));
};

/** What the floor servers answer every request with: as long as a `.data` response of the benchmark routes. */
export const floorBody = "x".repeat(1024);

/** A request both benchmarks make. */
export interface BenchCase {
  readonly name: string;
  readonly path: string;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** The requests both benchmarks make. */
export const cases = (origin: string): ReadonlyArray<BenchCase> => {
  const post = (path: string) => ({
    path,
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: "title=benchmark",
  });
  return [
    { name: "document, promise loader", path: "/bench/promise" },
    { name: "document, Effect loader", path: "/bench/effect" },
    { name: ".data, promise loader", path: "/bench/promise.data" },
    { name: ".data, Effect loader", path: "/bench/effect.data" },
    { name: "action, promise", ...post("/bench/promise.data") },
    { name: "action, Effect", ...post("/bench/effect.data") },
  ];
};
