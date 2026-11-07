import * as Http from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import * as ReactRouterAssets from "../src/assets.ts";
import { makeEffectRouteFactory } from "../src/index.ts";
import * as ReactRouterHttp from "../src/server.ts";
import * as ReactRouterVite from "../src/vite.ts";

const { ReactRouter } = ReactRouterHttp;

const directory = mkdtempSync(join(tmpdir(), "client-assets-"));
mkdirSync(join(directory, "assets"));
mkdirSync(join(directory, "nested"));
mkdirSync(join(directory, ".vite"));
writeFileSync(join(directory, "assets", "entry-abc123.js"), "export {};");
writeFileSync(join(directory, "favicon.svg"), "<svg />");
// React Router writes a prerendered page to the index.html of its path's directory.
mkdirSync(join(directory, "prerendered"));
writeFileSync(join(directory, "prerendered", "index.html"), "<p>prerendered</p>");
writeFileSync(join(directory, ".vite", "manifest.json"), "{}");
writeFileSync(join(directory, "read me.txt"), "spaced");

const routeFactory = makeEffectRouteFactory()(() => ({}));

/** A build of one resource route that answers every path, so a request React Router gets is visible. */
const makeBuild = (overrides: Partial<ServerBuild> = {}): ServerBuild => {
  const routes = {
    root: { id: "root", path: "", module: { default: () => null } },
    any: {
      id: "any",
      path: "*",
      parentId: "root",
      module: {
        loader: Effect.fn("any")(({ request }: { readonly request: Request }) =>
          Effect.succeed(new Response(`router ${new URL(request.url).pathname}`)),
        ),
        action: () => new Response("router action"),
      },
    },
  };
  return {
    entry: { module: { default: () => new Response("document") } },
    routes: routes as unknown as ServerBuild["routes"],
    assets: {
      entry: { imports: [], module: "/entry.client.js" },
      routes: {},
      url: "/manifest.js",
      version: "test",
    },
    publicPath: "/",
    assetsBuildDirectory: directory,
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
    ...overrides,
  };
};

