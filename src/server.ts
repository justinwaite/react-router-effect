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
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Scope,
  Stream,
  Tracer,
} from "effect";
import {
  Cookies,
  type HttpPlatform,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import {
  createContext,
  createRequestHandler,
  RouterContextProvider,
  type RouterContext,
  type ServerBuild,
  type MiddlewareFunction,
} from "react-router";

import type { RouteHandlers } from "./factory.ts";

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

/** A React Router server build, or a function that loads it, as in `createRequestHandler`. */
export type BuildSource = ServerBuild | (() => ServerBuild | Promise<ServerBuild>);

/** The options of {@link make}. */
export interface Options {
  /** The server build: `() => import("virtual:react-router/server-build")`. */
  readonly build: BuildSource;
  /** The route factory whose runner, runtime and error model route Effects use. */
  readonly factory: { readonly handlers: RouteHandlers };
  /** React Router's server mode. Defaults to `process.env.NODE_ENV`. */
  readonly mode?: string | undefined;
  /**
   * Serves the client build before React Router: the files of the build's
   * `assetsBuildDirectory`, under its `publicPath`. Files under `assets/` have
   * hashed names and are cached for a year as immutable, other files for an
   * hour. It serves like `express.static`: a directory serves its index file,
   * such as a prerendered page, its path without the trailing slash redirects
   * to the path with it, dotfiles are not served, and a request it does not
   * serve goes to React Router. Like `express.static`, it looks each GET and
   * HEAD request up in the file system. It serves only a build that it loads
   * once: in production mode, or a build value. A
   * development build is never served, since Vite serves the client there, nor
   * is a `publicPath` on another origin. Making the app fails with a
   * {@link ClientBuildError} when it cannot read the directory. Needs the
   * platform's file system, which `NodeHttpServer.layer` and the other server
   * layers provide.
   */
  readonly clientAssets?: boolean | undefined;
  /**
   * Builds the services of one request, before React Router runs. They join
   * the request's effect context, so every middleware, loader and action sees
   * them without a middleware that sets them.
   */
  readonly requestContext?: ((request: Request) => Context.Context<never>) | undefined;
}

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
// Client assets.
// ---------------------------------------------------------------------------

/** The services that serving the client build needs. */
export type ClientAssetServices = FileSystem.FileSystem | Path.Path | HttpPlatform.HttpPlatform;

/** The `Cache-Control` of the files under `assets/`, whose names include a content hash. */
const hashedCacheControl = "public, max-age=31536000, immutable";

/** The `Cache-Control` of the other client files, such as `favicon.ico`. */
const otherCacheControl = "public, max-age=3600";

/** Serves files of one directory, for the current request. */
type StaticFiles = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest
>;

/** The client build of one server build. */
interface ClientFiles {
  /** The `publicPath` without its trailing slash. */
  readonly prefix: string;
  readonly hashed: StaticFiles;
  readonly other: StaticFiles;
}

/**
 * True for a path with a segment that starts with a dot, such as `.vite/`,
 * which is never served. Effect's static server serves dotfiles, and Vite
 * writes its manifest there. `express.static` ignores them.
 */
const hasDotSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith("."));

/** True when a static lookup found no file, so the request goes on to React Router. */
const isNotFound = (error: HttpServerError.HttpServerError): boolean =>
  error.reason._tag === "RouteNotFound";

/**
 * The app serves the client build, and cannot read its directory. The
 * build's `assetsBuildDirectory` is relative to the working directory of the
 * server, so `directory` is the path it resolved to.
 */
export class ClientBuildError extends Data.TaggedError("ClientBuildError")<{
  readonly message: string;
  /** The resolved directory of the client build. */
  readonly directory: string;
  readonly cause: unknown;
}> {}

/**
 * The client files of a build, or `undefined` when the adapter does not serve
 * them. Making them reads the build's directory, so a missing client build
 * fails the server's start and not its requests.
 */
