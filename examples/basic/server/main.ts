/**
 * The app's Effect HTTP server. The app owns it: listening, its own
 * middleware, and what else it serves. React Router is one Effect HTTP app in
 * it, `reactRouterApp`.
 */
import * as Http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpServer, type HttpServerResponse } from "effect/http";
import { ReactRouterVite } from "react-router-effect/vite";

import { reactRouterApp } from "./app";

export * from "./app";

/** A Vite dev server in middleware mode. */
export interface ViteDevServer extends ReactRouterVite.ViteDevServer {
  readonly ssrLoadModule: (url: string) => Promise<Record<string, unknown>>;
}

export interface MainOptions {
  readonly port: number;
  /** The Vite dev server, in development. */
  readonly vite?: ViteDevServer | undefined;
}

/** The app's own middleware: an access log, and compression that flushes streamed chunks. */
const middleware = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  app.pipe(HttpMiddleware.compression(), HttpMiddleware.logger);

/**
 * Development: Vite answers what it serves, and React Router the rest. The
 * app module is loaded through Vite for each request, so an edit to it, the
 * route factory or a route applies on the next request.
 */
const developmentApp = (vite: ViteDevServer) =>
  Effect.promise(() => vite.ssrLoadModule("./server/app.ts")).pipe(
    Effect.flatMap((module) => (module as typeof import("./app")).reactRouterApp),
    ReactRouterVite.devMiddleware(vite),
  );

/** The server, as a layer. Tests and `main` launch it. */
export const ServerLive = (options: MainOptions) =>
  HttpServer.serve(
    options.vite === undefined ? reactRouterApp : developmentApp(options.vite),
    middleware,
  ).pipe(
    HttpServer.withLogAddress,
    Layer.provide(NodeHttpServer.layer(() => Http.createServer(), { port: options.port })),
  );

/** Runs the server until SIGINT or SIGTERM, then lets open requests finish. */
export const main = (options: MainOptions) =>
  NodeRuntime.runMain(Layer.launch(ServerLive(options)));