/** Makes an app and starts it on a free port; returns its origin and a function that stops it. */
const start = async (
  make: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unknown,
      HttpServerRequest.HttpServerRequest
    >,
    unknown,
    ReactRouterHttp.ClientAssetServices
  >,
) => {
  const runtime = ManagedRuntime.make(
    Layer.unwrap(Effect.map(make, (app) => HttpServer.serve(app))).pipe(
      Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
    ),
  );
  const server = await runtime.runPromise(HttpServer.HttpServer);
  if (server.address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
  return { origin: `http://localhost:${server.address.port}`, stop: () => runtime.dispose() };
};

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("client assets", () => {
  let served: Awaited<ReturnType<typeof start>>;
  let underPrefix: Awaited<ReturnType<typeof start>>;
  let development: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    const options = { factory: routeFactory, mode: "production", clientAssets: true } as const;
    served = await start(ReactRouterHttp.make({ ...options, build: makeBuild() }));
    underPrefix = await start(
      ReactRouterHttp.make({ ...options, build: makeBuild({ publicPath: "/static/" }) }),
    );
    development = await start(
      ReactRouterHttp.make({
        ...options,
        build: makeBuild({
          assets: { ...makeBuild().assets, hmr: { runtime: "/@id/__x00__virtual:hmr" } },
        }),
      }),
    );
  });

  afterAll(() => Promise.all([served.stop(), underPrefix.stop(), development.stop()]));

  it("caches hashed assets for a year as immutable", async () => {
    const response = await fetch(`${served.origin}/assets/entry-abc123.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("export {};");
  });

  it("sends the same file and headers on later requests for a file", async () => {
    const responses = [];
    for (let request = 0; request < 3; request++) {
      responses.push(await fetch(`${served.origin}/assets/entry-abc123.js`));
    }
    const headers = (response: Response) =>
      ["content-type", "content-length", "etag", "last-modified", "cache-control"].map((name) =>
        response.headers.get(name),
      );
    for (const response of responses) {
      expect(headers(response)).toEqual(headers(responses[0] as Response));
      expect(await response.text()).toBe("export {};");
    }
  });

  it("answers a revalidation with 304 and a range with 206", async () => {
    const first = await fetch(`${served.origin}/favicon.svg`);
    const etag = first.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const revalidated = await fetch(`${served.origin}/favicon.svg`, {
      headers: { "if-none-match": etag },
    });
    expect(revalidated.status).toBe(304);
    const range = await fetch(`${served.origin}/favicon.svg`, { headers: { range: "bytes=0-3" } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("<svg");
  });

  it("answers HEAD without a body", async () => {
    await fetch(`${served.origin}/favicon.svg`);
    const response = await fetch(`${served.origin}/favicon.svg`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("7");
    expect(await response.text()).toBe("");
  });

  it("caches other client files for an hour", async () => {
    const response = await fetch(`${served.origin}/favicon.svg`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
  });

  it.each([
    ["a missing file", "/assets/missing.js", "GET", "router /assets/missing.js"],
    ["a directory without an index file", "/nested/", "GET", "router /nested/"],
    // The root route answers `/` with the document.
    ["the root without an index file", "/", "GET", "document"],
    ["a dotfile", "/.vite/manifest.json", "GET", "router /.vite/manifest.json"],
    ["an encoded dotfile", "/%2evite/manifest.json", "GET", "router /%2evite/manifest.json"],
    ["a POST", "/favicon.svg", "POST", "router action"],
  ])("passes %s on to React Router", async (_, path, method, expected) => {
    const response = await fetch(`${served.origin}${path}`, {
      method,
      headers: { origin: served.origin },
    });
    expect(await response.text()).toBe(expected);
  });

  it("serves a directory's index file, such as a prerendered page, as express.static does", async () => {
    const response = await fetch(`${served.origin}/prerendered/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.text()).toBe("<p>prerendered</p>");
  });

  it("redirects a directory path without its trailing slash, as express.static does", async () => {
    const page = await fetch(`${served.origin}/prerendered?x=1`, { redirect: "manual" });
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe("/prerendered/?x=1");
    const empty = await fetch(`${served.origin}/nested`, { redirect: "manual" });
    expect(empty.status).toBe(301);
    expect(empty.headers.get("location")).toBe("/nested/");
    const prefixed = await fetch(`${underPrefix.origin}/static/prerendered`, {
      redirect: "manual",
    });
    expect(prefixed.headers.get("location")).toBe("/static/prerendered/");
  });

  it("serves the root's index file, such as a prerendered home page", async () => {
    const root = mkdtempSync(join(tmpdir(), "client-assets-root-"));
    writeFileSync(join(root, "index.html"), "<p>home</p>");
    const app = await start(
      ReactRouterHttp.make({
        build: makeBuild({ assetsBuildDirectory: root }),
        factory: routeFactory,
        mode: "production",
        clientAssets: true,
      }),
    );
    const response = await fetch(`${app.origin}/`);
    await app.stop();
    rmSync(root, { recursive: true, force: true });
    expect(await response.text()).toBe("<p>home</p>");
  });

  it("serves a file added after the server started, as express.static does", async () => {
    writeFileSync(join(directory, "late.txt"), "late");
    expect(await (await fetch(`${served.origin}/late.txt`)).text()).toBe("late");
  });

  it("serves a file whose name the URL encodes", async () => {
    expect(await (await fetch(`${served.origin}/read%20me.txt`)).text()).toBe("spaced");
  });

  it("serves the files under the build's publicPath", async () => {
    const response = await fetch(`${underPrefix.origin}/static/assets/entry-abc123.js`);
    expect(await response.text()).toBe("export {};");
    expect(await (await fetch(`${underPrefix.origin}/assets/entry-abc123.js`)).text()).toBe(
      "router /assets/entry-abc123.js",
    );
  });

  it("leaves a development build's client to Vite", async () => {
    const response = await fetch(`${development.origin}/assets/entry-abc123.js`);
    expect(await response.text()).toBe("router /assets/entry-abc123.js");
  });

  it("fails the server's start when it cannot read the client build, with the resolved directory", async () => {
    const make = ReactRouterHttp.make({
      build: makeBuild({ assetsBuildDirectory: "missing/client" }),
      factory: routeFactory,
      mode: "production",
      clientAssets: true,
    });
    await expect(start(make)).rejects.toMatchObject({
      _tag: "ClientBuildError",
      directory: join(process.cwd(), "missing/client"),
      message: `Cannot read the client build at ${join(process.cwd(), "missing/client")}`,
    });
  });
});

