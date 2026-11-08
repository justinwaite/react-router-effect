// Starts the server: through Vite in development, from the build otherwise.
// The only file that does not reload in development.
import { createServer } from "node:http";
import process from "node:process";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";

const port = Number(process.env.PORT ?? "3000");

/**
 * Creates the HTTP server, which answers 503 until Effect attaches its request
 * handler. Effect opens the port before it builds the app and attaches the
 * handler, and Node never answers a request that has no handler.
 */
function createStartingServer() {
  const server = createServer();
  const answerStarting = (_request, response) => {
    response.writeHead(503, { connection: "close", "retry-after": "1" });
    response.end();
  };
  server.on("request", answerStarting);
  // Node emits `newListener` before it adds the listener, so the two never
  // answer the same request.
  server.on("newListener", function detachStarting(event) {
    if (event !== "request") return;
    server.off("request", answerStarting);
    server.off("newListener", detachStarting);
  });
  return server;
}

const App =
  process.env.NODE_ENV === "development"
    ? await (async () => {
        const { createServer: createVite } = await import("vite");
        const { ReactRouterVite } = await import("react-router-effect/vite");
        const vite = await createVite({ server: { middlewareMode: true } });
        return ReactRouterVite.layer(vite, () =>
          vite.ssrLoadModule("./server/app.ts").then((module) => module.App),
        );
      })()
    : (await import("./build/server/index.js")).App;

// oxlint-disable effecttsgo/missing-effect-context -- `App` is `any`: this JS file loads it at run time, through `ssrLoadModule` or the build
NodeRuntime.runMain(
  Layer.launch(
    // The app's own server middleware: compression that flushes streamed chunks.
    // It can also go in `App`, as
    // `HttpRouter.middleware(HttpMiddleware.compression(), { global: true })`.
    // It is here only so that the benchmarks serve `App` without compression.
    HttpRouter.serve(App, { middleware: HttpMiddleware.compression() }).pipe(
      Layer.provide(NodeHttpServer.layer(createStartingServer, { port })),
    ),
  ),
);
// oxlint-enable effecttsgo/missing-effect-context
