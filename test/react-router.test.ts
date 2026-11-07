import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import type { LoaderFunctionArgs, ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

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
  page: route("page", "page", {
    default: () => null,
    action: Effect.fn("pageAction")(() => Effect.succeed({ saved: true })),
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

const App = Layer.mergeAll(
  ReactRouter.routes.pipe(Layer.provide(RequestIdMiddleware)),
  HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
).pipe(Layer.provide(ReactRouter.layer({ build, factory: routeFactory, mode: "test" })));

const ServerLive = HttpRouter.serve(App, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
);

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let origin = "";

beforeAll(async () => {
  runtime = ManagedRuntime.make(ServerLive);
  const server = await runtime.runPromise(HttpServer.HttpServer);
  const address = server.address;
  if (address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
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
    const reader = () =>
      Layer.effectDiscard(
        Effect.gen(function* () {
          yield* ReactRouter;
        }),
      );
    await Effect.runPromise(
      Effect.provide(
        Effect.void,
        Layer.mergeAll(reader().pipe(Layer.provide(Live)), reader().pipe(Layer.provide(Live))),
      ),
    );
    expect(loads).toBe(1);
  });
});