describe("build loading", () => {
  it("loads a production build once, and a development build for each request", async () => {
    const loads = { production: 0, development: 0 };
    const servers = await Promise.all(
      (["production", "development"] as const).map((mode) =>
        start(
          ReactRouterHttp.make({
            build: () => {
              loads[mode] += 1;
              return makeBuild();
            },
            factory: routeFactory,
            mode,
          }),
        ),
      ),
    );
    for (const server of servers) {
      for (let request = 0; request < 3; request++) await fetch(`${server.origin}/a`);
    }
    await Promise.all(servers.map((server) => server.stop()));
    expect(loads).toEqual({ production: 1, development: 3 });
  });
});

describe("Vite dev middleware", () => {
  let dev: Awaited<ReturnType<typeof start>>;

  /** Answers `/@vite/client` after a delay, fails `/broken`, and passes on the rest. */
  const vite: ReactRouterVite.ViteDevServer = {
    middlewares: (request, response, next) => {
      if (request.url === "/@vite/client") {
        setTimeout(() => {
          response.setHeader("content-type", "text/javascript");
          response.end("// vite client");
        }, 20);
        return;
      }
      if (request.url === "/broken") return next(new Error("transform failed"));
      next();
    },
  };

  beforeAll(async () => {
    dev = await start(
      ReactRouterHttp.make({ build: makeBuild(), factory: routeFactory, mode: "development" }).pipe(
        Effect.map(ReactRouterVite.devMiddleware(vite)),
      ),
    );
  });

  afterAll(() => dev.stop());

  it("serves what Vite answers", async () => {
    const response = await fetch(`${dev.origin}/@vite/client`);
    expect(response.headers.get("content-type")).toBe("text/javascript");
    expect(await response.text()).toBe("// vite client");
  });

  it("passes what Vite does not answer on to React Router", async () => {
    expect(await (await fetch(`${dev.origin}/todos`)).text()).toBe("router /todos");
  });

  it("fails the request when Vite fails", async () => {
    expect((await fetch(`${dev.origin}/broken`)).status).toBe(500);
  });
});

