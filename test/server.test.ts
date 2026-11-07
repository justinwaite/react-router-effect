import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Context, Data, Effect, Layer, Logger, ManagedRuntime, Predicate } from "effect";
import {
  Headers as HttpHeaders,
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { createCookie, type ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeEffectRouteFactory, type EffectMiddlewareArgs } from "../src/index.ts";
import { ReactRouter } from "../src/server.ts";

// ---------------------------------------------------------------------------
// Fixtures: a factory, services, and a server build of resource routes.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class UnhandledError extends Data.TaggedError("UnhandledError")<{}> {}

/** Provided by an effect middleware around `next()`. */
class Greeting extends Context.Service<Greeting, { readonly text: string }>()("test/Greeting") {}

/** Set by an effect middleware with `context.set` before it calls `next()`. */
class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "test/CurrentUser",
) {}

const routeFactory = makeEffectRouteFactory<FormError | UnhandledError>()((Respond) => ({
  errorHandlers: {
    FormError: (error) => Respond.early({ reply: error.reply }, 422),
  },
  actionMeta: () => ({ requestId: "request-1" }),
}));
const { Respond } = routeFactory;
const store = routeFactory.handlers.requestContext;

/** The request signals the stream and slow routes saw, by the `id` query parameter. */
const signals = new Map<string, AbortSignal>();

/** The `id` query parameters of the slow loaders that were interrupted. */
const interrupted = new Set<string>();

/** Waits for `ms` milliseconds. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A body that sends three chunks 60ms apart, and records its request's signal. */
const streamingBody = (request: Request) => {
  signals.set(new URL(request.url).searchParams.get("id") ?? "", request.signal);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of ["data: a\n\n", "data: b\n\n", "data: c\n\n"]) {
        controller.enqueue(encoder.encode(chunk));
        await sleep(60);
      }
      controller.close();
    },
  });
};

const rootMiddleware = [
  // Provides a service around `next()`, for every effect downstream.
  Effect.fn("provideGreeting")(function* ({ next }: EffectMiddlewareArgs) {
    return yield* next().pipe(Effect.provideService(Greeting, { text: "hello" }));
  }),
  // Updates the request store with `context.set`, then calls `next()`.
  Effect.fn("setUser")(function* ({ context, next }: EffectMiddlewareArgs) {
    context.set(store, Context.add(context.get(store), CurrentUser, { id: "user-1" }));
    return yield* next();
  }),
];

/** A cookie written by React Router's own cookie API, with every attribute it writes. */
const sessionCookie = createCookie("rr_session", {
  path: "/",
  domain: "example.com",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 3600,
  expires: new Date("2030-01-01T00:00:00Z"),
  priority: "high",
  partitioned: true,
  secrets: ["s3cret"],
});

/** The `Set-Cookie` values the cookie route sends, by the `case` query parameter. */
const cookieValues = async (name: string | null): Promise<ReadonlyArray<string>> => {
  switch (name) {
    case "distinct":
      return ["session=a; Path=/; HttpOnly", "theme=dark; Path=/"];
    case "shared-name":
      return ["session=a; Path=/; HttpOnly", "session=b; Path=/admin; HttpOnly"];
    case "react-router":
      return [await sessionCookie.serialize({ user: "user-1" })];
    case "replaced":
      return ["s=; Path=/; Max-Age=0", "s=new; Path=/", "other=1; Path=/"];
    case "extension":
      return ["a=1; Path=/", "b=2; Path=/; Custom=x", "c=3; Path=/; Other=y"];
    case "invalid-name":
      // React Router's `createCookie` writes these names; Effect's parser rejects them.
      return ["app/session=1; Path=/", "user:prefs=dark; Path=/", "theme=dark; Path=/"];
    default:
      return [];
  }
};

/** A route module of the fixture build, as the build plugin collects its exports. */
type RouteModule = Record<string, unknown>;

/** A route of the fixture build. */
const route = (id: string, path: string, module: RouteModule) => ({
  id,
  path,
  parentId: "root",
  module,
});

