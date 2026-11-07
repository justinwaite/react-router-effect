/**
 * Serves the client build of a React Router app from the app's Effect HTTP
 * router, as the `express.static` lines of React Router's Express template
 * do.
 *
 * @since 3.0.0
 */
import { Effect, FileSystem, type Layer, Option, Path } from "effect";
import {
  type HttpPlatform,
  HttpRouter,
  HttpServerRespondable,
  HttpStaticServer,
} from "effect/http";
import type { ServerBuild } from "react-router";

import { ClientBuildError, ReactRouter } from "./server.ts";

export { ClientBuildError };

/** The `Cache-Control` of the files in the hashed directory, whose names include a content hash. */
const hashedCacheControl = "public, max-age=31536000, immutable";

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
 * The layer registers nothing for a build that loads for each request, such
 * as a development build, since Vite serves the client there. It also
 * registers nothing for a `publicPath` on another origin. It fails with a
 * {@link ClientBuildError} when it cannot read the client build directory.
 *
 * The routes of this layer get the middleware that the app provides to this
 * layer. To leave the server's request logger out of file requests:
 *
 * ```ts
 * ReactRouterAssets.layer.pipe(Layer.provide(HttpRouter.disableLogger))
 * ```
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
    const hashed = hashedDirectory(build, path);
    if (Option.isSome(hashed)) {
      const files = yield* HttpStaticServer.make({
        root: path.join(root, hashed.value),
        index: undefined,
        cacheControl: hashedCacheControl,
      }).pipe(
        // Making a static server only resolves its root.
        Effect.orDie,
      );
      // A missing file is a 404. Any other error, such as a file that the
      // server cannot read, goes to the app's loggers before the 500.
      const handler = files.pipe(
        Effect.catchReason("HttpServerError", "RouteNotFound", HttpServerRespondable.toResponse),
        Effect.catch((error) =>
          Effect.logError("Cannot serve a client file", error).pipe(
            Effect.andThen(HttpServerRespondable.toResponse(error)),
          ),
        ),
      );
      yield* router
        .prefixed(build.publicPath)
        .prefixed(hashed.value)
        .addAll([HttpRouter.route("GET", "/*", handler), HttpRouter.route("HEAD", "/*", handler)]);
    }
  }),
);
