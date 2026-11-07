import { Context, Data, Effect, Layer, Logger, ManagedRuntime, Tracer } from "effect";
import { createContext, RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  makeEffectRouteFactory,
  type EffectMiddlewareArgs,
  type RequestContextKey,
} from "../src/index.ts";
import * as ReactRouterWorker from "../src/worker.ts";
import { makeBuild, route } from "./build-fixture.ts";

// ---------------------------------------------------------------------------
// Fixtures: services, a factory with a runtime, and a build of resource routes.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class UnhandledError extends Data.TaggedError("UnhandledError")<{}> {}
class ConnectError extends Data.TaggedError("ConnectError")<{}> {}

/** An app-wide service of the runtime. */
class AppConfig extends Context.Service<AppConfig, { readonly name: string }>()("test/AppConfig") {}

/** Built by `requestContext` for every request. */
class RequestId extends Context.Service<RequestId, { readonly id: string }>()("test/RequestId") {}

/** Provided by an effect middleware around `next()`. */
class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}

/** A per-request resource, built by the request layer and released with its scope. */
class Connection extends Context.Service<Connection, { readonly id: number }>()(
  "test/Connection",
) {}

/** What happened to connections and background work, in order. */
const events: Array<string> = [];

/** What the app's loggers received: each log's level and its message parts. */
const logs: Array<{ readonly level: string; readonly message: ReadonlyArray<unknown> }> = [];
const capture = Logger.make(({ logLevel, message }) => {
  logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
});

/** The error a log's message carries, if any. */
const errorOf = (log: (typeof logs)[number] | undefined) =>
  log?.message.find((part) => part instanceof Error);

let connections = 0;

/**
 * The request layer: opens a connection with the runtime's config and the
 * Worker's env, and closes it with the request's scope. A request to
 * `/layer-fails` fails to build it.
 */
const ConnectionLayer = (request: Request) =>
  Layer.effect(Connection)(
    Effect.gen(function* () {
      if (new URL(request.url).pathname === "/layer-fails") return yield* new ConnectError();
      const config = yield* AppConfig;
      const worker = yield* ReactRouterWorker.WorkerContext;
      const id = ++connections;
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push(`open ${id} ${config.name} ${String(worker.env)}`)),
        () => Effect.sync(() => events.push(`close ${id}`)),
      );
      return { id };
    }),
  );

const runtime = ManagedRuntime.make(
  Layer.mergeAll(Layer.succeed(AppConfig)({ name: "app" }), Logger.layer([capture])),
);

const requestContext: RequestContextKey<
  ReactRouterWorker.WorkerContext | RequestId | Connection | Greeting
> = createContext();

const routeFactory = makeEffectRouteFactory<FormError | UnhandledError>()((Respond) => ({
  runtime,
  requestContext,
  errorHandlers: {
    FormError: (error) => Respond.early({ reply: error.reply }, 422),
  },
}));
const { Respond } = routeFactory;

/** A key that a promise loader reads, set by `getLoadContext`. */
const legacyEnv = createContext<{ readonly env: unknown }>();

/** Waits for `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The `id` query parameters of the slow loaders that were interrupted. */
const interrupted = new Set<string>();

const rootMiddleware = [
  Effect.fn("provideGreeting")(function* ({ next }: EffectMiddlewareArgs) {
    return yield* next().pipe(Effect.provideService(Greeting, { text: "hello" }));
  }),
];

