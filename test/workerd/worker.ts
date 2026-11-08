/**
 * A Worker for `test/workerd.test.ts`: the adapter, served by Effect's
 * `HttpRouter.toWebHandler`, as a Cloudflare Worker serves it. Vite bundles
 * it, and Miniflare runs it in workerd.
 */
import { Context, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import type { ServerBuild } from "react-router";

import { makeEffectRouteFactory } from "../../src/index.ts";
import { ReactRouter } from "../../src/server.ts";

/** The Worker's env: its bindings. */
class WorkerEnv extends Context.Service<WorkerEnv, { readonly GREETING: string }>()(
  "test/WorkerEnv",
) {}

/** The Worker's execution context. */
class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  { readonly waitUntil: (promise: Promise<unknown>) => void }
>()("test/WorkerExecutionContext") {}

/** A resource of one request, such as a database connection. */
class Connection extends Context.Service<Connection, { readonly isOpen: () => boolean }>()(
  "test/Connection",
) {}

/** What the isolate saw. `/stats` reports it. */
const stats: {
  opened: number;
  closed: number;
  background: number;
  readonly aborted: Array<string>;
} = { opened: 0, closed: 0, background: 0, aborted: [] };

const routeFactory = makeEffectRouteFactory()(() => ({}));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();

/** A body of `chunks`, one every `ms` milliseconds. */
const slowBody = (chunks: ReadonlyArray<() => string>, ms: number) =>
  new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk()));
        await sleep(ms);
      }
      controller.close();
    },
  });

/** A route module of the fixture build, as the build plugin collects its exports. */
type RouteModule = Record<string, unknown>;

const route = (id: string, module: RouteModule) => ({ id, path: id, parentId: "root", module });

const routes = {
  root: { id: "root", path: "", module: { default: () => null } },
  env: route("env", {
    loader: Effect.fn("envLoader")(function* () {
      const env = yield* WorkerEnv;
      return Response.json({ greeting: env.GREETING });
    }),
  }),
  form: route("form", {
    action: Effect.fn("formAction")(function* ({ request }: { readonly request: Request }) {
      const text = yield* Effect.promise(() => request.text());
      return Response.json({ length: text.length });
    }),
  }),
  connection: route("connection", {
    loader: Effect.fn("connectionLoader")(function* () {
      const connection = yield* Connection;
      const state = () => (connection.isOpen() ? "open " : "closed ");
      return new Response(slowBody([state, state, state], 20));
    }),
  }),
  background: route("background", {
    loader: Effect.fn("backgroundLoader")(function* () {
      const context = yield* WorkerExecutionContext;
      const work = Effect.sleep(20).pipe(
        Effect.andThen(
          Effect.sync(() => {
            stats.background++;
          }),
        ),
      );
      // `waitUntil` takes a Promise that outlives the request, which the test
      // checks, so the work runs detached from the loader's fiber.
      // @effect-diagnostics-next-line runEffectInsideEffect:off
      context.waitUntil(Effect.runPromise(work));
      return Response.json({ scheduled: true });
    }),
  }),
  stream: route("stream", {
    loader: ({ request }: { readonly request: Request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      request.signal.addEventListener("abort", () => stats.aborted.push(id), { once: true });
      const letter = (text: string) => () => text;
      return new Response(slowBody(["a", "b", "c", "d", "e", "f"].map(letter), 100));
    },
  }),
  stats: route("stats", { loader: () => Response.json(stats) }),
};

/** An entry route of the assets manifest. */
const entryRoute = (id: string, path: string, parentId?: string) => ({
  id,
  path,
  parentId,
  module: `/${id}.js`,
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

const build: ServerBuild = {
  entry: { module: { default: () => new Response("document", { status: 200 }) } },
  // The build plugin creates this manifest from route module namespaces. React
  // Router's static route module type admits neither Effect route functions nor
  // resource modules without a default export, which built apps contain.
  routes: routes as unknown as ServerBuild["routes"],
  assets: {
    entry: { imports: [], module: "/entry.client.js" },
    routes: Object.fromEntries(
      Object.values(routes).map((r) => [
        r.id,
        entryRoute(r.id, r.path, "parentId" in r ? r.parentId : undefined),
      ]),
    ),
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

const ConnectionLive = Layer.effect(Connection)(
  Effect.gen(function* () {
    let open = true;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        stats.opened++;
      }),
      () =>
        Effect.sync(() => {
          open = false;
          stats.closed++;
        }),
    );
    return { isOpen: () => open };
  }),
);

/** Builds the connection in the request's scope. */
const Connections = HttpRouter.middleware((app) =>
  Effect.flatMap(Layer.build(ConnectionLive), (context) => Effect.provideContext(app, context)),
).layer;

const App = ReactRouter.routes.pipe(
  Layer.provide(Connections),
  Layer.provide(
    ReactRouter.layer({
      // A build function in production mode loads when the layer builds, at module scope.
      build: () => Promise.resolve(build),
      factory: routeFactory,
      mode: "production",
    }),
  ),
);

// Built once, at module scope.
const app = HttpRouter.toWebHandler(App, { disableLogger: true });

export default {
  fetch: (
    request: Request,
    env: WorkerEnv["Service"],
    ctx: WorkerExecutionContext["Service"],
  ): Promise<Response> =>
    app.handler(
      request,
      Context.make(WorkerEnv, env).pipe(Context.add(WorkerExecutionContext, ctx)),
    ),
};
