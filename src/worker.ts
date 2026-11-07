/**
 * Serves a React Router framework-mode build from a Cloudflare Worker, or from
 * any other runtime whose server hands the app a Fetch API `Request` and
 * takes back a `Response`.
 *
 * The adapter is a `fetch` handler. It calls React Router's own request
 * handler with the Worker's request, and returns React Router's response as it
 * is: its streamed body, its headers and its cookies. React Router keeps doing
 * everything it does for any other server adapter: documents, `.data`
 * requests, streamed promises, resource routes, the lazy route manifest, and
 * middleware.
 *
 * Before React Router sees the build, the adapter wraps every loader, action
 * and middleware with the route factory's runner, as the Node adapter does. A
 * route function that returns an Effect runs through the factory's error
 * model, with the factory's runtime and the request's effect context. Any
 * other route function passes through unchanged.
 *
 * The adapter imports nothing from Node. Cloudflare serves the client build
 * from the Worker's static assets, before the Worker runs.
 *
 * @since 2.2.0
 */
import { Context, Effect, Exit, Option, Scope, Tracer } from "effect";
import { Headers as HttpHeaders, HttpTraceContext } from "effect/http";
import { RouterContextProvider } from "react-router";

import {
  type BuildSource,
  buildRequestLayer,
  exportedSpan,
  makeBuildLoader,
  onBodyEnd,
  type RequestLayer,
  type RequestScope,
  requestSpanKey,
  type RouteFactoryLike,
  type RuntimeServicesOf,
} from "./core.ts";
import type { Register } from "./route-data.ts";

export type { BuildSource } from "./core.ts";

// ---------------------------------------------------------------------------
// The Worker's arguments.
// ---------------------------------------------------------------------------

/**
 * The Worker's env, as the app registers it:
 *
 * ```ts
 * declare module "react-router-effect" {
 *   interface Register {
 *     workerEnv: Env;
 *   }
 * }
 * ```
 *
 * `unknown` when the app registers none.
 */
export type RegisteredWorkerEnv = Register extends { readonly workerEnv: infer Env }
  ? Env
  : unknown;

/**
 * What the adapter uses of a Worker's execution context. Cloudflare's
 * `ExecutionContext` has it.
 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** The Worker's arguments of one request, besides the request. */
export interface WorkerArgs {
  readonly env: RegisteredWorkerEnv;
  readonly ctx: ExecutionContextLike;
}

/**
 * The Worker of the current request: its env and execution context, and
 * `waitUntil` for Effects. The adapter provides it to every request layer,
 * middleware, loader and action. A route Effect that requires it needs it in
 * the factory's `requestContext` key, such as
 * `RequestContextKey<WorkerContext | Session>`.
 */
export class WorkerContext extends Context.Service<
  WorkerContext,
  {
    readonly env: RegisteredWorkerEnv;
    readonly executionContext: ExecutionContextLike;
    /**
     * Runs an Effect after the response, as the execution context's
     * `waitUntil` runs a promise. It runs with the services of the fiber that
     * calls `waitUntil`, request services included: the request layer's scope
     * stays open until it ends. A failure is logged with `Effect.logError`.
     * The Effect is not interrupted when the request ends.
     */
    readonly waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>;
  }
>()("react-router-effect/WorkerContext") {}

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

/**
 * What the request layer may require: the services of the factory's runtime,
 * and the Worker.
 */
export type RequestLayerServices<Factory> = RuntimeServicesOf<Factory> | WorkerContext;

