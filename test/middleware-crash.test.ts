import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Predicate, Tracer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeEffectRouteFactory, type EffectMiddlewareArgs } from "../src/index.ts";
import { ReactRouter } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Fixtures: two effect middlewares at the root, above routes whose own
// middleware crashes, and a server entry that records what `handleError` gets.
// ---------------------------------------------------------------------------

/** The crash of a route's own middleware. */
const crash = new Error("route middleware crashed");

/** What React Router passed to the server entry's `handleError`. */
const handled: Array<unknown> = [];

const spans: Array<Tracer.NativeSpan> = [];

/** A tracer that records every span. Not the native tracer, so the adapter traces. */
const recordingTracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options);
    spans.push(span);
    return span;
  },
});

const routeFactory = makeEffectRouteFactory()(() => ({}));

/** A plain middleware that crashes before it calls `next()`. */
const crashingMiddleware = () => {
  throw crash;
};

/** A route of the fixture build, as the build plugin collects its exports. */
interface FixtureRoute {
  readonly id: string;
  readonly path: string;
  readonly parentId?: string;
  readonly module: Record<string, unknown>;
}

const routes: Record<string, FixtureRoute> = {
  root: {
    id: "root",
    path: "",
    module: {
      default: () => null,
      middleware: [
        Effect.fn("outerMiddleware")(function* ({ next }: EffectMiddlewareArgs) {
          return yield* next();
        }),
        Effect.fn("innerMiddleware")(function* ({ next }: EffectMiddlewareArgs) {
          return yield* next();
        }),
      ],
    },
  },
  // A resource route: no default export, so React Router runs it with `queryRoute`.
  resource: {
    id: "resource",
    path: "resource",
    parentId: "root",
    module: {
      middleware: [crashingMiddleware],
      loader: () => new Response("unreachable"),
    },
  },
  // A page: React Router runs its document and `.data` requests with `query`.
  page: {
    id: "page",
    path: "page",
    parentId: "root",
    module: {
      default: () => null,
      middleware: [crashingMiddleware],
      loader: () => ({ unreachable: true }),
    },
  },
};

const build: ServerBuild = {
  entry: {
    module: {
      default: (_request: Request, status: number) => new Response("document", { status }),
      handleError: (error: unknown) => {
        handled.push(error);
      },
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
          hasAction: false,
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
};

const App = ReactRouter.routes.pipe(
  Layer.provide(ReactRouter.layer({ build, factory: routeFactory, mode: "test" })),
);

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let origin = "";

beforeAll(async () => {
  runtime = ManagedRuntime.make(
    HttpRouter.serve(App, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
      Layer.provide(Layer.succeed(Tracer.Tracer)(recordingTracer)),
    ),
  );
  const address = (await runtime.runPromise(HttpServer.HttpServer)).address;
  if (Predicate.isTagged(address, "UnixPathAddress")) throw new Error("Expected a TCP address");
  origin = `http://localhost:${address.port}`;
});

afterAll(() => runtime.dispose());

beforeEach(() => {
  handled.length = 0;
  spans.length = 0;
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Waits until every recorded span has ended: the server span ends after the body is sent. */
const ended = async () => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spans.length > 0 && spans.every((span) => Predicate.isTagged(span.status, "Ended"))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The spans did not end");
};

/** The error a span ended with: the squashed cause of a failure, or `undefined` on success. */
const spanError = (span: Tracer.NativeSpan): unknown => {
  const status = span.status;
  if (!Predicate.isTagged(status, "Ended")) throw new Error(`The span ${span.name} did not end`);
  return Exit.isFailure(status.exit) ? Cause.squash(status.exit.cause) : undefined;
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("a crash below an effect middleware", () => {
  it.each([
    ["a resource route", "/resource"],
    ["a document request", "/page"],
    ["a .data request", "/page.data"],
  ])("reaches handleError once as the original error, for %s", async (_kind, path) => {
    const response = await fetch(`${origin}${path}`);
    await response.text();
    expect(handled).toHaveLength(1);
    expect(handled[0]).toBe(crash);
  });

  it("gets React Router's own 500 for a resource route, not the library's", async () => {
    const response = await fetch(`${origin}/resource`);
    expect(response.status).toBe(500);
    expect(await response.text()).toMatch(/^Unexpected Server Error/);
  });

  it("ends each effect middleware's spans with the original error", async () => {
    await (await fetch(`${origin}/resource`)).text();
    await ended();
    // In start order: the adapter's span of each middleware, then its Effect.fn span.
    const middlewareSpans = spans.filter(
      (span) =>
        span.name === "react-router.middleware root" ||
        span.name === "outerMiddleware" ||
        span.name === "innerMiddleware",
    );
    expect(middlewareSpans.map((span) => [span.name, spanError(span)])).toEqual([
      ["react-router.middleware root", crash],
      ["outerMiddleware", crash],
      ["react-router.middleware root", crash],
      ["innerMiddleware", crash],
    ]);
    for (const span of middlewareSpans) expect(spanError(span)).toBe(crash);
  });
});
