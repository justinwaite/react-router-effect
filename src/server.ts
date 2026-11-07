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
import { Context, Data, Effect, Exit, FileSystem, Option, Path, Scope, Stream } from "effect";
import {
  Cookies,
  type HttpPlatform,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/http";
import { RouterContextProvider, type ServerBuild } from "react-router";

import {
  type BuildSource,
  buildRequestLayer,
  callRouter,
  exportedSpan,
  type LoadedBuild,
  makeBuildLoader,
  type RequestLayer,
  type RequestScope,
  requestSpanKey,
  type RouteFactoryLike,
  runtimeContextOf,
  type RuntimeServicesOf,
} from "./core.ts";

// ---------------------------------------------------------------------------
// Options.
// ---------------------------------------------------------------------------

export type { BuildSource } from "./core.ts";

/**
 * What the request layer may require: the services of the factory's runtime,
 * and the HTTP request.
 */
export type RequestLayerServices<Factory> =
  | RuntimeServicesOf<Factory>
  | HttpServerRequest.HttpServerRequest;

/** The options of {@link make}. */
export interface Options<
  Factory extends RouteFactoryLike = RouteFactoryLike,
  ClientAssets extends boolean | undefined = boolean | undefined,
> {
  /** The server build: `() => import("virtual:react-router/server-build")`. */
  readonly build: BuildSource;
  /** The route factory whose runner, runtime and error model route Effects use. */
  readonly factory: Factory;
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
  readonly clientAssets?: ClientAssets;
  /**
   * Builds the services of one request, before React Router runs. They join
   * the request's effect context, so every middleware, loader and action sees
   * them without a middleware that sets them.
   */
  readonly requestContext?: ((request: Request) => Context.Context<never>) | undefined;
  /**
   * Builds the services of one request as a layer, before React Router runs.
   * Use it for a service that holds a resource for one request, such as a
   * database connection or a transaction.
   *
   * The adapter builds the layer for every request that reaches React Router,
   * in a scope of its own, and closes the scope when the response ends: after
   * its body is sent, or when the client leaves. The layer may require the
   * services of the factory's runtime, the `HttpServerRequest`, and what
   * `requestContext` builds. A layer the runtime already built is reused.
   * Its services join the request's effect context, like `requestContext`'s.
   * When building the layer fails, the adapter logs the failure and answers
   * 500.
   *
   * @since 2.2.0
   */
  readonly requestLayer?:
    | ((request: Request) => RequestLayer<RequestLayerServices<Factory>>)
    | undefined;
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
  requestScope?: RequestScope,
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
          Stream.onExit((exit) => {
            const aborted = Exit.isSuccess(exit)
              ? Effect.void
              : Effect.sync(() => controller.abort());
            // The request layer's scope closes when the body ends, if Effect's HTTP
            // server has not closed it with the request's scope already.
            return requestScope === undefined
              ? aborted
              : Effect.andThen(aborted, requestScope.close(exit));
          }),
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
// The adapter.
// ---------------------------------------------------------------------------

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
export const make = <
  Factory extends RouteFactoryLike,
  const ClientAssets extends boolean | undefined = undefined,
>(
  options: Options<Factory, ClientAssets>,
): Effect.Effect<
  App<Options<Factory, ClientAssets>>,
  ServesClientAssets<Options<Factory, ClientAssets>> extends true ? ClientBuildError : never,
  ServesClientAssets<Options<Factory, ClientAssets>> extends true ? ClientAssetServices : never
> => {
  const mode = options.mode ?? process.env.NODE_ENV;
  const loadBuild = makeBuildLoader(options.build, options.factory.handlers, mode);
  const settled = typeof options.build !== "function" || mode === "production";
  const made = Effect.gen(function* () {
    if (!settled) return serve(options, loadBuild, undefined);
    const loaded = yield* loadBuild;
    const files = options.clientAssets === true ? yield* makeClientFiles(loaded.build) : undefined;
    return serve(options, Effect.succeed(loaded), files);
  });
  // The client build's errors and requirements apply only when the options serve it.
  return made as unknown as Effect.Effect<
    App<Options<Factory, ClientAssets>>,
    ServesClientAssets<Options<Factory, ClientAssets>> extends true ? ClientBuildError : never,
    ServesClientAssets<Options<Factory, ClientAssets>> extends true ? ClientAssetServices : never
  >;
};

/**
 * Builds the request layer, and ties its scope to the HTTP request's. Effect's
 * HTTP server closes the request's scope once the response is sent, or when
 * the client leaves; a streamed body keeps it open until the body ends. A
 * request without one closes the layer's scope when the body ends instead. A
 * failure to build the layer is a defect of the adapter: logged, and a 500.
 */
const openRequestScope = (
  options: Options,
  layer: RequestLayer<unknown>,
  base: Context.Context<never>,
  httpScope: Scope.Scope | undefined,
): Effect.Effect<RequestScope> =>
  Effect.gen(function* () {
    const runtimeContext = yield* runtimeContextOf(options.factory.handlers);
    const opened = yield* buildRequestLayer(layer, Context.merge(runtimeContext, base));
    if (httpScope !== undefined) yield* Scope.addFinalizerExit(httpScope, opened.close);
    return opened;
  }).pipe(Effect.orDie);

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
    const requestFiberContext = yield* Effect.context<never>();
    // Route effects get the request fiber's context, without its scope: a
    // route that needs a scope opens its own with `Effect.scoped`.
    const fiberContext = Context.omit(Scope.Scope)(requestFiberContext);
    const controller = new AbortController();
    const request = yield* HttpServerRequest.toWeb(httpRequest, { signal: controller.signal });
    const base = Context.merge(fiberContext, options.requestContext?.(request) ?? Context.empty());
    const requestScope =
      options.requestLayer === undefined
        ? undefined
        : yield* openRequestScope(
            options,
            options.requestLayer(request),
            base,
            Context.getOrUndefined(requestFiberContext, Scope.Scope),
          );
    const routerContext = new RouterContextProvider();
    routerContext.set(
      options.factory.handlers.requestContext,
      requestScope === undefined ? base : Context.merge(base, requestScope.context),
    );
    routerContext.set(requestSpanKey, exportedSpan(fiberContext));
    const response = yield* callRouter(handler, request, routerContext, controller).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && requestScope !== undefined ? requestScope.close(exit) : Effect.void,
      ),
    );
    if (requestScope !== undefined && response.body === null) yield* requestScope.close(Exit.void);
    return toHttpResponse(response, controller, requestScope);
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