/** The options of {@link make}. */
export interface Options<Factory extends RouteFactoryLike = RouteFactoryLike> {
  /** The server build: `() => import("virtual:react-router/server-build")`. */
  readonly build: BuildSource;
  /** The route factory whose runner, runtime and error model route Effects use. */
  readonly factory: Factory;
  /**
   * React Router's server mode, such as `import.meta.env.MODE`. Defaults to
   * `process.env.NODE_ENV` where `process` exists. In production the build
   * is not reloaded.
   */
  readonly mode?: string | undefined;
  /**
   * Builds the services of one request, before React Router runs. They join
   * the request's effect context, so every middleware, loader and action sees
   * them without a middleware that sets them.
   */
  readonly requestContext?:
    | ((request: Request, worker: WorkerArgs) => Context.Context<never>)
    | undefined;
  /**
   * Builds the services of one request as a layer, before React Router runs.
   * Use it for a service that holds a resource for one request, such as a
   * database connection: a Worker cannot share I/O objects across requests.
   *
   * The adapter builds the layer for every request, in a scope of its own.
   * The scope closes when the response body ends or the client cancels it, and
   * after every `WorkerContext.waitUntil` Effect of the request ends. The
   * Worker's `waitUntil` keeps the Worker alive until it closes. The layer may
   * require the services of the factory's runtime, `WorkerContext`, and what
   * `requestContext` builds. A layer the runtime already built is reused. Its
   * services join the request's effect context, like `requestContext`'s.
   * When building the layer fails, the adapter logs the failure and answers
   * 500.
   */
  readonly requestLayer?:
    | ((request: Request, worker: WorkerArgs) => RequestLayer<RequestLayerServices<Factory>>)
    | undefined;
  /**
   * Makes the router context of one request, as `getLoadContext` does for
   * React Router's other adapters. Use it to set the context keys that promise
   * route functions read, such as the Worker's env. The adapter then sets its
   * own keys on it. Without it, the adapter makes an empty one.
   */
  readonly getLoadContext?:
    | ((
        request: Request,
        worker: WorkerArgs,
      ) => RouterContextProvider | Promise<RouterContextProvider>)
    | undefined;
}

/**
 * The Worker's handler. Its `fetch` is a Worker's `fetch` handler, so the
 * handler can be the Worker's default export, or an app's own `fetch` can
 * call it.
 */
export interface Handler {
  readonly fetch: (
    request: Request,
    env: RegisteredWorkerEnv,
    ctx: ExecutionContextLike,
  ) => Promise<Response>;
}

// ---------------------------------------------------------------------------
// Background Effects.
// ---------------------------------------------------------------------------

/** The `waitUntil` Effects of one request. */
interface Background {
  readonly waitUntil: WorkerContext["Service"]["waitUntil"];
  /** Resolves once every `waitUntil` Effect has ended, those they start included. */
  readonly settled: () => Promise<void>;
}

const makeBackground = (ctx: ExecutionContextLike): Background => {
  const pending = new Set<Promise<void>>();
  return {
    waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(Effect.context<R>(), (context) =>
        Effect.sync(() => {
          const task = Effect.runPromiseWith(context)(
            effect.pipe(
              Effect.asVoid,
              Effect.catchCause((cause) => Effect.logError("A waitUntil Effect failed", cause)),
            ),
          );
          pending.add(task);
          void task.finally(() => pending.delete(task));
          ctx.waitUntil(task);
        }),
      ),
    settled: async () => {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
  };
};

// ---------------------------------------------------------------------------
// Tracing.
// ---------------------------------------------------------------------------

/**
 * Runs the request in a server span when the runtime has a tracer that
 * exports spans, as Effect's HTTP server does: named after the method, with
 * the parent from the request's trace headers. Without one, it adds nothing.
 */
const withServerSpan =
  (request: Request) =>
  <E, R>(self: Effect.Effect<Response, E, R>): Effect.Effect<Response, E, R> =>
    Effect.flatMap(Effect.context<never>(), (context) => {
      if (Context.get(context, Tracer.Tracer) === Tracer.nativeTracer) return self;
      const url = new URL(request.url);
      return self.pipe(
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("http.response.status_code", response.status),
        ),
        Effect.withSpan(request.method, {
          kind: "server",
          parent: Option.getOrUndefined(
            HttpTraceContext.fromHeaders(HttpHeaders.fromInput(request.headers)),
          ),
          attributes: {
            "http.request.method": request.method,
            "url.full": url.href,
            "url.path": url.pathname,
            "url.scheme": url.protocol.slice(0, -1),
          },
        }),
      );
    });

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

