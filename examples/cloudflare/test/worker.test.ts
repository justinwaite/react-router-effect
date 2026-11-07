import { readdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { browser, root, type ServerProcess, startServer, statsUntil } from "./server-process";

describe.each([
  // The production build in workerd.
  ["production", "vp", ["preview"]],
  // Development: Vite runs the Worker in workerd, and loads the build for each request.
  ["development", "react-router", ["dev"]],
] as const)("the Worker in %s", (mode, bin, args) => {
  let server: ServerProcess;

  beforeAll(async () => {
    server = await startServer(bin, args);
  });

  afterAll(() => server.stop());

  it("renders Effect loader data, and streams a promise while the connection is open", async () => {
    const response = await fetch(server.origin, { headers: { "user-agent": browser } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Hello From The Worker");
    // The promise queried the connection after the shell was sent.
    expect(html).toMatch(/connection \d+: select 1/);
    expect(html).not.toContain("is closed");
  });

  it("closes the request's connection after the body ends", async () => {
    await (await fetch(server.origin, { headers: { "user-agent": browser } })).text();
    // Every connection is closed but the one of the `/stats` request, which is still answering.
    const stats = await statsUntil(server.origin, ({ opened, closed }) => opened - closed === 1);
    expect(stats.opened - stats.closed).toBe(1);
  });

  it("throws a domain error to the error boundary as a 404", async () => {
    const response = await fetch(`${server.origin}/notes/2`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Note 2 was not found");
  });

  it("gives a promise loader the Worker's env through loadContext", async () => {
    const response = await fetch(`${server.origin}/legacy`);
    expect(await response.text()).toContain("hello from the worker");
  });

  it("runs an Effect after the response with waitUntil", async () => {
    const { background } = await statsUntil(server.origin, () => true);
    const response = await fetch(`${server.origin}/background`);
    expect(await response.json()).toEqual({ scheduled: true });
    const stats = await statsUntil(server.origin, (next) => next.background > background);
    expect(stats.background).toBe(background + 1);
  });

  it.runIf(mode === "production")("serves the client build from the Worker's assets", async () => {
    const file = readdirSync(join(root, "build/client/assets")).find((name) =>
      name.endsWith(".js"),
    );
    expect(file).toBeDefined();
    const response = await fetch(`${server.origin}/assets/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
  });
});
