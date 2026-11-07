import { readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { readChunks, root, type ServerProcess, startServer } from "./server-process";

let server: ServerProcess;

beforeAll(async () => {
  server = await startServer([], { NODE_ENV: "production" });
});

afterAll(async () => {
  await server.stop();
});

/** A browser's user agent. */
const browser = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

/** Posts a form as React Router's fetcher does: a single fetch `.data` request. */
const submit = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${server.origin}${path}.data`, {
    method: "POST",
    headers: { origin: server.origin, ...headers },
    body: new URLSearchParams(form),
  });

describe("documents", () => {
  it("renders Effect loader data and streams a promise after the shell", async () => {
    // React Router's default entry waits for all data for a bot, such as Node's fetch.
    const response = await fetch(`${server.origin}/`, { headers: { "user-agent": browser } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const chunks = await readChunks(response);
    const html = chunks.map((chunk) => chunk.text).join("");
    expect(html).toContain('data-testid="count">2<');
    expect(html).toContain("summarized slowly");
    // The shell, with the fallback, arrives before the promise settles 300ms later.
    const at = (text: string) =>
      chunks.find((chunk) => chunk.text.includes(text))?.at ?? Number.NaN;
    expect(at("summarized slowly") - at("Summarizing")).toBeGreaterThan(150);
  });

  it("runs the Effect middleware: a new visitor gets a cookie, a known one keeps their name", async () => {
    const first = await fetch(`${server.origin}/legacy`);
    const cookie = first.headers.getSetCookie().find((value) => value.startsWith("visitor="));
    expect(cookie).toBeDefined();
    const name = /data-testid="visitor">([^<]+)</.exec(await first.text())?.[1];
    const second = await fetch(`${server.origin}/legacy`, {
      headers: { cookie: cookie?.split(";")[0] ?? "" },
    });
    expect(second.headers.getSetCookie()).toEqual([]);
    expect(await second.text()).toContain(`data-testid="visitor">${name}<`);
  });

  it("builds the request's services with the RequestServices middleware", async () => {
    const response = await fetch(`${server.origin}/legacy`, {
      headers: { "x-request-id": "req-42" },
    });
    expect(await response.text()).toContain("Request <!-- -->req-42");
  });

  it("passes a promise loader through", async () => {
    const response = await fetch(`${server.origin}/legacy`);
    expect(await response.text()).toContain("Served by a promise loader");
  });

  it("compresses with the app's own middleware", async () => {
    const response = await fetch(`${server.origin}/legacy`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  it("answers an unknown path with React Router's 404", async () => {
    const response = await fetch(`${server.origin}/nowhere`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("404");
  });
});

describe("single fetch", () => {
  it("serves loader data as a .data request", async () => {
    const response = await fetch(`${server.origin}/todos.data`);
    expect(response.headers.get("content-type")).toBe("text/x-script");
    expect(await response.text()).toContain("Write a loader with Effect.fn");
  });

  it("recovers an unhandled domain error through the factory's handler", async () => {
    const response = await submit("/todos", { title: " " });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("A todo needs a title");
  });

  it("returns what the action recovers itself", async () => {
    const response = await submit("/todos", { title: "Write a loader with Effect.fn" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("is already on the list");
  });

  it("returns action data with the request's metadata, and both cookies", async () => {
    const response = await submit("/todos", { title: "Ship it" }, { "x-request-id": "req-7" });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Ship it");
    expect(body).toContain("__meta");
    expect(body).toContain("req-7");
    // The visitor cookie from the middleware and the action's own cookie.
    expect(
      response.headers
        .getSetCookie()
        .map((value) => value.split("=")[0])
        .toSorted(),
    ).toEqual(["last-added", "visitor"]);
  });
});

describe("resource routes", () => {
  it("redirects through Respond.redirect", async () => {
    const response = await fetch(`${server.origin}/todos/old`, { redirect: "manual" });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/todos");
  });

  it("streams server-sent events from an Effect stream, as they happen", async () => {
    const response = await fetch(`${server.origin}/events?count=3`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const chunks = await readChunks(response);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(
      'data: {"tick":0}\n\ndata: {"tick":1}\n\ndata: {"tick":2}\n\n',
    );
    expect((chunks.at(-1)?.at ?? 0) - (chunks[0]?.at ?? 0)).toBeGreaterThan(150);
  });

  it("interrupts the stream when the client leaves", async () => {
    const status = async () =>
      ((await (await fetch(`${server.origin}/events/status`)).json()) as { open: number }).open;
    const controller = new AbortController();
    const response = await fetch(`${server.origin}/events?count=1000`, {
      signal: controller.signal,
    });
    await response.body?.getReader().read();
    expect(await status()).toBe(1);
    controller.abort();
    await expect.poll(status, { timeout: 2000 }).toBe(0);
  });
});

describe("client assets", () => {
  const assets = readdirSync(join(root, "build/client/assets"));
  const script = assets.find((file) => file.endsWith(".js"));

  it("serves hashed assets from the build, cached as immutable", async () => {
    const response = await fetch(`${server.origin}/assets/${script}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves files from public/, cached for an hour", async () => {
    const response = await fetch(`${server.origin}/favicon.svg`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
  });
});

describe("documents with a form", () => {
  it("redirects a document POST that clears the list", async () => {
    const response = await fetch(`${server.origin}/todos`, {
      method: "POST",
      headers: { origin: server.origin },
      body: new URLSearchParams({ intent: "clear" }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/todos");
    expect(await (await fetch(`${server.origin}/todos.data`)).text()).not.toContain("Ship it");
  });
});

describe("shutdown", () => {
  it("stops on SIGTERM", async () => {
    const other = await startServer([], { NODE_ENV: "production" });
    await other.stop();
    await expect(fetch(`${other.origin}/legacy`)).rejects.toThrow();
  });
});