/** React Router's server mode where `process` exists, as Vite replaces it in a build. */
const defaultMode = (): string | undefined =>
  typeof process === "undefined" ? undefined : process.env.NODE_ENV;

/** The 500 the adapter answers when one of its own steps fails. */
const internalServerError = () => new Response(null, { status: 500 });

/**
 * Makes the Worker's handler that serves React Router.
 *
 * ```ts
 * import { ReactRouterWorker } from "react-router-effect/worker";
 *
 * export default ReactRouterWorker.make({
 *   build: () => import("virtual:react-router/server-build"),
 *   factory: routeFactory,
 *   mode: import.meta.env.MODE,
 * }) satisfies ExportedHandler<Env>;
 * ```
 *
 * The build loads on the first request. In development, a new build after a
 * change gets a new request handler. The factory's runtime is built on the
 * first request too, and lasts as long as the Worker's isolate: its services
 * must not hold I/O objects, which a Worker cannot share across requests. The
 * request layer holds those.
 *
 * React Router logs and answers the errors of route code. If one of the
 * adapter's own steps fails, such as a request layer that cannot be built, the
 * adapter logs the failure with `Effect.logError` and answers 500.
 */
export const make = <Factory extends RouteFactoryLike>(options: Options<Factory>): Handler => {
  const handlers = options.factory.handlers;
  const loadBuild = makeBuildLoader(options.build, handlers, options.mode ?? defaultMode());

  const handle = (request: Request, worker: WorkerArgs): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const { handler } = yield* loadBuild;
      const background = makeBackground(worker.ctx);
      // The runtime's services, and the span of the request when it is traced.
      const fiberContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
      const base = Context.merge(
        Context.add(fiberContext, WorkerContext, {
          env: worker.env,
          executionContext: worker.ctx,
          waitUntil: background.waitUntil,
        }),
        options.requestContext?.(request, worker) ?? Context.empty(),
      );
      const requestScope: RequestScope | undefined =
        options.requestLayer === undefined
          ? undefined
          : yield* buildRequestLayer(options.requestLayer(request, worker), base).pipe(
              Effect.orDie,
            );
      const closeScope = () => {
        if (requestScope === undefined) return;
        worker.ctx.waitUntil(
          background.settled().then(() => Effect.runPromise(requestScope.close(Exit.void))),
        );
      };
      return yield* Effect.gen(function* () {
        const getLoadContext = options.getLoadContext;
        const routerContext =
          getLoadContext === undefined
            ? new RouterContextProvider()
            : yield* Effect.promise(async () => getLoadContext(request, worker));
        routerContext.set(
          handlers.requestContext,
          requestScope === undefined ? base : Context.merge(base, requestScope.context),
        );
        routerContext.set(requestSpanKey, exportedSpan(fiberContext));
        const response = yield* Effect.promise(() => handler(request, routerContext));
        return requestScope === undefined ? response : onBodyEnd(response, closeScope);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && requestScope !== undefined
            ? requestScope.close(exit)
            : Effect.void,
        ),
      );
    }).pipe(
      withServerSpan(request),
      Effect.catchDefect((defect) =>
        Effect.logError("React Router adapter failed", defect).pipe(
          Effect.as(internalServerError()),
        ),
      ),
    );

  const runtime = handlers.runtime;
  return {
    fetch: (request, env, ctx) => {
      const program = handle(request, { env, ctx });
      const run = runtime === undefined ? Effect.runPromise(program) : runtime.runPromise(program);
      // A runtime whose layer fails to build fails every request.
      return run.catch((error: unknown) => {
        console.error("React Router adapter failed: the runtime did not build", error);
        return internalServerError();
      });
    },
  };
};
