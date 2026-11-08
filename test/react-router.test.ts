import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Logger, ManagedRuntime, Option, Predicate } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  createContext,
  RouterContextProvider,
  type LoaderFunctionArgs,
  type ServerBuild,
} from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { makeEffectRouteFactory, type EffectMiddlewareArgs } from "../src/index.ts";
import { ReactRouter } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Fixtures: a factory, services, and a server build with bare Effect.fn exports.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class UnhandledError extends Data.TaggedError("UnhandledError")<{}> {}

/** Provided by a route-scoped `HttpRouter.middleware` on `ReactRouter.routes`. */
class RequestId extends Context.Service<RequestId, { readonly id: string }>()("test/RequestId") {}

/** Provided by a bare `Effect.fn` middleware around `next()`. */
class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}

/** Set by a bare `Effect.fn` middleware with `context.set` before it calls `next()`. */
class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "test/CurrentUser",
) {}

/** A service of the app, which `loadContext` reads from the layer. */
class Tenant extends Context.Service<Tenant, { readonly name: string }>()("test/Tenant") {}

/** The value that `loadContext` sets, for plain loaders to read with `context.get`. */
const tenantKey = createContext<string>();

/** The values of `x-test-scope` whose finalizers ran. */
const closed: Array<string> = [];

/**
 * Sets `tenantKey` from the `Tenant` service and the `x-tenant` header. It
 * dies when the request has an `x-test-die` header. When the request has an
 * `x-test-scope` header, it adds a finalizer that records the header's value.
 */
const loadContext = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    if (request.headers["x-test-die"] !== undefined) {
      return yield* Effect.die(new Error("load context failed"));
    }
    const scope = request.headers["x-test-scope"];
    if (scope !== undefined) {
      yield* Effect.addFinalizer(() => Effect.sync(() => closed.push(scope)));
    }
    const tenant = yield* Tenant;
    const context = new RouterContextProvider();
    context.set(tenantKey, `${tenant.name}:${request.headers["x-tenant"] ?? "none"}`);
    return context;
  });

const routeFactory = makeEffectRouteFactory<FormError | UnhandledError>()((Respond) => ({
  errorHandlers: {
    FormError: (error) => Respond.early({ reply: error.reply }, 422),
  },
  actionMeta: () => ({ requestId: "request-1" }),
}));
const store = routeFactory.handlers.requestContext;

/** A route of the fixture build, as the build plugin collects its exports. */
const route = (id: string, path: string, module: Record<string, unknown>) => ({
  id,
  path,
  parentId: "root",
  module,
});

const routes = {
  root: {
    id: "root",
    path: "",
    module: {
      default: () => null,
      middleware: [
        Effect.fn("provideGreeting")(function* ({ next }: EffectMiddlewareArgs) {
          return yield* next().pipe(Effect.provideService(Greeting, { text: "hello" }));
        }),
        Effect.fn("setUser")(function* ({ context, next }: EffectMiddlewareArgs) {
          context.set(store, Context.add(context.get(store), CurrentUser, { id: "user-1" }));
          return yield* next();
        }),
      ],
    },
  },
  effectLoader: route("effectLoader", "effect-loader", {
    loader: Effect.fn("effectLoader")(function* () {
      const requestId = yield* RequestId;
      const greeting = yield* Greeting;
      const user = yield* CurrentUser;
      return Response.json({ requestId: requestId.id, greeting: greeting.text, user: user.id });
    }),
  }),
  promiseLoader: route("promiseLoader", "promise-loader", {
    loader: async () => Response.json({ plain: true }),
  }),
  recovered: route("recovered", "recovered", {
    loader: Effect.fn("recovered")(function* () {
      return yield* new FormError({ reply: "bare" });
    }),
  }),
  wrapped: route("wrapped", "wrapped", {
    loader: routeFactory.makeLoader((_args: LoaderFunctionArgs) =>
      Effect.fail(new FormError({ reply: "wrapped" })),
    ),
  }),
  unhandled: route("unhandled", "unhandled", {
    loader: Effect.fn("unhandled")(function* () {
      return yield* new UnhandledError();
    }),
  }),
  url: route("url", "url", {
    loader: ({ request }: { readonly request: Request }) => Response.json({ url: request.url }),
  }),
  tenant: route("tenant", "tenant", {
    loader: ({ context }: { readonly context: Readonly<RouterContextProvider> }) =>
      Response.json({ tenant: context.get(tenantKey) }),
  }),
  page: route("page", "page", {
    default: () => null,
    action: Effect.fn("pageAction")(() => Effect.succeed({ saved: true })),
  }),
  method: route("method", "method", {
    loader: ({ request }: { readonly request: Request }) =>
      new Response("method", { headers: { "x-method": request.method } }),
  }),
};

