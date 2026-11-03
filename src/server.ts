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
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { createReadableStreamFromReadable } from "@react-router/node";
import {
  Cause,
  Context,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Scope,
  Stream,
  Tracer,
} from "effect";
import {
  HttpMethod,
  type HttpPlatform,
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
   * hour. A development build is never served, since Vite serves the client
   * there, nor is a `publicPath` on another origin. Needs the platform's file
   * system, which `NodeHttpServer.layer` and the other server layers provide.
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
// Request conversion.
// ---------------------------------------------------------------------------

/**
 * The Web `Request` React Router gets, as `HttpServerRequest.toWeb` builds it,
 * from the request as the app's middleware left it: a middleware that applies
 * proxy headers with `request.modify` sets the origin React Router sees.
 *
 * A request body is read from Node's stream with React Router's own
 * `createReadableStreamFromReadable`, as `@react-router/node` reads it.
 * `toWeb` reads it through an Effect stream, which costs about 33 µs more per
 * request (`examples/basic/README.md`). A request that sends `Expect` keeps
 * Effect's stream, which sends the `100 Continue` when the body is read.
 */
const toWebRequest = (
  request: HttpServerRequest.HttpServerRequest,
  signal: AbortSignal,
): Effect.Effect<Request, HttpServerError.RequestError> => {
  if (!HttpMethod.hasBody(request.method) || request.headers.expect !== undefined) {
    return HttpServerRequest.toWeb(request, { signal });
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return Effect.fail(
      new HttpServerError.RequestParseError({ request, description: "Invalid URL" }),
    );
  }
  const init: RequestInit & { readonly duplex: "half" } = {
    method: request.method,
    headers: request.headers,
    signal,
    body: createReadableStreamFromReadable(NodeHttpServerRequest.toIncomingMessage(request)),
    // A streamed request body needs half duplex.
    duplex: "half",
  };
  return Effect.succeed(new Request(url.value, init));
};

// ---------------------------------------------------------------------------
// Response conversion.
// ---------------------------------------------------------------------------

/**
 * Aborts the request signal when the Node response closes before it finished:
 * the client left while React Router ran or while the body streamed, or a
 * write failed. React Router then stops streamed promises, and route code
 * sees the abort. `@react-router/node` aborts its signal the same way. A
 * completed response never aborts it.
 *
 * One listener per request costs less than watching the body stream, which
 * would wrap every chunk.
 */
const abortOnClose = (
  request: HttpServerRequest.HttpServerRequest,
  controller: AbortController,
): void => {
  const response = NodeHttpServerRequest.toServerResponse(request);
  response.once("close", () => {
    if (!response.writableFinished) controller.abort();
  });
};

/**
 * Converts React Router's response. Its `Set-Cookie` values go to the Node
 * response unchanged, as `@react-router/node` writes them: an
 * `HttpServerResponse` holds one raw `set-cookie` header, and writes the
 * cookies of its record again from their parsed form.
 */
const toHttpResponse = (
  request: HttpServerRequest.HttpServerRequest,
  response: Response,
): HttpServerResponse.HttpServerResponse => {
  const headers: Record<string, string> = {};
  let hasCookies = false;
  // A Web `Headers` iterates `set-cookie` values one by one, and every other header once, combined.
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") hasCookies = true;
    else headers[name] = value;
  }
  if (hasCookies) {
    NodeHttpServerRequest.toServerResponse(request).appendHeader(
      "set-cookie",
      response.headers.getSetCookie(),
    );
  }
  // React Router leaves `statusText` empty; Node then sends its standard reason phrase.
  const init = {
    status: response.status,
    statusText: response.statusText === "" ? undefined : response.statusText,
    headers,
  };
  const body = response.body;
  return body === null
    ? HttpServerResponse.empty(init)
    : HttpServerResponse.stream(
        Stream.fromReadableStream({ evaluate: () => body, onError: (error) => error }),
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
  /**
   * The paths in the client build, files and directories, from its root, such
   * as `/assets/entry.js`. Paths with a dot segment, such as `.vite/`, are left
   * out: Effect's static server serves dotfiles, and Vite writes its manifest there.
   */
  readonly paths: ReadonlySet<string>;
  readonly hashed: StaticFiles;
  readonly other: StaticFiles;
}

/** True for a path with a segment that starts with a dot, such as `.vite/`, which is never served. */
const hasDotSegment = (path: string): boolean =>
  path.split("/").some((segment) => segment.startsWith("."));

/** True when a static lookup found no file, so the request goes on to React Router. */
const isNotFound = (error: HttpServerError.HttpServerError): boolean =>
  error.reason._tag === "RouteNotFound";

/**
 * The client files of a build, or `undefined` when the adapter does not serve
 * them. A production client build does not change, so its paths are listed
 * once, and a request for any other path goes to React Router without a file
 * system lookup.
 */
const makeClientFiles = (
  build: ServerBuild,
): Effect.Effect<ClientFiles | undefined, never, ClientAssetServices> =>
  Effect.gen(function* () {
    if (build.assets.hmr !== undefined || !build.publicPath.startsWith("/")) return undefined;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = build.assetsBuildDirectory;
    // A missing client build serves nothing.
    const entries = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const files = (cacheControl: string) =>
      HttpStaticServer.make({ root, index: undefined, cacheControl }).pipe(
        // Making a static server only resolves its root.
        Effect.orDie,
      );
    // Only listed paths are served, so leaving dotfiles out of the list is the whole dotfile rule:
    // a request is looked up by its decoded path, so an encoded dot such as `%2e` finds nothing either.
    const paths = entries
      .map((entry) => `/${entry.split(path.sep).join("/")}`)
      .filter((entry) => !hasDotSegment(entry));
    return {
      prefix: build.publicPath.replace(/\/$/, ""),
      paths: new Set(paths),
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
 * has no such file: a path the build does not have, a directory, a dotfile, a
 * path outside the `publicPath`, or a method other than GET and HEAD.
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
  if (file === undefined || !files.paths.has(file)) return Effect.succeedNone;
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
 * Loads the build and returns React Router's request handler for it, as a
 * value once it is known not to change. The handler is built once per build
 * value: React Router rebuilds its route tables on every request when it is
 * given a function, so the adapter resolves the build itself. In development
 * a new build after a change gets a new handler. In production the build
 * cannot change, so the adapter loads it once.
 */
const makeBuildSource = (options: Options): Effect.Effect<LoadedBuild> => {
  let cached: LoadedBuild | undefined;
  const mode = options.mode ?? process.env.NODE_ENV;
  const settled = typeof options.build !== "function" || mode === "production";
  const load = async (): Promise<LoadedBuild> => {
    const build = typeof options.build === "function" ? await options.build() : options.build;
    if (cached?.build !== build) {
      cached = {
        build,
        handler: createRequestHandler(wrapBuild(build, options.factory.handlers), mode),
      };
    }
    return cached;
  };
  return Effect.suspend(() =>
    settled && cached !== undefined ? Effect.succeed(cached) : Effect.promise(load),
  );
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
  });

/** True when the options serve the client build. */
type ServesClientAssets<O> = O extends { readonly clientAssets: infer Serves }
  ? [Serves] extends [false | undefined]
    ? false
    : true
  : false;

/**
 * The Effect HTTP app {@link make} returns. Serving the client build adds the
 * platform's file system to its requirements, and the static file server's
 * errors to its errors.
 */
export type App<O extends Options> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  | HttpServerError.RequestError
  | (ServesClientAssets<O> extends true ? HttpServerError.HttpServerError : never),
  | HttpServerRequest.HttpServerRequest
  | (ServesClientAssets<O> extends true ? ClientAssetServices : never)
>;

/**
 * Serves React Router from the Effect HTTP server.
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
 * HttpServer.serve(reactRouterApp, HttpMiddleware.logger);
 * ```
 *
 * The request signal aborts only when the response ends early: when the
 * client leaves while React Router runs or while the body streams. A
 * completed response never aborts it.
 */
export const make = <const O extends Options>(options: O): App<O> => {
  const loadBuild = makeBuildSource(options);
  let clientFiles:
    | { readonly build: ServerBuild; readonly files: ClientFiles | undefined }
    | undefined;
  const clientFilesOf = (build: ServerBuild) =>
    clientFiles?.build === build
      ? Effect.succeed(clientFiles.files)
      : Effect.map(makeClientFiles(build), (files) => {
          clientFiles = { build, files };
          return files;
        });
  const app = Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const { build, handler } = yield* loadBuild;
    if (options.clientAssets === true) {
      const files = yield* clientFilesOf(build);
      const file = files === undefined ? Option.none() : yield* serveClientFile(files, httpRequest);
      if (Option.isSome(file)) return file.value;
    }
    // Route effects get the request fiber's context, without its scope: a
    // route that needs a scope opens its own with `Effect.scoped`.
    const fiberContext = Context.omit(Scope.Scope)(yield* Effect.context<never>());
    const controller = new AbortController();
    abortOnClose(httpRequest, controller);
    const request = yield* toWebRequest(httpRequest, controller.signal);
    const routerContext = new RouterContextProvider();
    routerContext.set(
      options.factory.handlers.requestContext,
      Context.merge(fiberContext, options.requestContext?.(request) ?? Context.empty()),
    );
    routerContext.set(requestSpanKey, exportedSpan(fiberContext));
    const response = yield* callRouter(handler, request, routerContext, controller);
    return toHttpResponse(httpRequest, response);
  });
  // The client build's requirements apply only when the options serve it.
  return app as unknown as App<O>;
};
