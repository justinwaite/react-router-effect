import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { browser, type ServerProcess, startServer, statsUntil } from "./server-process";

/** The tests of one server: the production build in `vp preview`, or `react-router dev`. */
const serves = (name: string, bin: string, args: ReadonlyArray<string>) =>
  describe(name, () => {
    let server: ServerProcess;

    beforeAll(async () => {
      server = await startServer(bin, args);
    });

    afterAll(async () => {
      await server?.stop();
    });

    const text = (testId: string, html: string) =>
      new RegExp(`data-testid="${testId}">([^<]*)<`).exec(html)?.[1];

    it("renders Effect loader data: the Worker's env, a runtime service, the request layer", async () => {
      const response = await fetch(`${server.origin}/`, { headers: { "user-agent": browser } });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(text("greeting", html)).toBe("Hello From The Worker");
      const now = text("now", html);
      expect(now).toMatch(/^connection \d+: select now$/);
      // The promise streamed after the shell, on the same connection: the
      // request layer's scope stayed open while the body streamed.
      expect(text("later", html)).toBe(now?.replace("select now", "select later"));
    });

    it("closes every request's connection once its response ends", async () => {
      await fetch(`${server.origin}/`, { headers: { "user-agent": browser } }).then((r) =>
        r.text(),
      );
      // Only the `/stats` request that reports is still open.
      const stats = await statsUntil(server.origin, (s) => s.opened - s.closed === 1);
      expect(stats.opened - stats.closed).toBe(1);
    });

    it("throws a domain error to the error boundary with the factory's handler", async () => {
      const response = await fetch(`${server.origin}/notes/2`);
      expect(response.status).toBe(404);
      expect(text("error", await response.text())).toBe("404: Note 2 was not found");
    });

    it("passes a promise loader through, with the context getLoadContext made", async () => {
      const response = await fetch(`${server.origin}/legacy`);
      expect(text("legacy", await response.text())).toBe("hello from the worker");
    });

    it("runs waitUntil Effects after the response, with the request's connection", async () => {
      const before = await statsUntil(server.origin, () => true);
      const response = await fetch(`${server.origin}/background`, {
        method: "POST",
        headers: { origin: server.origin },
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ accepted: true });
      const after = await statsUntil(
        server.origin,
        (s) => s.background === before.background + 1 && s.opened - s.closed === 1,
      );
      expect(after.background).toBe(before.background + 1);
      expect(after.opened - after.closed).toBe(1);
    });
  });

serves("the production build in workerd", "vp", ["preview"]);
serves("development in workerd", "react-router", ["dev"]);