/** An entry route of the assets manifest. */
const entryRoute = (id: string, path: string, parentId: string | undefined) => ({
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

/** Provides `RequestId` to React Router's routes only. */
const RequestIdMiddleware = HttpRouter.middleware((app) =>
  Effect.provideService(app, RequestId, { id: "request-id-1" }),
).layer;

const ReactRouterLive = ReactRouter.layer({
  build,
  factory: routeFactory,
  mode: "test",
  loadContext,
}).pipe(Layer.provide(Layer.succeed(Tenant, { name: "acme" })));

const App = Layer.mergeAll(
  ReactRouter.routes.pipe(Layer.provide(RequestIdMiddleware)),
  HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
).pipe(Layer.provide(ReactRouterLive));

/** What the app's loggers received: each log's level and its message parts. */
const logs: Array<{ readonly level: string; readonly message: ReadonlyArray<unknown> }> = [];
const capture = Logger.make(({ logLevel, message }) => {
  logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
});

/** The error in the message parts of a log, if any. */
const errorOf = (log: (typeof logs)[number]) => log.message.find((part) => part instanceof Error);

const ServerLive = HttpRouter.serve(App, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
  Layer.provide(Logger.layer([capture])),
);

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let origin = "";

beforeAll(async () => {
  runtime = ManagedRuntime.make(ServerLive);
  const server = await runtime.runPromise(HttpServer.HttpServer);
  const address = server.address;
  if (Predicate.isTagged(address, "UnixPathAddress")) throw new Error("Expected a TCP address");
  origin = `http://localhost:${address.port}`;
});

afterAll(() => runtime.dispose());

/** The `build` member of the service that `ReactRouter.layer` makes from `options`. */
const serviceBuild = (options: ReactRouter.Options) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return (yield* ReactRouter).build;
    }).pipe(Effect.provide(ReactRouter.layer(options))),
  );

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("ReactRouter.routes", () => {
  it("runs a bare Effect.fn loader with a router middleware's service and the services of bare Effect.fn middleware", async () => {
    const response = await fetch(`${origin}/effect-loader`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      requestId: "request-id-1",
      greeting: "hello",
      user: "user-1",
    });
  });

  it("attaches the factory's action metadata to a bare Effect.fn action", async () => {
    const response = await fetch(`${origin}/page.data`, { method: "POST", headers: { origin } });
    expect(await response.text()).toContain("request-1");
  });

  it("passes a promise loader through unchanged", async () => {
    const response = await fetch(`${origin}/promise-loader`);
    expect(await response.json()).toEqual({ plain: true });
  });

  it("recovers a domain error of a bare Effect.fn loader and of a makeLoader wrapper", async () => {
    const bare = await fetch(`${origin}/recovered`);
    expect(bare.status).toBe(422);
    expect(await bare.json()).toEqual({ reply: "bare" });
    const wrapped = await fetch(`${origin}/wrapped`);
    expect(wrapped.status).toBe(422);
    expect(await wrapped.json()).toEqual({ reply: "wrapped" });
  });

  it("answers 500 for an unhandled domain error", async () => {
    const response = await fetch(`${origin}/unhandled`);
    expect(response.status).toBe(500);
  });

  it("gives React Router the full path and query of the request", async () => {
    const response = await fetch(`${origin}/url?a=1&b=2`);
    expect(await response.json()).toEqual({ url: `${origin}/url?a=1&b=2` });
  });

  it("serves a route of the app in place of the catch-all", async () => {
    const response = await fetch(`${origin}/health`);
    expect(await response.text()).toBe("ok");
  });

  it("answers HEAD with the GET route of the app, as Express does", async () => {
    const response = await fetch(`${origin}/health`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("2");
    expect(await response.text()).toBe("");
  });

  it("gives React Router a HEAD request as HEAD, and sends no body", async () => {
    const response = await fetch(`${origin}/method`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-method")).toBe("HEAD");
    expect(await response.text()).toBe("");
  });

  it("answers a method outside HttpMethod.all with the router's 404", async () => {
    const response = await fetch(`${origin}/method`, { method: "PROPFIND" });
    expect(response.status).toBe(404);
    expect(response.headers.get("x-method")).toBe(null);
  });
});

describe("loadContext", () => {
  it("gives a plain loader the value it made from a service and a request header", async () => {
    const response = await fetch(`${origin}/tenant`, { headers: { "x-tenant": "t-1" } });
    expect(await response.json()).toEqual({ tenant: "acme:t-1" });
  });

  it("logs a loadContext that dies, and answers an empty 500", async () => {
    logs.length = 0;
    const response = await fetch(`${origin}/tenant`, { headers: { "x-test-die": "1" } });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(logs.map((log) => log.level)).toEqual(["Error"]);
    expect(errorOf(logs[0]!)?.message).toBe("load context failed");
  });

  it("closes what loadContext opens when the request ends, not when the server stops", async () => {
    closed.length = 0;
    const response = await fetch(`${origin}/tenant`, { headers: { "x-test-scope": "s-1" } });
    await response.text();
    await vi.waitFor(() => expect(closed).toEqual(["s-1"]));
  });
});

describe("ReactRouter.layer", () => {
  it("exposes a build value as Option.some", async () => {
    const result = await serviceBuild({ build, factory: routeFactory, mode: "test" });
    expect(Option.getOrUndefined(result)).toBe(build);
  });

  it("exposes Option.none for a build function in development mode", async () => {
    const result = await serviceBuild({
      build: () => build,
      factory: routeFactory,
      mode: "development",
    });
    expect(Option.isNone(result)).toBe(true);
  });

  it("exposes Option.none for a build function in test mode", async () => {
    const result = await serviceBuild({ build: () => build, factory: routeFactory, mode: "test" });
    expect(Option.isNone(result)).toBe(true);
  });

  it("loads a build function once in a mode that React Router runs as production", async () => {
    // React Router runs in production mode for any mode but development and test.
    const result = await serviceBuild({
      build: () => build,
      factory: routeFactory,
      mode: "staging",
    });
    expect(Option.getOrUndefined(result)).toBe(build);
  });

  it("loads a production build function once for every layer that reads the service", async () => {
    let loads = 0;
    const Live = ReactRouter.layer({
      build: () => {
        loads += 1;
        return build;
      },
      factory: routeFactory,
      mode: "production",
    });
    const reader = () => Layer.effectDiscard(ReactRouter);
    await Effect.runPromise(
      Effect.provide(
        Effect.void,
        Layer.mergeAll(reader().pipe(Layer.provide(Live)), reader().pipe(Layer.provide(Live))),
      ),
    );
    expect(loads).toBe(1);
  });
});
