/**
 * The adapter on Effect's Web handler, `HttpRouter.toWebHandler`, which serves
 * the app on Cloudflare Workers and on other runtimes with Web requests and
 * responses. The same `App` runs on Effect's Node server in the other tests.
 */
import { Context, Effect, Layer, Tracer } from "effect";
import { Headers, HttpRouter, HttpServerRequest } from "effect/http";
import type { ServerBuild } from "react-router";
import { afterAll, describe, expect, it, vi } from "vite-plus/test";

import { makeEffectRouteFactory } from "../src/index.ts";
import { ReactRouter } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A service of one request, which the platform passes with the request, as a Worker's `ctx`. */
class ExecutionContext extends Context.Service<ExecutionContext, { readonly id: string }>()(
  "test/ExecutionContext",
) {}

/** An app-wide service, merged into the layer that the Web handler gets. */
class AppConfig extends Context.Service<AppConfig, { readonly greeting: string }>()(
  "test/AppConfig",
) {}

/** A resource of one request, such as a database connection. */
class Connection extends Context.Service<Connection, { readonly isOpen: () => boolean }>()(
  "test/Connection",
) {}

const routeFactory = makeEffectRouteFactory()(() => ({}));

/** How many connections opened and closed. */
const connections = { opened: 0, closed: 0 };

/** The `id` query parameters of the requests whose signal aborted. */
const aborted = new Set<string>();

/** What a route saw of its request, by the `id` query parameter. */
const seen = new Map<string, { readonly url: string; readonly host: string | null }>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const encoder = new TextEncoder();
const idOf = (request: Request) => new URL(request.url).searchParams.get("id") ?? "";

/** A route module of the fixture build, as the build plugin collects its exports. */
type RouteModule = Record<string, unknown>;

const route = (id: string, path: string, module: RouteModule) => ({
  id,
  path,
  parentId: "root",
  module,
});

const routes = {
  root: { id: "root", path: "", module: { default: () => null } },
  context: route("context", "context", {
    loader: Effect.fn("contextLoader")(function* () {
      const context = yield* ExecutionContext;
      return Response.json({ id: context.id });
    }),
  }),
  config: route("config", "config", {
    loader: Effect.fn("configLoader")(function* () {
      const config = yield* AppConfig;
      return Response.json({ greeting: config.greeting });
    }),
  }),
  form: route("form", "form", {
    action: async ({ request }: { readonly request: Request }) => {
      const form = await request.formData();
      return Response.json({ name: form.get("name") });
    },
  }),
  connection: route("connection", "connection", {
    loader: Effect.fn("connectionLoader")(function* () {
      const connection = yield* Connection;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 3; i++) {
              controller.enqueue(encoder.encode(connection.isOpen() ? "open " : "closed "));
              await sleep(20);
            }
            controller.close();
          },
        }),
      );
    }),
  }),
  stream: route("stream", "stream", {
    loader: ({ request }: { readonly request: Request }) => {
      const id = idOf(request);
      request.signal.addEventListener("abort", () => aborted.add(id), { once: true });
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const letter of ["a", "b", "c", "d"]) {
              controller.enqueue(encoder.encode(letter));
              await sleep(60);
            }
            controller.close();
          },
        }),
      );
    },
  }),
  ignore: route("ignore", "ignore", {
    action: () => Response.json({ saved: true }),
  }),
  slow: route("slow", "slow", {
    loader: async ({ request }: { readonly request: Request }) => {
      const id = idOf(request);
      request.signal.addEventListener("abort", () => aborted.add(id), { once: true });
      await sleep(300);
      return Response.json({ finished: true });
    },
  }),
  echo: route("echo", "echo", {
    loader: ({ request }: { readonly request: Request }) => {
      seen.set(idOf(request), { url: request.url, host: request.headers.get("host") });
      return Response.json({ url: request.url });
    },
  }),
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

/** Opens a connection for each request, and closes it with the request's scope. */
const ConnectionLive = Layer.effect(Connection)(
  Effect.gen(function* () {
    let open = true;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        connections.opened++;
      }),
      () =>
        Effect.sync(() => {
          open = false;
          connections.closed++;
        }),
    );
    return { isOpen: () => open };
  }),
);

/** Builds the connection in the request's scope, for the routes it is provided to. */
const Connections = HttpRouter.middleware((app) =>
  Effect.flatMap(Layer.build(ConnectionLive), (context) => Effect.provideContext(app, context)),
).layer;

const AppConfigLive = Layer.succeed(AppConfig)({ greeting: "hello" });

/** The same `App` that a Node server serves. */
const App = ReactRouter.routes.pipe(
  Layer.provide(Connections),
  Layer.provide(ReactRouter.layer({ build, factory: routeFactory, mode: "production" })),
);

const executionContext = Context.make(ExecutionContext, { id: "request-1" });