const build = makeBuild(
  [
    route("services", "services", {
      loader: Effect.fn("services")(function* () {
        const worker = yield* ReactRouterWorker.WorkerContext;
        return Response.json({
          env: worker.env,
          config: (yield* AppConfig).name,
          requestId: (yield* RequestId).id,
          greeting: (yield* Greeting).text,
          connection: (yield* Connection).id,
        });
      }),
    }),
    route("legacy", "legacy", {
      loader: async ({ context }: { readonly context: RouterContextProvider }) =>
        Response.json({ legacy: context.get(legacyEnv).env }),
    }),
    route("recovered", "recovered", {
      loader: Effect.fn("recovered")(function* () {
        return yield* new FormError({ reply: "invalid" });
      }),
    }),
    route("unhandled", "unhandled", {
      loader: Effect.fn("unhandled")(function* () {
        return yield* new UnhandledError();
      }),
    }),
    route("redirect", "redirect", {
      loader: Effect.fn("redirect")(function* () {
        return yield* Respond.redirect("/elsewhere", 303);
      }),
    }),
    route("stream", "stream", {
      loader: Effect.fn("stream")(function* () {
        const { id } = yield* Connection;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const chunk of ["a", "b", "c"]) {
              controller.enqueue(encoder.encode(`${chunk}${id}`));
              await sleep(20);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/plain" } });
      }),
    }),
    route("background", "background", {
      loader: Effect.fn("background")(function* () {
        const worker = yield* ReactRouterWorker.WorkerContext;
        yield* worker.waitUntil(
          Effect.gen(function* () {
            yield* Effect.sleep("30 millis");
            const { id } = yield* Connection;
            events.push(`background ${id}`);
          }),
        );
        yield* worker.waitUntil(Effect.die(new Error("background failed")));
        return Response.json({ ok: true });
      }),
    }),
    route("slow", "slow", {
      loader: ({ request }: { readonly request: Request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        return Effect.sleep("300 millis").pipe(
          Effect.as(Response.json({ slow: true })),
          Effect.onInterrupt(() => Effect.sync(() => interrupted.add(id))),
        );
      },
    }),
    route("page", "page", {
      default: () => null,
      loader: Effect.fn("page")(() => Effect.succeed({ page: true })),
    }),
  ],
  { middleware: rootMiddleware },
);

/** A Worker execution context that records its `waitUntil` promises. */
const makeCtx = () => {
  const promises: Array<Promise<unknown>> = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    /** Waits for every `waitUntil` promise, those added while waiting included. */
    drain: async () => {
      let seen = 0;
      while (seen < promises.length) {
        seen = promises.length;
        await Promise.allSettled(promises);
      }
    },
  };
};

const handler = ReactRouterWorker.make({
  build,
  factory: routeFactory,
  mode: "test",
  requestContext: (request) =>
    Context.make(RequestId, { id: request.headers.get("x-request-id") ?? "none" }),
  requestLayer: ConnectionLayer,
  getLoadContext: async (_request, { env }) => {
    const context = new RouterContextProvider();
    context.set(legacyEnv, { env });
    return context;
  },
});

const get = (path: string, init?: RequestInit) => {
  const ctx = makeCtx();
  const response = handler.fetch(new Request(`https://example.com${path}`, init), "env-1", ctx);
  return { ctx, response };
};

beforeEach(() => {
  events.length = 0;
  logs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("route Effects", () => {
  it("runs with the runtime's, the request's, the layer's and the middleware's services", async () => {
    const { response } = get("/services", { headers: { "x-request-id": "r-1" } });
    expect(await (await response).json()).toEqual({
      env: "env-1",
      config: "app",
      requestId: "r-1",
      greeting: "hello",
      connection: connections,
    });
  });

  it("passes promise route functions through, with the context getLoadContext makes", async () => {
    const { response } = get("/legacy");
    expect(await (await response).json()).toEqual({ legacy: "env-1" });
  });

  it("recovers a domain error with its handler", async () => {
    const res = await get("/recovered").response;
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ reply: "invalid" });
  });

  it("answers 500 for a declared domain error without a handler", async () => {
    expect((await get("/unhandled").response).status).toBe(500);
  });

  it("sends a redirect", async () => {
    const res = await get("/redirect").response;
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });

  it("renders a document", async () => {
    const res = await get("/page").response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("document");
  });

  it("interrupts a route Effect when the request aborts", async () => {
    const controller = new AbortController();
    const { response } = get("/slow?id=abort-1", { signal: controller.signal });
    await sleep(20);
    controller.abort();
    await response.catch(() => undefined);
    await sleep(10);
    expect(interrupted.has("abort-1")).toBe(true);
  });
});

describe("the request layer", () => {
  it("closes after a response without a body", async () => {
    const { ctx, response } = get("/redirect");
    expect((await response).status).toBe(303);
    await ctx.drain();
    expect(events).toEqual([`open ${connections} app env-1`, `close ${connections}`]);
  });

  it("stays open while the body streams, and closes when it ends", async () => {
    const { ctx, response } = get("/stream");
    const res = await response;
    const reader = res.body!.getReader();
    const first = await reader.read();
    const id = connections;
    expect(new TextDecoder().decode(first.value)).toBe(`a${id}`);
    await sleep(5);
    expect(events).toEqual([`open ${id} app env-1`]);
    let text = new TextDecoder().decode(first.value);
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      text += new TextDecoder().decode(chunk.value);
    }
    expect(text).toBe(`a${id}b${id}c${id}`);
    expect(res.headers.get("content-type")).toBe("text/plain");
    await ctx.drain();
    expect(events).toEqual([`open ${id} app env-1`, `close ${id}`]);
  });

  it("closes when the client cancels the body", async () => {
    const { ctx, response } = get("/stream");
    const res = await response;
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await ctx.drain();
    expect(events).toEqual([`open ${connections} app env-1`, `close ${connections}`]);
  });

  it("closes after the request's waitUntil Effects, which keep its services", async () => {
    const { ctx, response } = get("/background");
    expect(await (await response).json()).toEqual({ ok: true });
    await ctx.drain();
    const id = connections;
    expect(events).toEqual([`open ${id} app env-1`, `background ${id}`, `close ${id}`]);
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([
      ["Error", "A waitUntil Effect failed"],
    ]);
  });

  it("logs a layer that fails to build, and answers 500 without calling React Router", async () => {
    const { ctx, response } = get("/layer-fails");
    const res = await response;
    await ctx.drain();
    expect(res.status).toBe(500);
    expect(events).toEqual([]);
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([
      ["Error", "React Router adapter failed"],
    ]);
  });
});

