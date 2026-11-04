import * as Http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpServer, type HttpServerRequest, type HttpServerResponse } from "effect/http";
import type { ServerBuild } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { makeEffectRouteFactory } from "../src/index.ts";
import * as ReactRouterHttp from "../src/server.ts";
import * as ReactRouterVite from "../src/vite.ts";

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
