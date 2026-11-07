/**
 * The adapter in workerd, Cloudflare's runtime. Vite bundles the Worker of
 * `test/workerd/worker.ts`, and Miniflare runs it and sends it requests.
 */
import { fileURLToPath } from "node:url";

import { Schema } from "effect";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

/** Bundles the Worker into one ES module, as a Worker's bundler does. */
const bundleWorker = async (): Promise<string> => {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    // React's entry reads `process.env.NODE_ENV`, which a Worker's bundler replaces.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    ssr: { target: "webworker", noExternal: true },
    build: {
      write: false,
      ssr: fileURLToPath(new URL("workerd/worker.ts", import.meta.url)),
      minify: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    for (const chunk of output.output) {
      if (chunk.type === "chunk" && chunk.isEntry) return chunk.code;
    }
  }
  throw new Error("Vite did not bundle the Worker");
};

let worker: Miniflare;

beforeAll(async () => {
  // Miniflare 5 takes the options of one Worker in the shape of Miniflare 4 through this function.
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await bundleWorker(),
      compatibilityDate: "2026-10-01",
      // Aborts the request's signal when the client leaves.
      compatibilityFlags: ["enable_request_signal"],
      bindings: { GREETING: "hello from workerd" },
    }),
  );
  await worker.ready;
  // Bundling and a cold start of workerd take longer than Vitest's default hook timeout.
}, 60_000);

afterAll(() => worker.dispose());

const get = (path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) =>
  worker.dispatchFetch(`http://localhost${path}`, init);

/** What the Worker's isolate saw, from `/stats`. */
const Stats = Schema.Struct({
  opened: Schema.Number,
  closed: Schema.Number,
  background: Schema.Number,
  aborted: Schema.Array(Schema.String),
});

const stats = async () => Schema.decodeUnknownPromise(Stats)(await (await get("/stats")).json());

describe("the adapter in workerd", () => {
  it("answers a document request", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("document");
  });

  it("gives an Effect loader the Worker's env, passed with the request", async () => {
    const response = await get("/env");
    expect(await response.json()).toEqual({ greeting: "hello from workerd" });
  });

  it("gives an Effect action the request body", async () => {
    const response = await get("/form", { method: "POST", body: "x".repeat(5000) });
    expect(await response.json()).toEqual({ length: 5000 });
  });

  it("keeps a resource of the request's scope open until the streamed body ends", async () => {
    const response = await get("/connection");
    expect(await response.text()).toBe("open open open ");
    // Every connection closed but the one of the `/stats` request, which is still answering.
    await vi.waitFor(async () => {
      const { opened, closed } = await stats();
      expect(opened - closed).toBe(1);
    });
  });

  it("runs an Effect after the response with the execution context's waitUntil", async () => {
    const before = await stats();
    expect(await (await get("/background")).json()).toEqual({ scheduled: true });
    await vi.waitFor(async () => expect((await stats()).background - before.background).toBe(1));
  });

  it("aborts the route's signal when the client cancels the streamed body", async () => {
    const response = await get("/stream?id=cancel");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a body");
    await reader.read();
    await reader.cancel();
    await vi.waitFor(async () => expect((await stats()).aborted).toContain("cancel"));
  });
});
