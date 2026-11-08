/**
 * Serves the client build of a React Router app from the app's Effect HTTP
 * router, as the `express.static` lines of React Router's Express template
 * do.
 *
 * Its API is unstable: a minor version can change it.
 *
 * @stability unstable
 * @since 2.2.0
 */
import { Array as Arr, Data, Effect, FileSystem, type Layer, Option, Path } from "effect";
import {
  type HttpPlatform,
  HttpRouter,
  HttpServerRespondable,
  HttpStaticServer,
} from "effect/http";
import type { ServerBuild } from "react-router";

import { ReactRouter } from "./server.ts";

/**
 * The layer cannot serve the client build: it cannot read the directory, or
 * a file name has a `*`, which the router cannot match. The build's
 * `assetsBuildDirectory` is relative to the working directory of the server,
 * so `directory` is the path that it resolved to.
 *
 * @stability unstable
 * @since 2.2.0
 */
export class ClientBuildError extends Data.TaggedError("ClientBuildError")<{
  readonly message: string;
  /** The resolved directory of the client build. */
  readonly directory: string;
  readonly cause: unknown;
}> {}

/** The `Cache-Control` of the files in the hashed directory, whose names include a content hash. */
const hashedCacheControl = "public, max-age=31536000, immutable";

/** The `Cache-Control` of the other files of the client build. */
const otherCacheControl = "public, max-age=3600";

/**
 * The index file of a directory. React Router writes a prerendered page as
 * the `index.html` of its path's directory, and it is the default index of
 * `HttpStaticServer.make`.
 */
const indexFile = "index.html";

/**
 * The directory of the hashed files, relative to `publicPath`, from the URL
 * of the manifest that the build plugin writes in it. `None` when the
 * manifest is not under `publicPath`, or is at its root.
 */
const hashedDirectory = (build: ServerBuild, path: Path.Path): Option.Option<string> => {
  const manifest = build.assets.url;
  if (!manifest.startsWith(build.publicPath)) return Option.none();
  const directory = path.dirname(manifest.slice(build.publicPath.length - 1));
  return directory === "/" ? Option.none() : Option.some(directory);
};

/**
 * The handler of a static server. A missing file is a 404. Any other error,
 * such as a file that the server cannot read, goes to the app's loggers
 * before the 500.
 */
const makeHandler = (options: {
  readonly root: string;
  readonly index: string | undefined;
  readonly cacheControl: string;
}) =>
  HttpStaticServer.make(options).pipe(
    // Making a static server only resolves its root.
    Effect.orDie,
    Effect.map((files) =>
      files.pipe(
        Effect.catchReason("HttpServerError", "RouteNotFound", HttpServerRespondable.toResponse),
        Effect.catch((error) =>
          Effect.logError("Cannot serve a client file", error).pipe(
            Effect.andThen(HttpServerRespondable.toResponse(error)),
          ),
        ),
      ),
    ),
  );

/**
 * Registers the routes of the client build on the app's router, for GET and
 * HEAD, under the build's `publicPath`.
 *
 * The hashed directory is the directory of the build's manifest URL, such as
 * `/assets`. The build plugin writes the files with a content hash in their
 * names there. Its files are cached for a year as immutable, and a request
 * under it for a file that the directory does not have gets a 404. The
 * files are served from that directory only, so a path with `..` does not
 * reach the other files of the client build.
 *
 * Each other file gets its own route, and is cached for an hour. A directory
 * with an `index.html`, such as a prerendered page, gets a route that serves
 * its `index.html`, and its path without the trailing slash redirects. The
 * layer serves no path with a segment that starts with a dot, such as
 * `.vite/`, as `express.static` ignores dotfiles. A root `index.html`, such
 * as a prerendered home page, gets the route `/`, which wins over the
 * catch-all of `ReactRouter.routes`. Any other request goes on to the app's
 * other routes.
 *
 * The layer reads the client build when it builds, so a file that something
 * adds outside the hashed directory later is served after a restart. It
 * fails with a {@link ClientBuildError} when it cannot read the client build
 * directory, or when a file name has a `*`, which the router cannot match.
 * A route of the app with the path of a file fails the server's start.
 *
 * The layer registers nothing for a build that loads for each request, such
 * as a development build, since Vite serves the client there. It also
 * registers nothing for a `publicPath` on another origin.
 *
 * The routes of this layer get the middleware that the app provides to this
 * layer. To leave the server's request logger out of file requests:
 *
 * ```ts
 * ReactRouterAssets.layer.pipe(Layer.provide(HttpRouter.disableLogger))
 * ```
 *
 * @stability unstable
 */
