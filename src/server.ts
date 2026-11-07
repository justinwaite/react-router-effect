/**
 * Serves a React Router framework-mode build from Effect's Node HTTP server.
 *
 * The adapter converts each `HttpServerRequest` into a Web `Request`, calls
 * React Router's own request handler, and streams the `Response` back. React
 * Router keeps doing everything it does for any other server adapter:
 * documents, `.data` requests, streamed promises, resource routes, the lazy
 * route manifest, and middleware.
 *
 * The adapter owns everything between the Effect HTTP request and React
 * Router: the Web `Request` and its abort signal, the route factory, and the
 * conversion of React Router's `Response`, cookies and streamed body included.
 * Listening, static files, compression, proxies, tracing and the other server
 * concerns stay with the app's Effect HTTP server.
 *
 * Before React Router sees the build, the adapter wraps every loader, action
 * and middleware with the route factory's runner. A route function that
 * returns an Effect runs through the factory's error model, with the factory's
 * runtime and the request's effect context. Any other route function passes
 * through unchanged, so existing promise loaders and `makeLoader` wrappers keep
 * working.
 *
 * @since 2.1.0
 */
import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Record,
  Scope,
  Stream,
  Struct,
  Tracer,
} from "effect";
import {
  Cookies,
  HttpMethod,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import {
  createContext,
  createRequestHandler,
  RouterContextProvider,
  type RouterContext,
  type ServerBuild,
  type ServerInstrumentation,
  type MiddlewareFunction,
} from "react-router";

import type { RouteHandlers } from "./factory.ts";

/** A React Router server build, or a function that loads it, as in `createRequestHandler`. */
type BuildSource = ServerBuild | (() => ServerBuild | Promise<ServerBuild>);

// ---------------------------------------------------------------------------
// Response conversion.
// ---------------------------------------------------------------------------

/**
 * Converts React Router's response. Its `Set-Cookie` values become the
 * response's cookies, as `HttpServerResponse.fromWeb` converts them, so
 * middleware after the adapter can read and change them. Effect keeps one
 * cookie per name, the last one, and only the attributes it knows.
 *
 * Effect gives a streamed body without a content type
 * `application/octet-stream`, so a route that sends a body sets its own.
 *
 * When the body stream ends before it finished, because the client left or a
 * write failed, the request signal aborts: React Router then stops streamed
 * promises, and route code sees the abort. A completed response never aborts it.
 */
const toHttpResponse = (
  response: Response,
  controller: AbortController,
): HttpServerResponse.HttpServerResponse => {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  // React Router leaves `statusText` empty; Node then sends its standard reason phrase.
  const init = {
    status: response.status,
    statusText: response.statusText === "" ? undefined : response.statusText,
    headers,
    cookies: Cookies.fromSetCookie(response.headers.getSetCookie()),
  };
  const body = response.body;
  return body === null
    ? HttpServerResponse.empty(init)
    : HttpServerResponse.stream(
        Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }).pipe(
          Stream.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort()),
          ),
        ),
        init,
      );
};

// ---------------------------------------------------------------------------
// Tracing.
// ---------------------------------------------------------------------------

/**
 * The span of a traced request: the server span of Effect's HTTP tracer, with
 * a tracer that exports spans. Without it, the adapter adds no spans.
 */
const requestSpanKey: RouterContext<Tracer.Span | undefined> = createContext<
  Tracer.Span | undefined
>(undefined);

/**
 * The span of the request fiber, when a tracer exports it: not the native
 * tracer, whose spans go nowhere, and not an unsampled span.
 */
const exportedSpan = (context: Context.Context<never>): Tracer.Span | undefined => {
  const span = Context.getOrUndefined(context, Tracer.ParentSpan);
  return span?._tag === "Span" &&
    span.sampled &&
    Context.get(context, Tracer.Tracer) !== Tracer.nativeTracer
    ? span
    : undefined;
};

/**
 * The `http.route` of a routed pattern, such as `/posts/:id`. React Router
 * joins the route paths, so a root route without a path leaves out the
 * leading slash.
 */
const httpRoute = (pattern: string): string => (pattern.startsWith("/") ? pattern : `/${pattern}`);

/**
 * Sets `http.route` on the request's span to the pattern of the routes that
 * React Router matched, after React Router answered, also for a page that
 * runs no route function. React Router 8 gives the pattern to a request
 * handler hook. A request that matched no route keeps the router's `*`.
 */