const makeClientFiles = (
  build: ServerBuild,
): Effect.Effect<ClientFiles | undefined, ClientBuildError, ClientAssetServices> =>
  Effect.gen(function* () {
    if (build.assets.hmr !== undefined || !build.publicPath.startsWith("/")) return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(build.assetsBuildDirectory);
    yield* fileSystem.readDirectory(root).pipe(
      Effect.mapError(
        (cause) =>
          new ClientBuildError({
            message: `Cannot read the client build at ${root}`,
            directory: root,
            cause,
          }),
      ),
    );
    const files = (cacheControl: string) =>
      HttpStaticServer.make({ root, cacheControl }).pipe(
        // Making a static server only resolves its root.
        Effect.orDie,
      );
    return {
      prefix: build.publicPath.replace(/\/$/, ""),
      hashed: yield* files(hashedCacheControl),
      other: yield* files(otherCacheControl),
    };
  });

/** The decoded path of a URL, or `undefined` when it does not decode. */
const decodePath = (path: string): string | undefined => {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
};

/**
 * Serves the request from the client build, or returns `None` when the build
 * has no such file: a path the build does not have, a directory without an
 * index file, a dotfile, a path outside the `publicPath`, or a method other
 * than GET and HEAD.
 */
const serveClientFile = (
  files: ClientFiles,
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  Option.Option<HttpServerResponse.HttpServerResponse>,
  HttpServerError.HttpServerError
> => {
  const path = request.url.split("?")[0] ?? "";
  if (
    (request.method !== "GET" && request.method !== "HEAD") ||
    !path.startsWith(`${files.prefix}/`)
  ) {
    return Effect.succeedNone;
  }
  const url = request.url.slice(files.prefix.length);
  const file = decodePath(url.split("?")[0] ?? "");
  // The decoded path, so an encoded dot such as `%2e` is a dotfile too.
  if (file === undefined || hasDotSegment(file)) return Effect.succeedNone;
  const serve = url.startsWith("/assets/") ? files.hashed : files.other;
  return serve.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, request.modify({ url })),
    Effect.map(Option.some),
    Effect.catchIf(isNotFound, () => Effect.succeedNone),
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
 * new handler. The last handler is kept across runs of {@link make}'s Effect,
 * since a development server can make the app for each request.
 */
const makeBuildLoader = (
  options: Options,
  mode: string | undefined,
): Effect.Effect<LoadedBuild> => {
  let cached: LoadedBuild | undefined;
  return Effect.promise(async () => {
    const build = typeof options.build === "function" ? await options.build() : options.build;
    if (cached?.build !== build) {
      cached = {
        build,
        handler: createRequestHandler(wrapBuild(build, options.factory.handlers), mode),
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

/** True when the options serve the client build. */
type ServesClientAssets<O> = O extends { readonly clientAssets: infer Serves }
  ? [Serves] extends [false | undefined]
    ? false
    : true
  : false;

/**
 * The Effect HTTP app {@link make} makes. Serving the client build adds the
 * static file server's errors to its errors.
 */
export type App<O extends Options> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | HttpServerError.RequestError
  | (ServesClientAssets<O> extends true ? HttpServerError.HttpServerError : never),
  HttpServerRequest.HttpServerRequest
>;

/**
 * Makes the Effect HTTP app that serves React Router. Run the Effect once,
 * when the server starts. In production it loads the build, and with
 * `clientAssets` it reads the client build's directory, so a missing one fails
 * the server's start with a {@link ClientBuildError} and not its requests.
 *
 * ```ts
 * import { ReactRouterHttp } from "react-router-effect/server";
 *
 * export const reactRouterApp = ReactRouterHttp.make({
 *   build: () => import("virtual:react-router/server-build"),
 *   factory: routeFactory,
 *   clientAssets: true,
 * });
 *
 * // Serve it like any Effect HTTP app, with the app's own middleware.
 * Layer.unwrap(
 *   Effect.map(reactRouterApp, (app) => HttpServer.serve(app, HttpMiddleware.logger)),
 * );
 * ```
 *
 * In development, where the build changes, the app loads the build for each
 * request, and making it does nothing else.
 *
 * The request signal aborts only when the response ends early: when the
 * client leaves while React Router runs or while the body streams. A
 * completed response never aborts it.
 */
export const make = <const O extends Options>(
  options: O,
): Effect.Effect<
  App<O>,
  ServesClientAssets<O> extends true ? ClientBuildError : never,
  ServesClientAssets<O> extends true ? ClientAssetServices : never
> => {
  const mode = options.mode ?? process.env.NODE_ENV;
  const loadBuild = makeBuildLoader(options, mode);
  const settled = typeof options.build !== "function" || mode === "production";
  const made = Effect.gen(function* () {
    if (!settled) return serve(options, loadBuild, undefined);
    const loaded = yield* loadBuild;
    const files = options.clientAssets === true ? yield* makeClientFiles(loaded.build) : undefined;
    return serve(options, Effect.succeed(loaded), files);
  });
  // The client build's errors and requirements apply only when the options serve it.
  return made as unknown as Effect.Effect<
    App<O>,
    ServesClientAssets<O> extends true ? ClientBuildError : never,
    ServesClientAssets<O> extends true ? ClientAssetServices : never
  >;
};

/** The app for one loaded build source, and the client files it serves, if any. */
const serve = (
  options: Options,
  loadBuild: Effect.Effect<LoadedBuild>,
  files: ClientFiles | undefined,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError.RequestError | HttpServerError.HttpServerError,
  HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    if (files !== undefined) {
      const file = yield* serveClientFile(files, httpRequest);
      if (Option.isSome(file)) return file.value;
    }
    const { handler } = yield* loadBuild;
    // Route effects get the request fiber's context, without its scope: a
    // route that needs a scope opens its own with `Effect.scoped`.
    const fiberContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
    const controller = new AbortController();
    const request = yield* HttpServerRequest.toWeb(httpRequest, { signal: controller.signal });
    const routerContext = new RouterContextProvider();
    routerContext.set(
      options.factory.handlers.requestContext,
      Context.merge(fiberContext, options.requestContext?.(request) ?? Context.empty()),
    );
    routerContext.set(requestSpanKey, exportedSpan(fiberContext));
    const response = yield* callRouter(handler, request, routerContext, controller);
    return toHttpResponse(response, controller);
  }).pipe(
    // React Router logs and answers the errors of route code. A defect of the
    // adapter's own steps, such as a `requestContext` that throws, a build
    // that does not load, or React Router's handler rejecting, goes to the
    // app's loggers, and the client gets a 500, as Express's error handler
    // does. Answering it keeps a logger middleware from logging it again.
    Effect.catchDefect((defect) =>
      Effect.logError("React Router adapter failed", defect).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// The ReactRouter service.
// ---------------------------------------------------------------------------

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
    /** Answers the current request with React Router. */
    readonly handle: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      HttpServerError.RequestError,
      HttpServerRequest.HttpServerRequest
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
   * Registers React Router as the catch-all route of the app's router, for
   * every method on `/*`. A route that the app registers itself wins over it.
   * Register it at the root of the router: under a prefix, the router removes
   * the prefix from the request's URL.
   */
  static readonly routes: Layer.Layer<
    never,
    never,
    | HttpRouter.HttpRouter
    | ReactRouter
    | HttpRouter.Request.From<"Error", HttpServerError.RequestError>
  > = HttpRouter.use((router) =>
    Effect.flatMap(ReactRouter, ({ handle }) => router.add("*", "/*", handle)),
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
const makeReactRouter = <R>(
  options: ReactRouter.Options<R>,
): Effect.Effect<ReactRouter["Service"], never, R> =>
  Effect.gen(function* () {
    const mode = options.mode ?? process.env.NODE_ENV;
    const loadBuild = makeBuildLoader(options, mode);
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
