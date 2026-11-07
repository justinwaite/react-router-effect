import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, ManagedRuntime, Option, Predicate, Tracer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServer } from "effect/http";
import { RouterContextProvider, type ServerBuild } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeEffectRouteFactory, type EffectMiddlewareArgs } from "../src/index.ts";
import * as ReactRouterHttp from "../src/server.ts";

const { ReactRouter } = ReactRouterHttp;

// ---------------------------------------------------------------------------
// Fixtures: a tracer that records its spans, and a build with nested middleware.
// ---------------------------------------------------------------------------

const spans: Array<Tracer.NativeSpan> = [];

/** A tracer that records every span. Not the native tracer, so the adapter traces. */
const recordingTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

const routeFactory = makeEffectRouteFactory()((Respond) => ({ respond: Respond }));
const { Respond } = routeFactory;

/** A route of a fixture build, as the build plugin collects its exports. */
interface FixtureRoute {
  readonly id: string;
  readonly path: string;
  readonly parentId?: string;
  readonly module: Record<string, unknown>;
}

const route = (id: string, path: string, module: Record<string, unknown>): FixtureRoute => ({
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
        Effect.fn("outerMiddleware")(function* ({ next }: EffectMiddlewareArgs) {
          return yield* next();
        }),
        async (_: unknown, next: () => Promise<unknown>) => next(),
      ],
      loader: Effect.fn("rootLoader")(function* () {
        return yield* Effect.succeed({ root: true });
      }),
    },
  },
  page: route("page", "page", {
    default: () => null,
    middleware: [async (_: unknown, next: () => Promise<unknown>) => next()],
    loader: async () => ({ page: true }),
    action: Effect.fn("pageAction")(function* () {
      return yield* Effect.succeed({ saved: true });
    }),
  }),
  redirect: route("redirect", "redirect", {
    loader: Effect.fn("redirectLoader")(function* () {
      return yield* Respond.redirect("/page", 303);
    }),
  }),
  cookies: route("cookies", "cookies", {
    loader: () => {
      const headers = new Headers();
      headers.append("set-cookie", "session=a; Path=/");
      headers.append("set-cookie", "theme=dark; Path=/");
      return new Response("ok", { headers });
    },
  }),
  broken: route("broken", "broken", {
    loader: async () => {
      throw new Error("boom");
    },
  }),
};