describe("ReactRouterAssets.layer", () => {
  /** The assets manifest of a build whose hashed files are in `assets/`. */
  const hashedAssets = { ...makeBuild().assets, url: "/assets/manifest-abc123.js" };

  /** Sets a header on React Router's responses only, as a route-scoped middleware. */
  const RouteHeader = HttpRouter.middleware((app) =>
    Effect.map(app, HttpServerResponse.setHeader("x-route-middleware", "react-router")),
  ).layer;

  /** The messages of the app's logs. */
  const messages: Array<unknown> = [];
  const capture = Logger.make(({ message }) => {
    messages.push(Array.isArray(message) ? message[0] : message);
  });

  /** The number of requests that the server's request logger logged. */
  const requestLogs = () => messages.filter((message) => message === "Sent HTTP response").length;

  /**
   * Serves React Router and the assets layer with `options`, with the
   * server's request logger, and starts it on a free port.
   */
  const startApp = async (options: ReactRouterHttp.ReactRouter.Options) => {
    const App = Layer.mergeAll(
      ReactRouter.routes.pipe(Layer.provide(RouteHeader)),
      ReactRouterAssets.layer.pipe(Layer.provide(HttpRouter.disableLogger)),
      HttpRouter.middleware(HttpMiddleware.compression({ minSize: 0 }), { global: true }),
    ).pipe(Layer.provide(ReactRouter.layer(options)));
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(App, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
        Layer.provide(Logger.layer([capture])),
      ),
    );
    const server = await runtime.runPromise(HttpServer.HttpServer);
    if (server.address._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
    const port = server.address.port;
    return { port, origin: `http://localhost:${port}`, stop: () => runtime.dispose() };
  };

  /** Sends a GET request for `path` as it is: `fetch` resolves the dot segments of a URL first. */
  const rawGet = (port: number, path: string) =>
    new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
      Http.get({ host: "localhost", port, path }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }).on("error", reject);
    });

  const options = { factory: routeFactory, mode: "production" } as const;
  let served: Awaited<ReturnType<typeof startApp>>;
  let underPrefix: Awaited<ReturnType<typeof startApp>>;
  let withoutHashed: Awaited<ReturnType<typeof startApp>>;
  let development: Awaited<ReturnType<typeof startApp>>;

  beforeAll(async () => {
    served = await startApp({ ...options, build: makeBuild({ assets: hashedAssets }) });
    underPrefix = await startApp({
      ...options,
      build: makeBuild({
        publicPath: "/static/",
        assets: { ...hashedAssets, url: "/static/assets/manifest-abc123.js" },
      }),
    });
    withoutHashed = await startApp({ ...options, build: makeBuild() });
    // The client build directory does not exist, so a read of it would fail the start.
    development = await startApp({
      factory: routeFactory,
      mode: "development",
      build: () => makeBuild({ assets: hashedAssets, assetsBuildDirectory: "missing/client" }),
    });
  });

  afterAll(() =>
    Promise.all([served.stop(), underPrefix.stop(), withoutHashed.stop(), development.stop()]),
  );

  it("caches a hashed file for a year as immutable, for GET and HEAD", async () => {
    const get = await fetch(`${served.origin}/assets/entry-abc123.js`);
    expect(get.status).toBe(200);
    expect(get.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await get.text()).toBe("export {};");
    // Without compression, so that the length of the file is in the headers.
    const head = await fetch(`${served.origin}/assets/entry-abc123.js`, {
      method: "HEAD",
      headers: { "accept-encoding": "identity" },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
  });

  it("answers 404 for a file that the hashed directory does not have", async () => {
    const response = await fetch(`${served.origin}/assets/missing.js`);
    expect(response.status).toBe(404);
  });

  it.each(["/assets/../.vite/manifest.json", "/assets/%2e%2e/.vite/manifest.json"])(
    "serves no file outside the hashed directory for %s",
    async (path) => {
      const response = await rawGet(served.port, path);
      expect(response.status).toBe(404);
      expect(response.body).not.toBe("{}");
    },
  );

  it("passes a document request on to React Router", async () => {
    const response = await fetch(`${served.origin}/some/page`);
    expect(await response.text()).toBe("router /some/page");
  });

  it("serves the hashed directory under the build's publicPath", async () => {
    const response = await fetch(`${underPrefix.origin}/static/assets/entry-abc123.js`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("export {};");
    expect(await (await fetch(`${underPrefix.origin}/assets/entry-abc123.js`)).text()).toBe(
      "router /assets/entry-abc123.js",
    );
  });

  it("registers no hashed directory for a manifest at the root of publicPath", async () => {
    const response = await fetch(`${withoutHashed.origin}/assets/entry-abc123.js`);
    expect(await response.text()).toBe("router /assets/entry-abc123.js");
  });

  it("registers nothing and reads nothing for a development build", async () => {
    const response = await fetch(`${development.origin}/assets/entry-abc123.js`);
    expect(await response.text()).toBe("router /assets/entry-abc123.js");
  });

  it("fails with a ClientBuildError when it cannot read the client build", async () => {
    await expect(
      startApp({
        ...options,
        build: makeBuild({ assets: hashedAssets, assetsBuildDirectory: "missing/client" }),
      }),
    ).rejects.toMatchObject({
      _tag: "ClientBuildError",
      directory: join(process.cwd(), "missing/client"),
      message: `Cannot read the client build at ${join(process.cwd(), "missing/client")}`,
    });
  });

  it("runs the middleware of React Router's routes on documents only", async () => {
    const file = await fetch(`${served.origin}/assets/entry-abc123.js`);
    expect(file.headers.get("x-route-middleware")).toBe(null);
    const page = await fetch(`${served.origin}/some/page`);
    expect(page.headers.get("x-route-middleware")).toBe("react-router");
  });

  it("logs a file that it cannot read, and answers an empty 500", async () => {
    const locked = join(directory, "assets", "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "entry-def456.js"), "export {};");
    chmodSync(locked, 0o000);
    try {
      messages.length = 0;
      const response = await fetch(`${served.origin}/assets/locked/entry-def456.js`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(messages).toContain("Cannot serve a client file");
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true });
    }
  });

  it("logs no file request under HttpRouter.disableLogger", async () => {
    messages.length = 0;
    await (await fetch(`${served.origin}/assets/entry-abc123.js`)).text();
    await (await fetch(`${served.origin}/some/page`)).text();
    await vi.waitFor(() => expect(requestLogs()).toBeGreaterThan(0));
    expect(requestLogs()).toBe(1);
  });

  it("compresses a file response with a global compression middleware", async () => {
    const response = await fetch(`${served.origin}/assets/entry-abc123.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.text()).toBe("export {};");
  });
});
