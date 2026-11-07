import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Logger, ManagedRuntime } from "effect";
import { HttpServer, HttpServerRequest } from "effect/http";
import { createContext } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeEffectRouteFactory, type RequestContextKey } from "../src/index.ts";
import * as ReactRouterHttp from "../src/server.ts";
import { makeBuild, route } from "./build-fixture.ts";

// ---------------------------------------------------------------------------
// Fixtures: a request layer with a resource, served from Effect's Node server.
// ---------------------------------------------------------------------------

class ConnectError extends Data.TaggedError("ConnectError")<{}> {}

/** An app-wide service of the factory's runtime. */
class AppConfig extends Context.Service<AppConfig, { readonly name: string }>()("test/AppConfig") {}

/** A per-request resource, built by the request layer and released with its scope. */
class Connection extends Context.Service<Connection, { readonly id: number }>()(
  "test/Connection",
) {}

/** What happened to connections, in order. */
const events: Array<string> = [];
let connections = 0;

const logs: Array<{ readonly level: string; readonly message: ReadonlyArray<unknown> }> = [];
const capture = Logger.make(({ logLevel, message }) => {
  logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
});

/**
 * Opens a connection with the runtime's config and the HTTP request's method,
 * and closes it with the request's scope. `/layer-fails` fails to build it.
 */
const ConnectionLayer = (request: Request) =>
  Layer.effect(Connection)(
    Effect.gen(function* () {
      if (new URL(request.url).pathname === "/layer-fails") return yield* new ConnectError();
      const config = yield* AppConfig;
      const httpRequest = yield* HttpServerRequest.HttpServerRequest;
      const id = ++connections;
      yield* Effect.acquireRelease(
        Effect.sync(() => events.push(`open ${id} ${config.name} ${httpRequest.method}`)),
        () => Effect.sync(() => events.push(`close ${id}`)),
      );
      return { id };
    }),
  );

const requestContext: RequestContextKey<Connection> = createContext();

const routeFactory = makeEffectRouteFactory()(() => ({
  runtime: ManagedRuntime.make(Layer.succeed(AppConfig)({ name: "app" })),
  requestContext,
}));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const build = makeBuild([
  route("connection", "connection", {
    loader: Effect.fn("connection")(function* () {
      return Response.json({ connection: (yield* Connection).id });
    }),
  }),
  route("empty", "empty", {
    loader: () => new Response(null, { status: 204 }),
  }),
  route("stream", "stream", {
    loader: Effect.fn("stream")(function* () {
      const { id } = yield* Connection;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of ["a", "b", "c"]) {
            controller.enqueue(encoder.encode(`${chunk}${id}`));
            await sleep(40);
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/plain" } });
    }),
  }),
]);

const app = ReactRouterHttp.make({
  build,
  factory: routeFactory,
  mode: "test",
  requestLayer: ConnectionLayer,
});

let runtime: ManagedRuntime.ManagedRuntime<HttpServer.HttpServer, unknown>;
let origin = "";

beforeAll(async () => {
  runtime = ManagedRuntime.make(
    Layer.unwrap(Effect.map(app, (served) => HttpServer.serve(served))).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
      Layer.provide(Logger.layer([capture])),
    ),
  );
  const address = (await runtime.runPromise(HttpServer.HttpServer)).address;
  if (address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
  origin = `http://localhost:${address.port}`;
});

afterAll(() => runtime.dispose());

beforeEach(() => {
  events.length = 0;
  logs.length = 0;
});

/** Waits until `events` has `count` entries, or 1s passes. */
const eventsReach = async (count: number) => {
  for (let waited = 0; events.length < count && waited < 1000; waited += 5) await sleep(5);
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("the Node adapter's request layer", () => {
  it("provides its services to route Effects, and closes after the response", async () => {
    const res = await fetch(`${origin}/connection`);
    expect(await res.json()).toEqual({ connection: connections });
    await eventsReach(2);
    expect(events).toEqual([`open ${connections} app GET`, `close ${connections}`]);
  });

  it("closes after a response without a body", async () => {
    const res = await fetch(`${origin}/empty`);
    expect(res.status).toBe(204);
    await eventsReach(2);
    expect(events).toEqual([`open ${connections} app GET`, `close ${connections}`]);
  });

  it("stays open while the body streams, and closes when it ends", async () => {
    const res = await fetch(`${origin}/stream`);
    const reader = res.body!.getReader();
    await reader.read();
    const id = connections;
    expect(events).toEqual([`open ${id} app GET`]);
    let chunk = await reader.read();
    while (!chunk.done) chunk = await reader.read();
    await eventsReach(2);
    expect(events).toEqual([`open ${id} app GET`, `close ${id}`]);
  });

  it("closes when the client leaves while the body streams", async () => {
    const controller = new AbortController();
    const res = await fetch(`${origin}/stream`, { signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();
    await eventsReach(2);
    expect(events).toEqual([`open ${connections} app GET`, `close ${connections}`]);
  });

  it("logs a layer that fails to build, and answers 500", async () => {
    const res = await fetch(`${origin}/layer-fails`);
    expect(res.status).toBe(500);
    expect(events).toEqual([]);
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([
      ["Error", "React Router adapter failed"],
    ]);
  });
});
