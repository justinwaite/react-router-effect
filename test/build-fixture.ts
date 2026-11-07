/**
 * A server build of route modules, for the adapter tests. The build plugin
 * creates the same shape from route module namespaces.
 */
import type { ServerBuild } from "react-router";

/** A route module of a fixture build, as the build plugin collects its exports. */
export type RouteModule = Record<string, unknown>;

/** A route of a fixture build. */
export interface FixtureRoute {
  readonly id: string;
  readonly path: string;
  readonly parentId?: string | undefined;
  readonly module: RouteModule;
}

/** A child route of the root. */
export const route = (id: string, path: string, module: RouteModule): FixtureRoute => ({
  id,
  path,
  parentId: "root",
  module,
});

/** An entry route of the assets manifest. */
const entryRoute = (r: FixtureRoute) => ({
  id: r.id,
  path: r.path,
  parentId: r.parentId,
  module: `/${r.id}.js`,
  hasAction: true,
  hasLoader: true,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  hasErrorBoundary: false,
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
});

/**
 * A build of `routes`, under a root route with `rootModule`. Its document
 * entry answers "document".
 */
export const makeBuild = (
  routes: ReadonlyArray<FixtureRoute>,
  rootModule: RouteModule = {},
): ServerBuild => {
  const all: ReadonlyArray<FixtureRoute> = [
    { id: "root", path: "", module: { default: () => null, ...rootModule } },
    ...routes,
  ];
  return {
    entry: { module: { default: () => new Response("document", { status: 200 }) } },
    // React Router's static route module type admits neither Effect route
    // functions nor resource modules without a default export, which built
    // apps contain.
    routes: Object.fromEntries(all.map((r) => [r.id, r])) as unknown as ServerBuild["routes"],
    assets: {
      entry: { imports: [], module: "/entry.client.js" },
      routes: Object.fromEntries(all.map((r) => [r.id, entryRoute(r)])),
      url: "/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: "build/client",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
  };
};
