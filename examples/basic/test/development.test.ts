import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vite-plus/test";

import { root, type ServerProcess, startServer } from "./server-process";

let server: ServerProcess;

beforeAll(async () => {
  server = await startServer(["--dev"], { NODE_ENV: "development" });
});

afterAll(async () => {
  await server.stop();
});

it("renders documents with Vite's client", async () => {
  const response = await fetch(`${server.origin}/`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("virtual:react-router/inject-hmr-runtime");
  expect(html).toContain("summarized slowly");
});

it("lets Vite serve its client and the app's modules", async () => {
  const client = await fetch(`${server.origin}/@vite/client`);
  expect(client.status).toBe(200);
  expect(client.headers.get("content-type")).toContain("text/javascript");
  const module = await fetch(`${server.origin}/app/root.tsx`);
  expect(module.status).toBe(200);
  expect(await module.text()).toContain("export");
});

it("runs Effect actions", async () => {
  const response = await fetch(`${server.origin}/todos.data`, {
    method: "POST",
    headers: { origin: server.origin },
    body: new URLSearchParams({ title: "" }),
  });
  expect(response.status).toBe(422);
});

it("applies an edit to a route on the next request", async () => {
  const file = join(root, "app/routes/legacy.tsx");
  const source = readFileSync(file, "utf8");
  try {
    writeFileSync(file, source.replace("Served by a promise loader", "Edited in development"));
    await expect
      .poll(async () => (await fetch(`${server.origin}/legacy`)).text(), { timeout: 5000 })
      .toContain("Edited in development");
  } finally {
    writeFileSync(file, source);
  }
});