/** A server build of `routes`, with the assets manifest that the build plugin writes for them. */
const buildOf = (routes: Record<string, FixtureRoute>): ServerBuild => ({
  entry: {
    module: {
      default: (_request: Request, status: number) => new Response("document", { status }),
    },
  },
  routes: routes as unknown as ServerBuild["routes"],
  assets: {
    entry: { imports: [], module: "/entry.client.js" },
    routes: Object.fromEntries(
      Object.values(routes).map((r) => [
        r.id,
        {
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
        },
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
});

const build = buildOf(routes);

const app = ReactRouterHttp.make({ build, factory: routeFactory, mode: "test" });

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let origin = "";

beforeAll(async () => {
  runtime = ManagedRuntime.make(
    Layer.unwrap(Effect.map(app, (served) => HttpServer.serve(served))).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
      Layer.provide(Layer.succeed(Tracer.Tracer)(recordingTracer)),
      // Records the `set-cookie` response header on the server span, which is opt-in.
      Layer.provide(
        Layer.succeed(HttpMiddleware.TracerHeaderFilter)(
          (name, phase) => phase === "response" && name === "set-cookie",
        ),
      ),
    ),
  );
  const address = (await runtime.runPromise(HttpServer.HttpServer)).address;
  if (address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
  origin = `http://localhost:${address.port}`;
});

afterAll(() => runtime.dispose());

beforeEach(() => {
  spans.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Waits until every recorded span has ended: the server span ends after the body is sent. */
const ended = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spans.length > 0 && spans.every((span) => span.status._tag === "Ended")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The spans did not end");
};

/** The recorded spans as a tree of names, children in start order. */
const tree = (): string => {
  const lines: Array<string> = [];
  const print = (parent: Tracer.AnySpan | undefined, depth: number) => {
    for (const span of spans) {
      if (Option.getOrUndefined(span.parent) !== parent) continue;
      lines.push(`${"  ".repeat(depth)}${span.name}`);
      print(span, depth + 1);
    }
  };
  print(undefined, 0);
  return lines.join("\n");
};

const spanNamed = (name: string) => {
  const span = spans.find((candidate) => candidate.name === name);
  if (span === undefined) throw new Error(`No span ${name}`);
  return span;
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("spans", () => {
  it("nests middleware, loaders and route Effects as React Router calls them", async () => {
    expect((await fetch(`${origin}/page`)).status).toBe(200);
    await ended();
    expect(tree()).toBe(
      [
        "GET",
        "  react-router.middleware root",
        "    outerMiddleware",
        "      react-router.middleware root",
        "        react-router.middleware page",
        "          react-router.loader root",
        "            rootLoader",
        "          react-router.loader page",
      ].join("\n"),
    );
  });

  it("nests the action under the middleware", async () => {
    const response = await fetch(`${origin}/page.data`, { method: "POST", headers: { origin } });
    expect(response.status).toBe(200);
    await ended();
    expect(tree()).toContain(
      [
        "        react-router.middleware page",
        "          react-router.action page",
        "            pageAction",
      ].join("\n"),
    );
  });

  it("sets http.route and the route function's attributes", async () => {
    await fetch(`${origin}/page`);
    await ended();
    expect(spanNamed("GET").attributes.get("http.route")).toBe("/page");
    expect(Object.fromEntries(spanNamed("react-router.loader page").attributes)).toEqual({
      "react_router.operation.name": "loader",
      "react_router.route.id": "page",
    });
  });

  it("ends the span of a redirect as a success, and of a thrown error as a failure", async () => {
    expect((await fetch(`${origin}/redirect`, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(`${origin}/broken`)).status).toBe(500);
    await ended();
    const exitOf = (name: string) => {
      const status = spanNamed(name).status;
      return status._tag === "Ended" ? status.exit._tag : status._tag;
    };
    expect(exitOf("react-router.loader redirect")).toBe("Success");
    expect(exitOf("react-router.loader broken")).toBe("Failure");
  });

  it("keeps React Router's cookies out of the server span", async () => {
    expect((await fetch(`${origin}/cookies`)).headers.getSetCookie()).toHaveLength(2);
    await ended();
    expect(spanNamed("GET").attributes.has("http.response.header.set-cookie")).toBe(false);
  });
});

describe("http.route", () => {
  /** Routes that run no route function, so only React Router's pattern names them. */
  const App = ReactRouter.routes.pipe(
    Layer.provide(
      ReactRouter.layer({
        build: buildOf({
          root: { id: "root", path: "", module: { default: () => null } },
          post: route("post", "posts/:id", { default: () => null }),
        }),
        factory: routeFactory,
        mode: "test",
      }),
    ),
  );

  /** Serves `App` with `tracer`, and returns its origin and how to stop it. */
  const start = async (tracer: Tracer.Tracer) => {
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(App, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
        Layer.provide(Layer.succeed(Tracer.Tracer)(tracer)),
      ),
    );
    const address = (await runtime.runPromise(HttpServer.HttpServer)).address;
    if (address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
    return { origin: `http://localhost:${address.port}`, stop: () => runtime.dispose() };
  };

  let traced: Awaited<ReturnType<typeof start>>;
  let untraced: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    traced = await start(recordingTracer);
    untraced = await start(Tracer.nativeTracer);
  });

  afterAll(() => Promise.all([traced.stop(), untraced.stop()]));

  it("sets the pattern of a page that runs no route function", async () => {
    expect((await fetch(`${traced.origin}/posts/1`)).status).toBe(200);
    await ended();
    expect(spanNamed("GET").attributes.get("http.route")).toBe("/posts/:id");
  });

  it("keeps the router's * for a request that matched no route", async () => {
    expect((await fetch(`${traced.origin}/missing`)).status).toBe(404);
    await ended();
    expect(spanNamed("GET").attributes.get("http.route")).toBe("*");
  });

  it("gives React Router no hook with the native tracer", async () => {
    // React Router stores the matched pattern of a request in its context
    // only when the build has a request handler hook.
    const set = vi.spyOn(RouterContextProvider.prototype, "set");
    const storedPatterns = () =>
      set.mock.calls.filter(([, value]) => Predicate.hasProperty(value, "pattern")).length;
    try {
      await fetch(`${untraced.origin}/posts/1`);
      const untracedPatterns = storedPatterns();
      set.mockClear();
      await fetch(`${traced.origin}/posts/1`);
      await ended();
      expect([untracedPatterns, storedPatterns()]).toEqual([0, 1]);
    } finally {
      set.mockRestore();
    }
  });
});