/** A request to the Web handler. */
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("the adapter on HttpRouter.toWebHandler", () => {
  const app = HttpRouter.toWebHandler(App.pipe(Layer.provideMerge(AppConfigLive)), {
    disableLogger: true,
  });
  afterAll(() => app.dispose());

  it("gives route Effects a service that the platform passes with the request", async () => {
    const response = await app.handler(request("/context"), executionContext);
    expect(await response.json()).toEqual({ id: "request-1" });
  });

  it("gives route Effects a service merged into the layer", async () => {
    const response = await app.handler(request("/config"), executionContext);
    expect(await response.json()).toEqual({ greeting: "hello" });
  });

  it("gives an action the request body", async () => {
    const response = await app.handler(
      request("/form", { method: "POST", body: new URLSearchParams({ name: "ada" }) }),
      executionContext,
    );
    expect(await response.json()).toEqual({ name: "ada" });
  });

  it("keeps a resource of the request's scope open until the streamed body ends", async () => {
    const before = { ...connections };
    const response = await app.handler(request("/connection"), executionContext);
    expect(await response.text()).toBe("open open open ");
    await vi.waitFor(() => expect(connections.closed - before.closed).toBe(1));
    expect(connections.opened - before.opened).toBe(1);
  });

  it("aborts the route's signal when the client's request aborts while a loader runs", async () => {
    const controller = new AbortController();
    const response = app.handler(
      request("/slow?id=left", { signal: controller.signal }),
      executionContext,
    );
    await sleep(50);
    controller.abort();
    await response.catch(() => undefined);
    await vi.waitFor(() => expect(aborted.has("left")).toBe(true));
  });

  it("aborts the route's signal when the client cancels the streamed body", async () => {
    const response = await app.handler(request("/stream?id=cancel"), executionContext);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a body");
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(aborted.has("cancel")).toBe(true));
  });

  it("does not abort the route's signal of a completed response", async () => {
    const response = await app.handler(request("/stream?id=complete"), executionContext);
    expect(await response.text()).toBe("abcd");
    expect(aborted.has("complete")).toBe(false);
  });

  it("answers an action whose body a middleware read first", async () => {
    const ReadBody = HttpRouter.middleware(
      (handler) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (current) =>
          Effect.flatMap(current.text, () => handler),
        ),
      { global: true },
    );
    const reading = HttpRouter.toWebHandler(Layer.mergeAll(App, ReadBody), {
      disableLogger: true,
    });
    try {
      const response = await reading.handler(
        request("/ignore", { method: "POST", body: "signature=1" }),
        executionContext,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ saved: true });
    } finally {
      await reading.dispose();
    }
  });

  it("gives React Router the runtime's own request, without the changes of middleware", async () => {
    // Removes `/api` and sets the host, as a prefix or `xForwardedHeaders` would.
    const Rewrite = HttpRouter.middleware(
      (handler) =>
        Effect.updateService(handler, HttpServerRequest.HttpServerRequest, (current) =>
          current.modify({
            url: current.url.replace(/^\/api/, ""),
            headers: Headers.set(current.headers, "host", "forwarded.example"),
          }),
        ),
      { global: true },
    );
    const rewritten = HttpRouter.toWebHandler(
      Layer.mergeAll(App, Rewrite).pipe(Layer.provideMerge(AppConfigLive)),
      { disableLogger: true },
    );
    try {
      const response = await rewritten.handler(request("/echo?id=plain"), executionContext);
      expect(response.status).toBe(200);
      expect(seen.get("plain")).toEqual({ url: "http://localhost/echo?id=plain", host: null });
      // On Effect's Node server, React Router gets the changed URL. On a Web
      // server, `HttpServerRequest.toWeb` returns the runtime's request as it is.
      // React Router matches no route for `/api/echo`, so the loader does not run.
      await (await rewritten.handler(request("/api/echo?id=api"), executionContext)).text();
      expect(seen.has("api")).toBe(false);
    } finally {
      await rewritten.dispose();
    }
  });
});

describe("the tracer on HttpRouter.toWebHandler", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const TracerLive = Layer.succeed(Tracer.Tracer)(
    Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
  );

  /** The names of the spans of one request to `handler`. */
  const spanNames = async (handler: {
    readonly handler: (
      request: Request,
      context: Context.Context<ExecutionContext>,
    ) => Promise<Response>;
    readonly dispose: () => Promise<void>;
  }) => {
    spans.length = 0;
    try {
      await (await handler.handler(request("/config"), executionContext)).text();
    } finally {
      await handler.dispose();
    }
    return spans.map((span) => span.name);
  };

  it("traces the request when the tracer is merged into the layer", async () => {
    const names = await spanNames(
      HttpRouter.toWebHandler(
        App.pipe(Layer.provideMerge(AppConfigLive), Layer.provideMerge(TracerLive)),
        { disableLogger: true },
      ),
    );
    expect(names).toContain("react-router.loader config");
  });

  it("traces nothing when the tracer is only provided to the layer", async () => {
    const names = await spanNames(
      HttpRouter.toWebHandler(
        App.pipe(Layer.provideMerge(AppConfigLive), Layer.provide(TracerLive)),
        { disableLogger: true },
      ),
    );
    expect(names).toEqual([]);
  });
});
