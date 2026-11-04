/**
 * Serves the example's build for the HTTP benchmark: `node bench/serve.ts
 * <adapter|express|node> <port>`. None logs requests or compresses, so the
 * servers differ only in how they serve React Router.
 *
 * - `adapter`: `reactRouterApp` on Effect's Node HTTP server, serving the
 *   client build and React Router.
 * - `express`: React Router's custom server template: Express with
 *   `express.static` for the client build, and `@react-router/express`.
 * - `node`: `@react-router/node`'s request listener on `node:http`, with no
 *   client build: the least a server can do.
 *
 * The gap benchmark adds servers that split the difference into its parts:
 *
 * - `node-floor`, `effect-floor` and `express-floor`: `node:http`, Effect's
 *   Node HTTP server, and Express with the template's `express.static`,
 *   answering every request with the same fixed body, without React Router.
 *   Their differences to `node-floor` are the costs of the servers
 *   themselves.
 * - `effect-minimal`: the least an Effect server can do to serve React
 *   Router: the Web request from `HttpServerRequest.toWeb`, React Router's
 *   handler, and `HttpServerResponse.fromWeb`. It drops what the adapter
 *   adds: the request fiber's context for route Effects, the abort signal,
 *   the client build, the build cache, and tracing.
 */
import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createRequestHandler } from "@react-router/express";
import { createRequestListener } from "@react-router/node";
import { Effect, Layer } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import express from "express";
import { createRequestHandler as createRouterHandler } from "react-router";
import type { ReactRouterHttp } from "react-router-effect/server";

import { baselineBuild, baselineContext, floorBody, loadServer } from "./servers.ts";

const [kind, port = "3000"] = process.argv.slice(2);
const server = await loadServer();

/** Closes a Node server on SIGTERM. */
const closeOnSignal = (http: Http.Server) => process.once("SIGTERM", () => http.close());

/** Express as React Router's template sets it up, serving the client build. */
const expressWithStatic = () => {
  const app = express();
  app.disable("x-powered-by");
  app.use("/assets", express.static("build/client/assets", { immutable: true, maxAge: "1y" }));
  app.use(express.static("build/client", { maxAge: "1h" }));
  return app;
};

/** Makes an Effect HTTP app and serves it on Effect's Node HTTP server until SIGTERM. */
const serveEffect = (
  make: Effect.Effect<
    Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      unknown,
      HttpServerRequest.HttpServerRequest
    >,
    unknown,
    ReactRouterHttp.ClientAssetServices
  >,
) =>
  NodeRuntime.runMain(
    Layer.launch(
      Layer.unwrap(Effect.map(make, (app) => HttpServer.serve(app))).pipe(
        Layer.provide(NodeHttpServer.layer(() => Http.createServer(), { port: Number(port) })),
      ),
    ),
  );

switch (kind) {
  case "adapter": {
    serveEffect(server.reactRouterApp);
    break;
  }
  case "effect-minimal": {
    const handler = createRouterHandler(await baselineBuild(server), "production");
    serveEffect(
      Effect.succeed(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const web = yield* HttpServerRequest.toWeb(request);
          const context = baselineContext(server, request.headers["x-request-id"]);
          return HttpServerResponse.fromWeb(yield* Effect.promise(() => handler(web, context)));
        }),
      ),
    );
    break;
  }
  case "effect-floor": {
    serveEffect(
      Effect.succeed(
        Effect.succeed(HttpServerResponse.text(floorBody, { contentType: "text/x-script" })),
      ),
    );
    break;
  }
  case "node-floor": {
    const http = Http.createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/x-script" });
      response.end(floorBody);
    });
    closeOnSignal(http.listen(Number(port)));
    break;
  }
  case "express-floor": {
    const app = expressWithStatic();
    // `end`, not `send`, which would also compute an ETag of the body.
    app.use((_, response) => {
      response.writeHead(200, { "content-type": "text/x-script" });
      response.end(floorBody);
    });
    closeOnSignal(app.listen(Number(port)));
    break;
  }
  case "express": {
    const build = await baselineBuild(server);
    const app = expressWithStatic();
    app.use(
      createRequestHandler({
        build,
        mode: "production",
        getLoadContext: (request) => baselineContext(server, request.get("x-request-id")),
      }),
    );
    closeOnSignal(app.listen(Number(port)));
    break;
  }
  case "node": {
    const build = await baselineBuild(server);
    const listener = createRequestListener({
      build,
      mode: "production",
      getLoadContext: (request) =>
        baselineContext(server, request.headers.get("x-request-id") ?? undefined),
    });
    closeOnSignal(Http.createServer(listener).listen(Number(port)));
    break;
  }
  default:
    throw new Error(`Unknown server ${kind}`);
}