const routes = {
  root: { id: "root", path: "", module: { default: () => null, middleware: rootMiddleware } },
  effectLoader: route("effectLoader", "effect-loader", {
    loader: Effect.fn("effectLoader")(function* ({ url }: { readonly url: URL }) {
      const greeting = yield* Greeting;
      const user = yield* CurrentUser;
      return Response.json({ greeting: greeting.text, user: user.id, path: url.pathname });
    }),
  }),
  promiseLoader: route("promiseLoader", "promise-loader", {
    loader: async () => Response.json({ plain: true }),
  }),
  recovered: route("recovered", "recovered", {
    loader: Effect.fn("recovered")(function* () {
      return yield* new FormError({ reply: "invalid" });
    }),
  }),
  unhandled: route("unhandled", "unhandled", {
    loader: Effect.fn("unhandled")(function* () {
      return yield* new UnhandledError();
    }),
  }),
  redirect: route("redirect", "redirect", {
    loader: Effect.fn("redirect")(function* () {
      return yield* Respond.redirect("/elsewhere", 303);
    }),
  }),
  stream: route("stream", "stream", {
    loader: ({ request }: { readonly request: Request }) =>
      new Response(streamingBody(request), { headers: { "content-type": "text/event-stream" } }),
  }),
  slow: route("slow", "slow", {
    loader: ({ request }: { readonly request: Request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      signals.set(id, request.signal);
      return Effect.sleep("300 millis").pipe(
        Effect.as(Response.json({ slow: true })),
        Effect.onInterrupt(() => Effect.sync(() => interrupted.add(id))),
      );
    },
  }),
  untyped: route("untyped", "untyped", {
    // A stream body gives the Web response no content type.
    loader: () => new Response(new Blob(["<p>hi</p>"]).stream()),
  }),
  cookies: route("cookies", "cookies", {
    loader: async ({ request }: { readonly request: Request }) => {
      const headers = new Headers();
      for (const value of await cookieValues(new URL(request.url).searchParams.get("case"))) {
        headers.append("set-cookie", value);
      }
      return new Response("ok", { headers });
    },
  }),
  cookieRedirect: route("cookieRedirect", "cookie-redirect", {
    loader: async () => {
      const headers = new Headers({ location: "/elsewhere" });
      for (const value of await cookieValues("distinct")) headers.append("set-cookie", value);
      return new Response(null, { status: 303, headers });
    },
  }),
  origin: route("origin", "origin", {
    loader: ({ request }: { readonly request: Request }) =>
      Response.json({ url: request.url, signal: request.signal instanceof AbortSignal }),
  }),
  splat: route("splat", "*", {
    loader: ({ request }: { readonly request: Request }) => Response.json({ url: request.url }),
  }),
  echo: route("echo", "echo", {
    action: async ({ request }: { readonly request: Request }) =>
      Response.json({ body: await request.text() }),
  }),
  effectAction: route("effectAction", "effect-action", {
    action: Effect.fn("effectAction")(function* () {
      return Response.json(yield* Effect.succeed({ saved: true }));
    }),
  }),
  page: route("page", "page", {
    default: () => null,
    loader: Effect.fn("page")(() =>
      Effect.sync(() => ({ now: "first", later: sleep(50).then(() => "streamed later") })),
    ),
    action: Effect.fn("pageAction")(() => Effect.succeed({ saved: true })),
  }),
  plainPage: route("plainPage", "plain-page", {
    default: () => null,
    action: async () => ({ saved: "plain" }),
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

/**
 * Applies proxy headers as an app's own server middleware would, with
 * `request.modify`. The adapter builds the Web request from the result.
 */
const proxyHeaders = HttpMiddleware.make((httpApp) =>
  Effect.updateService(httpApp, HttpServerRequest.HttpServerRequest, (request) => {
    const host = request.headers["x-test-host"];
    return host === undefined
      ? request
      : request.modify({
          headers: HttpHeaders.set(request.headers, "host", host),
          protocol: "https",
        });
  }),
);

/**
 * Changes React Router's response as an app's own router middleware would,
 * by the `x-test-outer` header: `add-cookie` adds a cookie through Effect's
 * cookie API, `same-name` adds one with the name of a React Router cookie,
 * `read-cookies` lists the names of the response's cookies in a header,
 * `raw-header` sets a `set-cookie` header,
 * `replace` sends a 503 in place of React Router's response, and `fail` dies
 * after React Router answered.
 */
const OuterResponse = HttpRouter.middleware((httpApp) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* httpApp;
    switch (request.headers["x-test-outer"]) {
      case "add-cookie":
        return HttpServerResponse.setCookieUnsafe(response, "outer", "1");
      case "same-name":
        return HttpServerResponse.setCookieUnsafe(response, "session", "outer");
      case "read-cookies":
        return HttpServerResponse.setHeader(
          response,
          "x-cookie-names",
          Object.keys(response.cookies.cookies).join(","),
        );
      case "raw-header":
        return HttpServerResponse.setHeader(response, "set-cookie", "raw=1; Path=/");
      case "replace":
        return HttpServerResponse.empty({ status: 503 });
      case "fail":
        return yield* Effect.die(new Error("outer middleware failed"));
      default:
        return response;
    }
  }),
).layer;

/** React Router with the response middleware, and compression for every route. */
const App = Layer.mergeAll(
  ReactRouter.routes.pipe(Layer.provide(OuterResponse)),
  HttpRouter.middleware(HttpMiddleware.compression(), { global: true }),
).pipe(Layer.provide(ReactRouter.layer({ build, factory: routeFactory, mode: "test" })));

const ServerLive = HttpRouter.serve(App, {
  disableLogger: true,
  disableListenLog: true,
  middleware: proxyHeaders,
}).pipe(Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })));

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

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("route functions", () => {
  it("runs an Effect loader with services provided around next() and set with context.set", async () => {
    const response = await fetch(`${origin}/effect-loader`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      greeting: "hello",
      user: "user-1",
      path: "/effect-loader",
    });
  });

  it("passes a promise loader through unchanged", async () => {
    const response = await fetch(`${origin}/promise-loader`);
    expect(await response.json()).toEqual({ plain: true });
  });

  it("recovers a domain error through the factory's handler", async () => {
    const response = await fetch(`${origin}/recovered`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ reply: "invalid" });
  });

  it("turns an unhandled domain error into a 500", async () => {
    const response = await fetch(`${origin}/unhandled`);
    expect(response.status).toBe(500);
  });

  it("redirects through Respond.redirect", async () => {
    const response = await fetch(`${origin}/redirect`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/elsewhere");
  });
});

