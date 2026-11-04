/**
 * The cost of the adapter for one request, in one process: the adapter on
 * Effect's Node HTTP server against `@react-router/node`'s request listener,
 * both on loopback, with the same client. Both read the full body. Each
 * request is new, since a body is read once. `bench/http.ts` measures the
 * servers under load, each in its own process.
 *
 * Run it with `NODE_ENV=production`, as `vp run bench` does: Vitest then
 * resolves the production builds of React and React Router, as a server in
 * production runs them.
 */
import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createRequestListener } from "@react-router/node";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpServer } from "effect/http";
import { afterAll, expect, test } from "vite-plus/test";

import { baselineBuild, baselineContext, cases, loadServer } from "./servers.ts";

if (process.env.NODE_ENV !== "production") {
  throw new Error("Run the benchmarks with NODE_ENV=production: vp run bench");
}

const server = await loadServer();

/** The adapter on Effect's Node HTTP server, on a free port. */
const adapterRuntime = ManagedRuntime.make(
  Layer.unwrap(Effect.map(server.reactRouterApp, (app) => HttpServer.serve(app))).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => Http.createServer(), { port: 0 })),
  ),
);
const adapterAddress = (await adapterRuntime.runPromise(HttpServer.HttpServer)).address;
if (adapterAddress._tag === "UnixPathAddress") throw new Error("Expected a TCP address");
const adapterOrigin = `http://localhost:${adapterAddress.port}`;

/** `@react-router/node` on `node:http`, on a free port. */
const build = await baselineBuild(server);
const baselineServer = Http.createServer(
  createRequestListener({
    build,
    mode: "production",
    getLoadContext: (request) =>
      baselineContext(server, request.headers.get("x-request-id") ?? undefined),
  }),
);
await new Promise<void>((resolve) => baselineServer.listen(0, resolve));
const baselineAddress = baselineServer.address();
if (typeof baselineAddress !== "object" || baselineAddress === null) {
  throw new Error("Expected a TCP address");
}
const baselineOrigin = `http://localhost:${baselineAddress.port}`;

afterAll(async () => {
  baselineServer.close();
  await adapterRuntime.dispose();
});

for (const { name, path, ...init } of cases(adapterOrigin)) {
  const request = (origin: string) =>
    fetch(`${origin}${path}`, {
      ...init,
      // The action's origin check compares the Origin header with the host it reached.
      headers: { ...init.headers, ...(init.headers?.origin === undefined ? {} : { origin }) },
    });
  test(name, async ({ bench }) => {
    // A benchmark of a failing request would measure the failure.
    expect((await request(adapterOrigin)).status).toBe(200);
    expect((await request(baselineOrigin)).status).toBe(200);
    await bench.compare(
      bench("@react-router/node", async () => {
        await (await request(baselineOrigin)).arrayBuffer();
      }),
      bench("react-router-effect", async () => {
        await (await request(adapterOrigin)).arrayBuffer();
      }),
    );
  });
}
