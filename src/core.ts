/**
 * What every adapter shares: loading the build, wrapping its route modules
 * with the route factory's runner, tracing route functions, calling React
 * Router, and the services of one request.
 *
 * Nothing here depends on a platform. The Node adapter (`server.ts`) and the
 * Worker adapter (`worker.ts`) differ only in how a request reaches React
 * Router and how its response leaves.
 *
 * @internal
 */
import { Cause, Context, Effect, Exit, Layer, Scope, Tracer } from "effect";
import {
  createContext,
  createRequestHandler,
  type MiddlewareFunction,
  type RouterContext,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";

import type { RouteHandlers } from "./factory.ts";

/** A React Router server build, or a function that loads it, as in `createRequestHandler`. */
export type BuildSource = ServerBuild | (() => ServerBuild | Promise<ServerBuild>);

// ---------------------------------------------------------------------------
// Tracing.
// ---------------------------------------------------------------------------

/**
 * The span of a traced request: the server span of Effect's HTTP tracer, with
 * a tracer that exports spans. Without it, the adapter adds no spans.
 */
export const requestSpanKey: RouterContext<Tracer.Span | undefined> = createContext<
  Tracer.Span | undefined
>(undefined);

/**
 * The span of the request fiber, when a tracer exports it: not the native
 * tracer, whose spans go nowhere, and not an unsampled span.
 */
export const exportedSpan = (context: Context.Context<never>): Tracer.Span | undefined => {
  const span = Context.getOrUndefined(context, Tracer.ParentSpan);
  return span?._tag === "Span" &&
    span.sampled &&
    Context.get(context, Tracer.Tracer) !== Tracer.nativeTracer
    ? span
    : undefined;
};

/** What a route function produced: its value, or what it threw. */
type Settled =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Calls a route function and captures its result, a synchronous throw included. */
const settle = (call: () => unknown): Promise<Settled> => {
  try {
    return Promise.resolve(call()).then(
      (value): Settled => ({ ok: true, value }),
      (error: unknown): Settled => ({ ok: false, error }),
    );
  } catch (error) {
    return Promise.resolve({ ok: false, error });
  }
};

/** The status of a thrown `Response` or `data(...)`, which React Router sends as a response. */
const thrownStatus = (error: unknown): number | undefined => {
  if (error instanceof Response) return error.status;
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  if (error.type !== "DataWithResponseInit" || !("init" in error)) return undefined;
  const init = error.init;
  return typeof init === "object" &&
    init !== null &&
    "status" in init &&
    typeof init.status === "number"
    ? init.status
    : 200;
};

/**
 * A thrown value is an error of the span unless React Router sends it as a
 * response below 500, such as a redirect or `data(..., 404)`.
 */
const isSpanError = (error: unknown): boolean => {
  const status = thrownStatus(error);
  return status === undefined || status >= 500;
};

/** What every route function gets, as far as tracing reads it. */
interface TracedArgs {
  readonly context: Readonly<RouterContextProvider>;
  /** The routed pattern of the request, such as `/posts/:id`. */
  readonly pattern?: string | undefined;
}

/** The kind of route function, as React Router names it. */
type Operation = "middleware" | "loader" | "action";

/**
 * Runs a route function in a span of its own when the request is traced,
 * such as `react-router.loader routes/home`, and sets `http.route` on the
 * request's span.
 *
 * The spans follow React Router's structure. A middleware's span is the
 * parent of everything its `next()` runs: the next middleware, then the
 * loaders and the action. A route Effect nests under its function's span, and
 * so do the clients an OpenTelemetry instrumentation traces, since Effect's
 * OpenTelemetry tracer makes the span active while the function is called.
 *
 * The request store's parent span passes the structure down. A loader or an
 * action reads it once, when it is called. A middleware's span stays there
 * for the rest of the chain, until the middleware finishes; an Effect
 * middleware's own spans around `next()` take its place there.
 */
const traced =
  <Args extends TracedArgs, Rest extends ReadonlyArray<unknown>>(
    operation: Operation,
    routeId: string,
    storeKey: RouterContext<Context.Context<never>>,
    fn: (args: Args, ...rest: Rest) => Promise<unknown>,
  ) =>
  (args: Args, ...rest: Rest): Promise<unknown> => {
    const requestSpan = args.context.get(requestSpanKey);
    if (requestSpan === undefined) return fn(args, ...rest);
    if (typeof args.pattern === "string") {
      // React Router joins the route paths, so a root route without a path leaves out the leading slash.
      const route = args.pattern.startsWith("/") ? args.pattern : `/${args.pattern}`;
      requestSpan.attribute("http.route", route);
    }
    const store = args.context.get(storeKey);
    const program = Effect.useSpan(
      `react-router.${operation} ${routeId}`,
      {
        kind: "internal",
        attributes: {
          "react_router.operation.name": operation,
          "react_router.route.id": routeId,
        },
      },
      (span) =>
        Effect.sync(() => {
          args.context.set(storeKey, Context.add(store, Tracer.ParentSpan, span));
          const settled = settle(() => fn(args, ...rest));
          if (operation !== "middleware") args.context.set(storeKey, store);
          return settled;
        }).pipe(
          Effect.withParentSpan(span),
          Effect.flatMap((settled) => Effect.promise(() => settled)),
          Effect.flatMap((result) =>
            result.ok || !isSpanError(result.error)
              ? Effect.succeed(result)
              : Effect.fail(result.error),
          ),
        ),
    );
    return Effect.runPromiseExitWith(store)(program).then((exit) => {
      if (operation === "middleware") args.context.set(storeKey, store);
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      if (exit.value.ok) return exit.value.value;
      throw exit.value.error;
    });
  };

// ---------------------------------------------------------------------------
// Build wrapping.
// ---------------------------------------------------------------------------

type ServerRoute = NonNullable<ServerBuild["routes"][string]>;
type ServerRouteModule = ServerRoute["module"];

/**
 * Wraps a route module's loader, action and middleware with the factory's
 * runner, and traces them. The module itself is left as it is.
 */
const wrapModule = (
  routeId: string,
  module: ServerRouteModule,
  handlers: RouteHandlers,
): ServerRouteModule => {
  const store = handlers.requestContext;
  return {
    ...module,
    loader:
      module.loader === undefined
        ? undefined
        : traced("loader", routeId, store, handlers.loader(module.loader)),
    action:
      module.action === undefined
        ? undefined
        : traced("action", routeId, store, handlers.action(module.action)),
    middleware: module.middleware?.map(
      // A wrapped middleware resolves with what the original returns: the
      // route's response, data, or nothing.
      (fn) =>
        traced(
          "middleware",
          routeId,
          store,
          handlers.middleware(fn),
        ) as MiddlewareFunction<Response>,
    ),
  };
};

/** Wraps every route module of a build. */
const wrapBuild = (build: ServerBuild, handlers: RouteHandlers): ServerBuild => ({
  ...build,
  routes: Object.fromEntries(
    Object.entries(build.routes).map(([id, route]) => [
      id,
      route === undefined
        ? undefined
        : { ...route, module: wrapModule(id, route.module, handlers) },
    ]),
  ),
});

/** React Router's request handler, as `createRequestHandler` returns it. */
export type RequestHandler = (
  request: Request,
  context: RouterContextProvider,
) => Promise<Response>;

/** A loaded build and React Router's request handler for it. */
export interface LoadedBuild {
  readonly build: ServerBuild;
  readonly handler: RequestHandler;
}

/**
 * Loads the build and returns React Router's request handler for it. The
 * handler is built once per build value: React Router rebuilds its route
 * tables on every request when it is given a function, so the adapter
 * resolves the build itself. In development a new build after a change gets a
 * new handler. The last handler is kept across calls, since a development
 * server can make the app for each request.
 */
export const makeBuildLoader = (
  source: BuildSource,
  handlers: RouteHandlers,
  mode: string | undefined,
): Effect.Effect<LoadedBuild> => {
  let cached: LoadedBuild | undefined;
  return Effect.promise(async () => {
    const build = typeof source === "function" ? await source() : source;
    if (cached?.build !== build) {
      cached = {
        build,
        handler: createRequestHandler(wrapBuild(build, handlers), mode),
      };
    }
    return cached;
  });
};

// ---------------------------------------------------------------------------
// Calling React Router.
// ---------------------------------------------------------------------------

/**
 * Calls React Router. The call starts in the request fiber, so code that
 * reads the async context, such as an OpenTelemetry tracer whose context the
 * Effect tracer sets, sees the request's. When the request fiber is
 * interrupted, because the client left, the request signal aborts, and a
 * response that React Router resolves afterwards has its body cancelled.
 *
 * Effect's HTTP server runs the app uninterruptible, and interrupts the fiber
 * only where the app opts in, so the call is interruptible.
 */
export const callRouter = (
  handler: RequestHandler,
  request: Request,
  context: RouterContextProvider,
  controller: AbortController,
): Effect.Effect<Response> =>
  Effect.callback<Response>((resume) => {
    let interrupted = false;
    handler(request, context).then(
      (response) => {
        if (interrupted) {
          response.body?.cancel().catch(() => undefined);
          return;
        }
        resume(Effect.succeed(response));
      },
      (error: unknown) => {
        if (!interrupted) resume(Effect.die(error));
      },
    );
    return Effect.sync(() => {
      interrupted = true;
      controller.abort();
    });
  }).pipe(Effect.interruptible);

// ---------------------------------------------------------------------------
// The services of one request.
// ---------------------------------------------------------------------------

/** What an adapter needs of a route factory: its route runner. */
export interface RouteFactoryLike {
  readonly handlers: RouteHandlers;
}

/**
 * The services of a factory's runtime, as its types record them: what a
 * request layer may require. A factory whose types are unknown, such as the
 * `RouteFactoryLike` of an adapter's default options, admits any.
 */
export type RuntimeServicesOf<Factory> = Factory extends {
  readonly "~types": { readonly Runtime: infer Services };
}
  ? Services
  : // oxlint-disable-next-line typescript/no-explicit-any -- the default options accept every factory.
    any;

/**
 * A request layer: the services of one request. The adapter builds it for
 * every request, in a scope of its own, and closes the scope when the
 * response ends. `RIn` is what the layer may require.
 */
export type RequestLayer<RIn> = Layer.Layer<never, unknown, RIn>;

/** The context of the factory's runtime, or an empty context without one. */
export const runtimeContextOf = (
  handlers: RouteHandlers,
): Effect.Effect<Context.Context<never>, unknown> =>
  handlers.runtime === undefined ? Effect.succeed(Context.empty()) : handlers.runtime.contextEffect;

/** The services a request layer built, and what closes them. */
export interface RequestScope {
  readonly context: Context.Context<never>;
  /** Closes the request layer's scope. Only the first call closes it. */
  readonly close: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>;
}

/**
 * Builds a request layer in a new scope, with the services of `context`
 * provided. A layer that the runtime already built is reused: building forks
 * the runtime's memo map, so every other layer is built for this request
 * only. When building fails, the scope closes before the failure returns.
 */
export const buildRequestLayer = (
  layer: RequestLayer<unknown>,
  context: Context.Context<never>,
): Effect.Effect<RequestScope, unknown> =>
  Effect.suspend(() => {
    const scope = Scope.makeUnsafe();
    let closed = false;
    const close = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (closed) return Effect.void;
        closed = true;
        return Scope.close(scope, exit);
      });
    // The adapter's options type what the layer may require, and `context`
    // holds those services, so building it requires nothing more.
    const built = Layer.buildWithScope(layer, scope).pipe(
      Effect.provideContext(context),
    ) as Effect.Effect<Context.Context<never>, unknown>;
    return built.pipe(
      Effect.onError((cause) => close(Exit.failCause(cause))),
      Effect.map((services): RequestScope => ({ context: services, close })),
    );
  });

/**
 * A response whose body calls `done` once: when the body ends, fails, or the
 * client cancels it. A response without a body calls `done` at once and is
 * returned as it is.
 *
 * The body is read through a new stream, so the response is a new `Response`
 * with the same status and headers.
 */
export const onBodyEnd = (response: Response, done: () => void): Response => {
  const source = response.body;
  if (source === null) {
    done();
    return response;
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