export const layer: Layer.Layer<
  never,
  ClientBuildError,
  | HttpRouter.HttpRouter
  | ReactRouter
  | FileSystem.FileSystem
  | Path.Path
  | HttpPlatform.HttpPlatform
> = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const { build: loaded } = yield* ReactRouter;
    if (Option.isNone(loaded)) return;
    const build = loaded.value;
    if (!build.publicPath.startsWith("/")) return;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(build.assetsBuildDirectory);
    const readError = (cause: unknown) =>
      new ClientBuildError({
        message: `Cannot read the client build at ${root}`,
        directory: root,
        cause,
      });
    const entries = yield* fileSystem
      .readDirectory(root, { recursive: true })
      .pipe(Effect.mapError(readError));
    const hashed = hashedDirectory(build, path);

    if (Option.isSome(hashed)) {
      const handler = yield* makeHandler({
        root: path.join(root, hashed.value),
        index: undefined,
        cacheControl: hashedCacheControl,
      });
      yield* router
        .prefixed(build.publicPath)
        .prefixed(hashed.value)
        .addAll([HttpRouter.route("GET", "/*", handler), HttpRouter.route("HEAD", "/*", handler)]);
    }

    /** The URL path of an entry of the client build, relative to `publicPath`. */
    const urlPath = (entry: string): HttpRouter.PathInput => `/${entry.split(path.sep).join("/")}`;
    const isServed = (url: string) =>
      !url.split("/").some((segment) => segment.startsWith(".")) &&
      Option.match(hashed, {
        onNone: () => true,
        onSome: (directory) => url !== directory && !url.startsWith(`${directory}/`),
      });
    const files = yield* Effect.filter(
      entries.filter((entry) => isServed(urlPath(entry))),
      (entry) =>
        fileSystem.stat(path.join(root, entry)).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.mapError(readError),
        ),
    );
    const directories = files
      .filter((file) => path.basename(file) === indexFile)
      .map((file) => path.dirname(file));
    const urls = Arr.appendAll(
      files.map(urlPath),
      // The root directory is `.`, whose URL path is `/`.
      directories.map((directory) => (directory === "." ? "/" : urlPath(directory))),
    );

    const unmatchable = Arr.findFirst(urls, (url) => url.includes("*"));
    if (Option.isSome(unmatchable)) {
      return yield* new ClientBuildError({
        message: `Cannot serve ${unmatchable.value} of the client build at ${root}: the router cannot match a * in a path`,
        directory: root,
        cause: undefined,
      });
    }

    const handler = yield* makeHandler({ root, index: indexFile, cacheControl: otherCacheControl });
    // A prefix of `/` changes the request URL on every request for nothing.
    const underPublicPath = build.publicPath === "/" ? router : router.prefixed(build.publicPath);
    yield* underPublicPath.addAll(
      urls.flatMap((url) => {
        // The router reads `:` as the start of a parameter, unless it is doubled.
        const route: HttpRouter.PathInput = `/${url.slice(1).replaceAll(":", "::")}`;
        return [HttpRouter.route("GET", route, handler), HttpRouter.route("HEAD", route, handler)];
      }),
    );
  }),
);