const routeLabel: ServerInstrumentation = {
  handler(handler) {
    handler.instrument({
      async request(handleRequest, { context }) {
        const { meta } = await handleRequest();
        const span = context?.get(requestSpanKey);
        if (span !== undefined && meta !== undefined && meta.pattern !== "") {
          span.attribute("http.route", httpRoute(meta.pattern));
        }
      },
    });
  },
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
      requestSpan.attribute("http.route", httpRoute(args.pattern));
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

/**
 * Wraps every route module of a build, and adds the adapter's
 * instrumentations after the app's own in the server entry module. An app
 * often does not export `instrumentations`, and `Struct.evolve` changes only
 * the keys that an object has, so the key is set with `Struct.assign`.
 */
const wrapBuild = (
  build: ServerBuild,
  handlers: RouteHandlers,
  instrumentations: ReadonlyArray<ServerInstrumentation>,
): ServerBuild =>
  Struct.evolve(build, {
    entry: (entry) =>
      Struct.evolve(entry, {
        module: (module) =>
          Struct.assign(module, {
            instrumentations: Arr.appendAll(module.instrumentations ?? [], instrumentations),
          }),
      }),
    routes: (routes) =>
      Record.map(routes, (route, id) =>
        route === undefined
          ? undefined
          : Struct.evolve(route, { module: (module) => wrapModule(id, module, handlers) }),
      ),
  });

/** React Router's request handler, as `createRequestHandler` returns it. */
type RequestHandler = (request: Request, context: RouterContextProvider) => Promise<Response>;

/** A loaded build and React Router's request handler for it. */
interface LoadedBuild {
  readonly build: ServerBuild;
  readonly handler: RequestHandler;
}

/**
 * Loads the build and returns React Router's request handler for it. The
 * handler is built once per build value: React Router rebuilds its route
 * tables on every request when it is given a function, so the adapter
 * resolves the build itself. In development a new build after a change gets a
 * new handler. The last handler is kept across requests, since a development
 * build loads for each request.
 */
const makeBuildLoader = (
  options: Pick<ReactRouter.Options, "build" | "factory">,
  mode: string | undefined,
  instrumentations: ReadonlyArray<ServerInstrumentation>,
): Effect.Effect<LoadedBuild> => {
  let cached: LoadedBuild | undefined;
  return Effect.promise(async () => {
    const build = typeof options.build === "function" ? await options.build() : options.build;
    if (cached?.build !== build) {
      cached = {
        build,
        handler: createRequestHandler(
          wrapBuild(build, options.factory.handlers, instrumentations),
          mode,
        ),
      };
    }
    return cached;
  });
};

// ---------------------------------------------------------------------------
// The adapter.
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
const callRouter = (
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
// The ReactRouter service.
// ---------------------------------------------------------------------------

/**
 * The methods of React Router's routes. Not the method `*`, which also
 * registers HEAD: the router answers HEAD with the GET route of a path only
 * when no HEAD route matches it, so a HEAD route on `*` takes HEAD from every
 * GET route of the app.
 */
const routeMethods = Arr.filter(HttpMethod.all, (method) => method !== "HEAD");

/**
 * React Router, as a service of the Effect HTTP app. `ReactRouter.layer`
 * provides it, and `ReactRouter.routes` registers it on the app's router as
 * the catch-all route.
 *
 * ```ts
 * export const App = ReactRouter.routes.pipe(
 *   Layer.provide(
 *     ReactRouter.layer({
 *       build: () => import("virtual:react-router/server-build"),
 *       factory: routeFactory,
 *     }),
 *   ),
 * );
 * ```
 */
export class ReactRouter extends Context.Service<
  ReactRouter,
  {
    /**
     * The build, when the layer loaded it once at startup: a build value, or
     * a build function in production mode. `None` when the build loads for
     * each request.
     */
    readonly build: Option.Option<ServerBuild>;
    /**
     * Answers the current request with React Router. The Scope is the
     * request's scope: the resources that `loadContext` opens close with it.
     */
    readonly handle: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      HttpServerError.RequestError,
      HttpServerRequest.HttpServerRequest | Scope.Scope
    >;
  }
>()("react-router-effect/ReactRouter") {
  /**
   * Provides React Router. A build value, or a build function in production
   * mode, loads when the layer builds. Provide one value of this layer to
   * every layer that reads the service: two values load the build twice.
   */
  static readonly layer = <R = never>(
    options: ReactRouter.Options<R>,
  ): Layer.Layer<ReactRouter, never, Exclude<R, Scope.Scope>> =>
    Layer.effect(ReactRouter, makeReactRouter(options));

  /**
   * Registers React Router as the catch-all route of the app's router, on
   * `*`, for every method of `HttpMethod.all` but HEAD. A route that the app
   * registers itself wins over it, also a route on `/`, such as the
   * prerendered home page of `ReactRouterAssets.layer`. A HEAD request uses
   * the GET route of its path, React Router's or the app's own, as Express
   * does. A method outside `HttpMethod.all` gets the router's 404. Register
   * it at the root of the router: under a prefix, the router removes the
   * prefix from the request's URL.
   */
  static readonly routes = HttpRouter.use((router) =>
    Effect.flatMap(ReactRouter, ({ handle }) =>
      router.addAll(routeMethods.map((method) => HttpRouter.route(method, "*", handle))),
    ),
  );
}

export declare namespace ReactRouter {
  /** The options of {@link ReactRouter.layer}. `R` is the requirement of `loadContext`. */
  export interface Options<R = never> {
    /** The server build: `() => import("virtual:react-router/server-build")`. */
    readonly build: BuildSource;
    /** The route factory whose runner, runtime and error model route Effects use. */
    readonly factory: { readonly handlers: RouteHandlers };
    /** React Router's server mode. Defaults to `process.env.NODE_ENV`. */
    readonly mode?: string | undefined;
    /**
     * Makes React Router's load context for each request, as `getLoadContext`
     * does for `@react-router/express`. Plain loaders and actions, and
     * `handleRequest` in `entry.server.tsx`, read its values with
     * `context.get`. Route Effects read services from their Effect context,
     * so an app gives them services with router middleware, not here. The
     * adapter adds its own keys to the provider. The Effect gets the services
     * of `R` from the layer, and the services of the request, which win over
     * the services of the layer. A defect answers an empty 500.
     */
    readonly loadContext?:
      | ((
          request: HttpServerRequest.HttpServerRequest,
        ) => Effect.Effect<RouterContextProvider, never, R>)
      | undefined;
  }
}

/**
 * Makes the service. A build value, or a build function in production mode,
 * loads once here, so a build that does not load stops the server's start.
 * Any other build loads for each request, and gets a new React Router handler
 * when its value changes.
 */
const makeReactRouter = Effect.fnUntraced(function* <R>(options: ReactRouter.Options<R>) {
  const mode = options.mode ?? process.env.NODE_ENV;
  // The tracer of the layer. With the native tracer, whose spans go
  // nowhere, React Router gets no hook, and does no work for it on a request.
  const tracer = yield* Effect.tracer;
  const loadBuild = makeBuildLoader(
    options,
    mode,
    tracer === Tracer.nativeTracer ? [] : [routeLabel],
  );
  const handlers = options.factory.handlers;
  // The request's own services, such as its scope and its span, win over
  // the services of the layer, as `HttpApiMiddleware` merges them.
  const services = yield* Effect.context<R>();
  const { loadContext } = options;
  const provided: ReactRouter.Options["loadContext"] =
    loadContext === undefined
      ? undefined
      : (request) =>
          Effect.updateContext(loadContext(request), (requestContext: Context.Context<never>) =>
            Context.merge(services, requestContext),
          );
  if (typeof options.build === "function" && mode !== "production") {
    return ReactRouter.of({
      build: Option.none(),
      handle: handleRequest(handlers, loadBuild, provided),
    });
  }
  const loaded = yield* loadBuild;
  return ReactRouter.of({
    build: Option.some(loaded.build),
    handle: handleRequest(handlers, Effect.succeed(loaded), provided),
  });
});

/**
 * Answers the current request with React Router. Route Effects get the
 * request fiber's context without its scope, so they see the services that
 * the app's router middleware provides. A route that needs a scope opens its
 * own with `Effect.scoped`.
 */
const handleRequest = (
  handlers: RouteHandlers,
  loadBuild: Effect.Effect<LoadedBuild>,
  loadContext: ReactRouter.Options["loadContext"],
): ReactRouter["Service"]["handle"] =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const { handler } = yield* loadBuild;
    const fiberContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
    const controller = new AbortController();
    const request = yield* HttpServerRequest.toWeb(httpRequest, { signal: controller.signal });
    const routerContext =
      loadContext === undefined ? new RouterContextProvider() : yield* loadContext(httpRequest);
    routerContext.set(handlers.requestContext, fiberContext);
    routerContext.set(requestSpanKey, exportedSpan(fiberContext));
    const response = yield* callRouter(handler, request, routerContext, controller);
    return toHttpResponse(response, controller);
  }).pipe(
    // React Router logs and answers the errors of route code. A defect of the
    // adapter's own steps, such as a `loadContext` that dies, a build that
    // does not load, or React Router's handler rejecting, goes to the app's
    // loggers, and the client gets an empty 500, as Express's error handler
    // answers.
    Effect.catchDefect((defect) =>
      Effect.logError("React Router adapter failed", defect).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  );
