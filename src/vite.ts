/**
 * Runs React Router's development server, Vite, in front of the Effect HTTP
 * app on Node.
 *
 * In framework mode React Router builds with Vite, and in development Vite
 * serves the client: route modules, `/@vite/client`, the files of `public/`,
 * and its error overlay. A custom server runs Vite in middleware mode and passes
 * it each request first. Vite's middleware is a Connect stack of Node
 * requests and responses, so this middleware needs Effect's Node HTTP server.
 *
 * @since 2.1.0
 */
import type * as Http from "node:http";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

/** The part of a Vite dev server the middleware uses: its Connect middleware stack. */
export interface ViteDevServer {
  readonly middlewares: (
    request: Http.IncomingMessage,
    response: Http.ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
}

/**
 * Runs Vite's middleware on the Node request. Succeeds with `true` when Vite
 * passes the request on, and `false` when Vite answered it, or the client left
 * while Vite answered.
 */
const passThroughVite = (
  vite: ViteDevServer,
  request: Http.IncomingMessage,
  response: Http.ServerResponse,
): Effect.Effect<boolean> =>
  Effect.callback<boolean>((resume) => {
    let settled = false;
    const settle = (result: Effect.Effect<boolean>) => {
      if (settled) return;
      settled = true;
      response.off("finish", answered);
      response.off("close", answered);
      resume(result);
    };
    const answered = () => settle(Effect.succeed(false));
    response.once("finish", answered);
    response.once("close", answered);
    try {
      vite.middlewares(request, response, (error) =>
        settle(error === undefined ? Effect.succeed(true) : Effect.die(error)),
      );
    } catch (error) {
      settle(Effect.die(error));
    }
  });

/**
 * Passes each request to Vite first, and the requests Vite passes on to the
 * app. Use it in development only, with Vite in middleware mode:
 *
 * ```ts
 * import { ReactRouterVite } from "react-router-effect/vite";
 *
 * const vite = await createServer({ server: { middlewareMode: true } });
 * HttpServer.serve(Effect.flatten(reactRouterApp).pipe(ReactRouterVite.devMiddleware(vite)));
 * ```
 *
 * A request Vite answers gets an empty `HttpServerResponse`, which Effect's
 * Node server does not write, since Vite has ended the Node response. A Vite
 * error fails the request as a defect.
 */
export const devMiddleware =
  (vite: ViteDevServer) =>
  <E, R>(
    app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    HttpServerRequest.HttpServerRequest.use((request) =>
      passThroughVite(
        vite,
        // Vite takes HTTP/1 requests; Effect's Node server serves HTTP/1.
        NodeHttpServerRequest.toIncomingMessage(request) as Http.IncomingMessage,
        NodeHttpServerRequest.toServerResponse(request) as Http.ServerResponse,
      ).pipe(
        Effect.flatMap((passed) => (passed ? app : Effect.succeed(HttpServerResponse.empty()))),
      ),
    );
