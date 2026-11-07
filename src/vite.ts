/**
 * Runs React Router's development server, Vite, in front of the Effect HTTP
 * app on Node.
 *
 * In framework mode React Router builds with Vite, and in development Vite
 * serves the client: route modules, `/@vite/client`, the files of `public/`,
 * and its error overlay. A custom server runs Vite in middleware mode and passes
 * it each request first. Vite's middleware is a Connect stack of Node
 * requests and responses, so this layer needs Effect's Node HTTP server.
 *
 * Its API is unstable: a minor version can change it.
 *
 * @stability unstable
 * @since 2.1.0
 */
import type * as Http from "node:http";

import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Effect, Exit, Layer, Option, Predicate, Scope, SynchronizedRef, Tuple } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

/**
 * The parts of a Vite dev server that the adapter uses.
 *
 * @stability unstable
 */
export interface ViteDevServer {
  /** Vite's Connect middleware stack. */
  readonly middlewares: (
    request: Http.IncomingMessage,
    response: Http.ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
  /**
   * Maps the stack of an error to the source files, as the Express template
   * does. Vite's dev server has it.
   */
  readonly ssrFixStacktrace?: ((error: Error) => void) | undefined;
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
 * Serves the app in development, as the Express template does. Give it to
 * `HttpRouter.serve` in place of the app's `App`:
 *
 * ```js
 * const vite = await createServer({ server: { middlewareMode: true } });
 * const App = ReactRouterVite.layer(vite, () =>
 *   vite.ssrLoadModule("./server/app.ts").then((module) => module.App),
 * );
 * ```
 *
 * The layer registers one catch-all route on the server's router. Its
 * handler passes each request to Vite first. For a request that Vite passes
 * on, it calls `loadApp`. When `loadApp` returns a new `App` value, such as
 * after an edit of the app's server code, the layer builds the new `App` with
 * its own router and closes the old one. Concurrent requests share one build
 * of each `App`. Then the request goes through the current `App`.
 *
 * A request that Vite answers gets an empty `HttpServerResponse`, which
 * Effect's Node server does not write, since Vite has ended the Node
 * response. A defect, such as a Vite error, a `loadApp` that rejects or an
 * `App` that fails to build, goes to the app's loggers, after
 * `ssrFixStacktrace` maps its stack, and the client gets an empty 500.
 *
 * @stability unstable
 */
export const layer = <E, R>(
  vite: ViteDevServer,
  loadApp: () => PromiseLike<Layer.Layer<never, E, R>>,
) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const layerScope = yield* Effect.scope;
      const services =
        yield* Effect.context<Exclude<HttpRouter.Request.Without<R>, HttpRouter.HttpRouter>>();
      /** Builds `app` in `scope`. The services of this layer do not replace either. */
      const build = (app: Layer.Layer<never, E, R>, scope: Scope.Scope) =>
        HttpRouter.toHttpEffect(app).pipe(
          Scope.provide(scope),
          // A new memo map, so the App gets its own router. The memo map of the
          // server's layers has the server's router, and a fork of it reuses it.
          Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
          Effect.provideContext(services),
        );
      type Handler = Effect.Success<ReturnType<typeof build>>;
      interface Built {
        readonly app: Layer.Layer<never, E, R>;
        readonly handler: Handler;
        readonly scope: Scope.Closeable;
      }
      const state = yield* SynchronizedRef.make(Option.none<Built>());

      /** The handler of `app`, built once for each `App` value. */
      const handlerOf = (app: Layer.Layer<never, E, R>) =>
        SynchronizedRef.modifyEffect(state, (previous) =>
          Effect.gen(function* () {
            if (Option.isSome(previous) && previous.value.app === app) {
              return Tuple.make(previous.value.handler, previous);
            }
            const scope = yield* Scope.fork(layerScope);
            const handler = yield* build(app, scope).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit),
              ),
              Effect.orDie,
            );
            if (Option.isSome(previous)) yield* Scope.close(previous.value.scope, Exit.void);
            return Tuple.make(handler, Option.some<Built>({ app, handler, scope }));
          }).pipe(
            // A client that leaves during a build does not stop it: the build
            // is shared, and a stop could leave a scope open or drop a build.
            Effect.uninterruptible,
          ),
        );

      const handler = HttpServerRequest.HttpServerRequest.use((request) =>
        passThroughVite(
          vite,
          // Vite takes HTTP/1 requests; Effect's Node server serves HTTP/1.
          NodeHttpServerRequest.toIncomingMessage(request) as Http.IncomingMessage,
          NodeHttpServerRequest.toServerResponse(request) as Http.ServerResponse,
        ).pipe(
          Effect.flatMap((passed) =>
            passed
              ? Effect.promise(loadApp).pipe(Effect.flatMap(handlerOf), Effect.flatten)
              : Effect.succeed(HttpServerResponse.empty()),
          ),
          Effect.catchDefect((defect) => {
            if (Predicate.isError(defect)) vite.ssrFixStacktrace?.(defect);
            return Effect.logError("Request failed in development", defect).pipe(
              Effect.as(HttpServerResponse.empty({ status: 500 })),
            );
          }),
        ),
      );
      yield* router.add("*", "*", handler);
    }),
  );
