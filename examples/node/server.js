// Starts the server: through Vite in development, from the build otherwise.
// The only file that does not reload in development.
import { createServer } from "node:http";
import process from "node:process";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Layer } from "effect";
import { HttpMiddleware, HttpRouter } from "effect/http";

const port = Number(process.env.PORT ?? "3000");

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
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port })),
    ),
  ),
);
// oxlint-enable effecttsgo/missing-effect-context