describe("adapter errors", () => {
  it("logs a requestContext that throws, and answers 500", async () => {
    const throwing = ReactRouterWorker.make({
      build,
      factory: routeFactory,
      mode: "test",
      requestContext: () => {
        throw new Error("request context failed");
      },
    });
    const res = await throwing.fetch(new Request("https://example.com/legacy"), "env", makeCtx());
    expect(res.status).toBe(500);
    expect(errorOf(logs[0])?.message).toBe("request context failed");
  });

  it("answers 500 when the runtime does not build", async () => {
    const failing = makeEffectRouteFactory()(() => ({
      runtime: ManagedRuntime.make(Layer.effectDiscard(Effect.die(new Error("runtime failed")))),
    }));
    const errors: Array<unknown> = [];
    const original = console.error;
    console.error = (...args: Array<unknown>) => errors.push(args);
    try {
      const res = await ReactRouterWorker.make({ build, factory: failing, mode: "test" }).fetch(
        new Request("https://example.com/legacy"),
        "env",
        makeCtx(),
      );
      expect(res.status).toBe(500);
      expect(errors).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it("logs a development build that does not load, and answers 500", async () => {
    const res = await ReactRouterWorker.make({
      build: () => Promise.reject(new Error("build failed")),
      factory: routeFactory,
      mode: "development",
    }).fetch(new Request("https://example.com/legacy"), "env", makeCtx());
    expect(res.status).toBe(500);
    expect(errorOf(logs[0])?.message).toBe("build failed");
  });
});

describe("the build", () => {
  it("loads a new build for each request in development", async () => {
    const first = makeBuild([
      route("which", "which", { loader: () => Response.json({ build: 1 }) }),
    ]);
    const second = makeBuild([
      route("which", "which", { loader: () => Response.json({ build: 2 }) }),
    ]);
    let current = first;
    const dev = ReactRouterWorker.make({
      build: () => current,
      factory: routeFactory,
      mode: "development",
      requestContext: () => Context.empty(),
    });
    const ask = async () =>
      (await dev.fetch(new Request("https://example.com/which"), "env", makeCtx())).json();
    expect(await ask()).toEqual({ build: 1 });
    current = second;
    expect(await ask()).toEqual({ build: 2 });
  });
});

describe("tracing", () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const recordingTracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  const tracedFactory = makeEffectRouteFactory()(() => ({
    runtime: ManagedRuntime.make(Layer.succeed(Tracer.Tracer)(recordingTracer)),
  }));
  const traced = ReactRouterWorker.make({
    build: makeBuild([
      route("traced", "traced/:id", {
        loader: Effect.fn("loader.traced")(function* () {
          return Response.json(yield* Effect.succeed({ ok: true }));
        }),
      }),
    ]),
    factory: tracedFactory,
    mode: "test",
  });

  it("runs the request in a server span, with the route functions' spans under it", async () => {
    spans.length = 0;
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const res = await traced.fetch(
      new Request("https://example.com/traced/1", {
        headers: { traceparent: `00-${traceId}-b7ad6b7169203331-01` },
      }),
      "env",
      makeCtx(),
    );
    expect(res.status).toBe(200);
    const server = spans.find((span) => span.kind === "server");
    expect(server?.name).toBe("GET");
    expect(server?.traceId).toBe(traceId);
    expect(server?.attributes.get("http.route")).toBe("/traced/:id");
    expect(server?.attributes.get("http.response.status_code")).toBe(200);
    const loader = spans.find((span) => span.name === "react-router.loader traced");
    expect(loader?.parent._tag === "Some" && loader.parent.value).toBe(server);
    const effect = spans.find((span) => span.name === "loader.traced");
    expect(effect?.parent._tag === "Some" && effect.parent.value).toBe(loader);
  });

  it("adds no spans without a tracer that exports them", async () => {
    spans.length = 0;
    await handler.fetch(new Request("https://example.com/legacy"), "env", makeCtx());
    expect(spans).toEqual([]);
  });
});