/** Posts a body, and when `expectContinue` is set, sends it only after the server's 100 Continue. */
const postBody = (path: string, body: string, expectContinue: boolean) =>
  new Promise<{ readonly continued: boolean; readonly body: string }>((resolve, reject) => {
    let continued = false;
    const request = Http.request(`${origin}${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(body)),
        ...(expectContinue ? { expect: "100-continue" } : {}),
      },
    });
    request.on("continue", () => {
      continued = true;
      request.end(body);
    });
    request.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve({ continued, body: text }));
    });
    request.on("error", reject);
    // Without a 100 Continue, a client that expects it would wait for its timeout.
    request.setTimeout(2000, () => reject(new Error("No 100 Continue")));
    if (!expectContinue) request.end(body);
  });

describe("request bodies", () => {
  it("reads a request body", async () => {
    const response = await postBody("/echo", "x".repeat(100_000), false);
    expect(JSON.parse(response.body)).toEqual({ body: "x".repeat(100_000) });
  });

  it("sends 100 Continue to a request that expects it, when the body is read", async () => {
    const response = await postBody("/echo", "hello", true);
    expect(response.continued).toBe(true);
    expect(JSON.parse(response.body)).toEqual({ body: "hello" });
  });
});

describe("single fetch", () => {
  it("streams a promise in loader data after the first chunk", async () => {
    const response = await fetch(`${origin}/page.data`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-script");
    const body = await response.text();
    expect(body).toContain("first");
    expect(body).toContain("streamed later");
  });

  it("attaches the action metadata to Effect and plain actions", async () => {
    const effectAction = await fetch(`${origin}/page.data`, {
      method: "POST",
      headers: { origin },
    });
    expect(await effectAction.text()).toContain("request-1");
    const plainAction = await fetch(`${origin}/plain-page.data`, {
      method: "POST",
      headers: { origin },
    });
    const plainBody = await plainAction.text();
    expect(plainBody).toContain("plain");
    expect(plainBody).toContain("request-1");
  });
});

describe("responses", () => {
  it("writes every Set-Cookie value", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`);
    expect(response.headers.getSetCookie()).toEqual(await cookieValues("distinct"));
  });

  it("sends application/octet-stream for a body without a content type, as Effect does", async () => {
    const response = await fetch(`${origin}/untyped`);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(await response.text()).toBe("<p>hi</p>");
  });

  it("keeps the last of two cookies that share a name, as Effect does", async () => {
    const response = await fetch(`${origin}/cookies?case=shared-name`);
    expect(response.headers.getSetCookie()).toEqual(["session=b; Path=/admin; HttpOnly"]);
  });

  it("keeps the last value of a cookie that is expired and set again", async () => {
    const response = await fetch(`${origin}/cookies?case=replaced`);
    expect(response.headers.getSetCookie()).toEqual(["s=new; Path=/", "other=1; Path=/"]);
  });

  it("gives an outer middleware React Router's cookies in response.cookies", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "read-cookies" },
    });
    expect(response.headers.get("x-cookie-names")).toBe("session,theme");
  });

  it("writes React Router's cookies with one an outer middleware adds", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "add-cookie" },
    });
    expect(response.headers.getSetCookie()).toEqual([
      ...(await cookieValues("distinct")),
      "outer=1",
    ]);
  });

  it("writes none of React Router's cookies when an outer middleware replaces the response", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "replace" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("writes the cookie an outer middleware sets in place of React Router's cookie with that name", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "same-name" },
    });
    expect(response.headers.getSetCookie()).toEqual(["session=outer", "theme=dark; Path=/"]);
  });

  it("writes React Router's cookies with a set-cookie header an outer middleware sets", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "raw-header" },
    });
    expect(response.headers.getSetCookie()).toEqual([
      ...(await cookieValues("distinct")),
      "raw=1; Path=/",
    ]);
  });

  it("writes none of React Router's cookies when an outer middleware fails after React Router answered", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "x-test-outer": "fail" },
    });
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("writes React Router's cookies on a redirect", async () => {
    const response = await fetch(`${origin}/cookie-redirect`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/elsewhere");
    expect(response.headers.getSetCookie()).toEqual(await cookieValues("distinct"));
  });

  it("writes React Router's cookies on a HEAD request", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(await cookieValues("distinct"));
  });

  it("writes React Router's cookies on a compressed response", async () => {
    const response = await fetch(`${origin}/cookies?case=distinct`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.getSetCookie()).toEqual(await cookieValues("distinct"));
    expect(await response.text()).toBe("ok");
  });

  it("writes a React Router cookie with every attribute it has", async () => {
    const response = await fetch(`${origin}/cookies?case=react-router`);
    /** The parts of a `Set-Cookie` value, in any order: Effect writes `Priority` earlier. */
    const parts = (value: string | undefined) => value?.split("; ").toSorted();
    const [sent] = response.headers.getSetCookie();
    const [made] = await cookieValues("react-router");
    expect(parts(sent)).toEqual(parts(made));
  });

  it("drops attributes Effect does not know", async () => {
    const response = await fetch(`${origin}/cookies?case=extension`);
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/", "c=3; Path=/"]);
  });

  it("builds the request URL from the request the app's middleware modified", async () => {
    const response = await fetch(`${origin}/origin?x=1`, {
      headers: { "x-test-host": "app.example.com" },
    });
    expect(await response.json()).toEqual({
      url: "https://app.example.com/origin?x=1",
      signal: true,
    });
  });

  it("keeps a request target that starts with // on the request's host", async () => {
    const { port } = new URL(origin);
    const body = await new Promise<string>((resolve, reject) => {
      Http.get({ host: "localhost", port, path: "//evil.example/x" }, (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    const { url } = JSON.parse(body) as { readonly url: string };
    expect(new URL(url).host).toBe(`localhost:${port}`);
    expect(new URL(url).pathname).toBe("//evil.example/x");
  });

  it("streams a compressed body chunk by chunk", async () => {
    const started = performance.now();
    const response = await fetch(`${origin}/stream?id=compressed`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a body");
    const first = await reader.read();
    const firstAt = performance.now() - started;
    expect(new TextDecoder().decode(first.value)).toBe("data: a\n\n");
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += new TextDecoder().decode(chunk.value);
    }
    const endAt = performance.now() - started;
    expect(rest).toBe("data: b\n\ndata: c\n\n");
    // The first chunk arrives well before the body ends, so nothing buffered it.
    expect(endAt - firstAt).toBeGreaterThan(80);
  });

  it("does not abort the request signal of a completed response", async () => {
    const response = await fetch(`${origin}/stream?id=complete`);
    await response.text();
    await sleep(20);
    expect(signals.get("complete")?.aborted).toBe(false);
  });

  it("aborts the request signal when the client leaves while the body streams", async () => {
    const controller = new AbortController();
    const response = await fetch(`${origin}/stream?id=abandoned`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await sleep(100);
    expect(signals.get("abandoned")?.aborted).toBe(true);
  });

  it("aborts the request signal and interrupts the loader when the client leaves while it runs", async () => {
    const controller = new AbortController();
    const response = fetch(`${origin}/slow?id=left`, { signal: controller.signal });
    await sleep(50);
    controller.abort();
    await expect(response).rejects.toThrow();
    await sleep(50);
    expect(signals.get("left")?.aborted).toBe(true);
    expect(interrupted.has("left")).toBe(true);
  });

  it("neither aborts nor interrupts a loader that finishes", async () => {
    const response = await fetch(`${origin}/slow?id=finished`);
    expect(await response.json()).toEqual({ slow: true });
    expect(signals.get("finished")?.aborted).toBe(false);
    expect(interrupted.has("finished")).toBe(false);
  });
});

describe("adapter errors", () => {
  /** What the app's loggers received: each log's level and its message parts. */
  const logs: Array<{ readonly level: string; readonly message: ReadonlyArray<unknown> }> = [];
  const capture = Logger.make(({ logLevel, message }) => {
    logs.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
  });

  /**
   * Serves React Router with `options` and the capturing logger, and with
   * the server's request logger when asked.
   */
  const start = async (options: ReactRouter.Options, withRequestLogger = false) => {
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(ReactRouter.routes.pipe(Layer.provide(ReactRouter.layer(options))), {
        disableLogger: !withRequestLogger,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
        Layer.provide(Logger.layer([capture])),
      ),
    );
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (Predicate.isTagged(server.address, "UnixPathAddress"))
      throw new Error("Expected a TCP address");
    return { origin: `http://localhost:${server.address.port}`, stop: () => runtime.dispose() };
  };

  /** The error a log's message carries, if any. */
  const errorOf = (log: (typeof logs)[number]) => log.message.find((part) => part instanceof Error);

  it("logs the error once with the server's request logger, which logs the 500 it sent", async () => {
    const served = await start(
      {
        build,
        factory: routeFactory,
        mode: "test",
        loadContext: () => Effect.die(new Error("load context failed")),
      },
      true,
    );
    logs.length = 0;
    const response = await fetch(`${served.origin}/promise-loader`);
    await served.stop();
    expect(response.status).toBe(500);
    expect(logs.map((log) => [log.level, log.message[0]])).toEqual([
      ["Error", "React Router adapter failed"],
      ["Info", "Sent HTTP response"],
    ]);
  });

  it("logs the names of the cookies that Effect cannot send, and sends the others", async () => {
    const served = await start({ build, factory: routeFactory, mode: "test" });
    logs.length = 0;
    const response = await fetch(`${served.origin}/cookies?case=invalid-name`);
    await served.stop();
    expect(response.headers.getSetCookie()).toEqual(["theme=dark; Path=/"]);
    expect(logs.map((log) => [log.level, ...log.message])).toEqual([
      [
        "Error",
        "React Router adapter dropped cookies that Effect cannot send",
        ["app/session", "user:prefs"],
      ],
    ]);
  });

  it("logs a development build that does not load, and answers 500", async () => {
    const served = await start({
      build: () => Promise.reject(new Error("build failed")),
      factory: routeFactory,
      mode: "development",
    });
    logs.length = 0;
    const response = await fetch(`${served.origin}/promise-loader`);
    await served.stop();
    expect(response.status).toBe(500);
    expect(errorOf(logs[0]!)?.message).toBe("build failed");
  });
});
