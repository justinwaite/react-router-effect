# react-router-effect

## 2.3.0

### Minor Changes

- [#83](https://github.com/justinwaite/react-router-effect/pull/83) [`6120aae`](https://github.com/justinwaite/react-router-effect/commit/6120aae85ee9ed472d5e1398ba7168470e974083) Thanks [@Mando75](https://github.com/Mando75)! - The route factory now returns `defer`, which is unstable. It starts an Effect without waiting for it, and gives a promise of the result for loader data. React Router streams the promise to `<Await>`. The deferred work gets the services and the span of the loader, and keeps running after the loader returns. An aborted request or a failed loader stops it.
  
  The deferred Effect can fail only with the factory's domain errors, `Respond.early` and `Respond.throw`. The error handlers turn a failure into the promise's value or an `ErrorResponse` for `useAsyncError`. Any other failure rejects the promise with an error that has no server details, and the server logs the cause. An error that the factory does not handle does not compile. Fixes [#77](https://github.com/justinwaite/react-router-effect/issues/77).

- [#82](https://github.com/justinwaite/react-router-effect/pull/82) [`75aa17a`](https://github.com/justinwaite/react-router-effect/commit/75aa17a6c26c9381aaee6650fa46b6022d219dd7) Thanks [@Mando75](https://github.com/Mando75)! - The route factory now attaches its request metadata to the data of every loader, as it does for every action. The types of plain Effect loaders already included the optional `__meta` key, but the key was never there at runtime. Fixes [#78](https://github.com/justinwaite/react-router-effect/issues/78).
  
  The metadata API has new names, because it is no longer only for actions:
  
  - The factory configuration `actionMeta` is now `routeMeta`.
  - The `Register` key `actionMeta` is now `routeMeta`.
  - `ActionMetaArgs` is now `RouteMetaArgs`, `WithActionMeta` is now `WithRouteMeta`, and `actionMetaKey` is now `routeMetaKey`.
  
  The `makeLoader` wrapper now types its data with the metadata, as `makeAction` does. To migrate, rename `actionMeta` to `routeMeta` in the factory configuration and in `Register`.
  
  The route metadata API is unstable, and a minor version can change it. The rest of the route factory stays stable.

### Patch Changes

- [#80](https://github.com/justinwaite/react-router-effect/pull/80) [`27f7fd5`](https://github.com/justinwaite/react-router-effect/commit/27f7fd58c9b7c4302613038862c49d305f0d9c04) Thanks [@Mando75](https://github.com/Mando75)! - Under the Vite dev server, the adapter now attaches `actionMeta` to a `data(...)` that the app builds. The app and the adapter can load different copies of React Router there. The adapter now finds a `data(...)` wrapper by its shape, as React Router does, and not by its class. A record with the fields `type: "DataWithResponseInit"`, `data` and `init` now gets the metadata on `data`, because React Router sends only that field. Fixes [#79](https://github.com/justinwaite/react-router-effect/issues/79).

## 2.2.0

### Minor Changes

- [#71](https://github.com/justinwaite/react-router-effect/pull/71) [`bf9d4c8`](https://github.com/justinwaite/react-router-effect/commit/bf9d4c8485721fb30079d05fd02cbac2207369d6) Thanks [@Mando75](https://github.com/Mando75)! - Serve React Router with layers of Effect's `HttpRouter`, on Node or on Cloudflare Workers. The new layers replace `ReactRouterHttp.make` and `ReactRouterVite.devMiddleware`.
  
  The adapter's API is unstable, and a minor version can change it. Every export of `react-router-effect/server` and `react-router-effect/vite` has the JSDoc tag `@stability unstable`. The route factory and the other exports of `react-router-effect` are stable.
  
  - `ReactRouter.layer(options)` provides the `ReactRouter` service: the build, and the Effect that answers a request. Its options are `build`, `factory`, `mode` and `loadContext`. `loadContext` makes React Router's load context for each request, as `getLoadContext` does for `@react-router/express`.
  - `mode` is required, such as `import.meta.env.MODE`. The adapter no longer reads `process.env.NODE_ENV`. As in React Router, any mode but `development` and `test` runs in production mode: the layer then loads a build function once, at layer build.
  - The same `App` serves on every platform of Effect's HTTP router. `HttpRouter.serve` serves it on Node. `HttpRouter.toWebHandler` serves it from a Cloudflare Worker, or from another runtime with Web requests and responses. On such a runtime, a client that cancels the streamed body also aborts the request signal. The repository's `examples/cloudflare` shows a Worker.
  - `ReactRouter.routes` registers React Router as the catch-all route of the app's router. A route of the app wins over it. A GET route of the app also answers HEAD, as it does in Express.
  - `ReactRouterAssets.layer` serves the client build as routes. It caches the hashed directory of the build's manifest for a year as immutable, and each other file for an hour. A directory with an `index.html` serves that file, and a root `index.html` serves `/`. The layer serves no dotfiles. If it cannot read the client build, the server fails to start with `ReactRouterAssets.ClientBuildError`.
  - `ReactRouterVite.layer(vite, loadApp)` serves the app in development on Node. It passes each request to Vite first. Then it serves the request with the `App` that `loadApp` returns, and it builds a new `App` after an edit. `ReactRouterVite.ViteDevServer` takes an optional `ssrFixStacktrace`, which maps the stack of an error to the source files.
  - `http.route` on the server span is the pattern of the matched routes. This is also true for a page that runs no route function, and under a router middleware that opens a span of its own.
  
  Removed: `ReactRouterHttp` with `make`, `Options`, `App`, `BuildSource` and `ClientAssetServices`, the `clientAssets` and `requestContext` options, and `ReactRouterVite.devMiddleware`. The adapter requires React Router 8.3 or later. The route factory and its wrappers still support React Router 7.16. The package now requires Node 22 or later (`engines.node`).
  
  To migrate, export an `App` layer from `server/app.ts`, and serve it from `server.js` with `HttpRouter.serve`. A route-scoped router middleware replaces `requestContext`. Before:
  
  ```ts
  // server/app.ts
  export const reactRouterApp = ReactRouterHttp.make({
    build: () => import("virtual:react-router/server-build"),
    factory: routeFactory,
    clientAssets: true,
    requestContext: (request) =>
      Context.make(RequestInfo, { id: request.headers.get("x-request-id") ?? crypto.randomUUID() }),
  });
  
  // server/main.ts, the entry of the server build
  Layer.unwrap(
    Effect.map(reactRouterApp, (app) => HttpServer.serve(app, HttpMiddleware.logger)),
  ).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
    Layer.launch,
    NodeRuntime.runMain,
  );
  ```
  
  After:
  
  ```ts
  // server/app.ts, the entry of the server build
  const RequestServices = HttpRouter.middleware((app) =>
    Effect.provideServiceEffect(
      app,
      RequestInfo,
      HttpServerRequest.HttpServerRequest.use((request) =>
        Effect.succeed({ id: request.headers["x-request-id"] ?? crypto.randomUUID() }),
      ),
    ),
  ).layer;
  
  export const App = Layer.mergeAll(
    ReactRouter.routes.pipe(Layer.provide(RequestServices)),
    ReactRouterAssets.layer,
  ).pipe(
    Layer.provide(
      ReactRouter.layer({
        build: () => import("virtual:react-router/server-build"),
        factory: routeFactory,
        mode: import.meta.env.MODE,
      }),
    ),
  );
  ```
  
  ```js
  // server.js
  const App =
    process.env.NODE_ENV === "development"
      ? await (async () => {
          const { createServer: createVite } = await import("vite");
          const { ReactRouterVite } = await import("react-router-effect/vite");
          const vite = await createVite({ server: { middlewareMode: true } });
          return ReactRouterVite.layer(vite, () =>
            vite.ssrLoadModule("./server/app.ts").then((module) => module.App),
          );
        })()
      : (await import("./build/server/index.js")).App;
  
  NodeRuntime.runMain(
    Layer.launch(
      HttpRouter.serve(App).pipe(
        Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
      ),
    ),
  );
  ```
  
  Change the input of the server build in `vite.config.ts` from `./server/main.ts` to `./server/app.ts`, and start the server with `node server.js`.

## 2.1.0

### Minor Changes

- [#63](https://github.com/justinwaite/react-router-effect/pull/63) [`dc02d30`](https://github.com/justinwaite/react-router-effect/commit/dc02d303e70a494738c8d81775310a0e865a0b1d) Thanks [@Mando75](https://github.com/Mando75)! - Serve React Router from the Effect HTTP server, and write loaders, actions and middleware as plain `Effect.fn` functions.
  
  - `react-router-effect/server` adds `ReactRouterHttp.make`, an Effect that makes an Effect HTTP app for a React Router build. The server runs it once at start, so a production build loads once and an unreadable client build fails the start with `ClientBuildError`. The app serves the Web request and its abort signal, cookies as Effect cookies, streamed bodies, and the client build with `clientAssets`. It wraps every route module with the route factory, so a route function that returns an Effect runs with the factory's runtime, request context and error handling, and any other route function passes through.
  - With a server span from Effect's HTTP tracer and a tracer that exports spans, the adapter runs each middleware, loader and action in a span of its own, nested as React Router calls them, and sets `http.route` on the server span.
  - `@effect/platform-node` is an optional peer dependency, needed only by `react-router-effect/vite`. `react-router-effect/server` uses only Effect's HTTP modules. It converts React Router's `Set-Cookie` values into the response's cookies, so Effect keeps one cookie per name.
  - `react-router-effect/vite` adds `ReactRouterVite.devMiddleware`, which runs Vite's dev middleware in front of the app on Effect's Node HTTP server.
  - `RouteEffectCheck` fails to compile with a message that lists each route and export when a route Effect leaves an error unhandled or needs a service that is not provided.
  - The factory takes `actionMeta`, which the adapter attaches to every action's data under `__meta`.
  - An effect middleware can provide services and log annotations around `next()` for every effect downstream.
  - Effects are branded with React Router's `unstable_SerializesTo`, so `Route.ComponentProps` and React Router's hooks type the data of Effect loaders and actions. `EffectRouteArgs` and `RouteData` type hooks that read `typeof loader`.
  - Requires `effect` 4.1 or later.

## 2.0.0

### Major Changes

- [#55](https://github.com/justinwaite/react-router-effect/pull/55) [`d32de9c`](https://github.com/justinwaite/react-router-effect/commit/d32de9c561752bd0456d3dff13d329f5efda21ee) Thanks [@justinwaite](https://github.com/justinwaite)! - The library now targets the stable Effect 4 release. The `effect` peer dependency range changes from `^4.0.0-beta.107` to `^4.0.0`. The library imports the HTTP modules from `effect/http` instead of `effect/unstable/http`, and the Effect 4.0.0 beta releases do not have that path. If you use an Effect 4.0.0 beta, upgrade to `effect@^4.0.0` before you upgrade this package. In your own code, change `effect/unstable/http` imports to `effect/http`.

### Patch Changes

- [#51](https://github.com/justinwaite/react-router-effect/pull/51) [`6690bb5`](https://github.com/justinwaite/react-router-effect/commit/6690bb55d617e31f35b56b05adcf78f048dd2e27) Thanks [@Mando75](https://github.com/Mando75)! - When a request aborts, the library now interrupts the loader, action, and middleware effects.

## 1.0.2

### Patch Changes

- [#29](https://github.com/justinwaite/react-router-effect/pull/29) [`310c105`](https://github.com/justinwaite/react-router-effect/commit/310c105b8bac4965e7ccbec8c3226424a2bcc70f) Thanks [@Mando75](https://github.com/Mando75)! - update effect version

## 1.0.1

### Patch Changes

- [#27](https://github.com/justinwaite/react-router-effect/pull/27) [`22f097b`](https://github.com/justinwaite/react-router-effect/commit/22f097b7fad0d677547ca1c70eaf4df895e6f6e9) Thanks [@Mando75](https://github.com/Mando75)! - Fix `makeMiddleware` rejecting handled errors when pinned to a route's middleware type.

  Passing `Route.MiddlewareFunction` as a type argument makes the call fully explicit —
  TypeScript has no partial type-argument inference — so the effect's error and requirement
  channels defaulted to `never` and every failure was reported as unassignable, including
  domain errors the `errorHandlers` remap and the failure `next()` itself produces. They now
  default to what the library handles and the factory provides, so a pinned middleware admits
  the same effects an unpinned one (or a `makeLoader`/`makeAction` call) does, and still
  rejects unhandled errors and unprovided services.

  The wrapper is also typed as the route's own middleware now — `(args, next) =>
Promise<Result | undefined>` — so it assigns to `Route.MiddlewareFunction[]` directly.

## 1.0.0

### Major Changes

- [#20](https://github.com/justinwaite/react-router-effect/pull/20) [`033b867`](https://github.com/justinwaite/react-router-effect/commit/033b867d7556cb79577d9725e36b3e6fe141e966) Thanks [@Mando75](https://github.com/Mando75)! - Add `makeMiddleware`, wrapping a React Router `Route.MiddlewareFunction` as an `Effect` with the same recover/throw/redirect handling as `makeLoader`/`makeAction`. Its `next` is handed to the effect as `() => Effect.Effect<Result, FailureResponse>` — call it with `yield*` to run the rest of the chain; a downstream throw (e.g. a nested loader's redirect) surfaces as a typed failure instead of a rejected promise, and is re-thrown as-is rather than becoming a 500.

  **Breaking:** the factory is renamed from `makeLoaderOrActionFactory` to `makeEffectRouteFactory`, now that it also builds `makeMiddleware`. It still returns `{ makeLoader, makeAction, Respond }`, with `makeMiddleware` added.

  ```ts
  export const { makeLoader, makeAction, makeMiddleware, Respond } =
    makeEffectRouteFactory<DomainErrors>()((Respond) => ({ errorHandlers: { ... } }));

  export const middleware: Route.MiddlewareFunction[] = [
    makeMiddleware<Route.MiddlewareFunction>(({ request }, next) =>
      Effect.gen(function* () {
        const user = yield* getUser(request); // may fail with a declared domain error
        if (!user) yield* Respond.redirect("/login");
        return yield* next();
      }),
    ),
  ];
  ```

### Patch Changes

- [#20](https://github.com/justinwaite/react-router-effect/pull/20) [`033b867`](https://github.com/justinwaite/react-router-effect/commit/033b867d7556cb79577d9725e36b3e6fe141e966) Thanks [@Mando75](https://github.com/Mando75)! - Fix `makeLoader`/`makeAction`/`makeMiddleware` reporting a confusing `unhandledErrors: any` (or `missingRequirements: any`) diagnostic whenever an unrelated mistake elsewhere in the effect (a typo, a call with the wrong arguments, an undefined reference) caused TypeScript to infer `any` for the error or requirement channel. The enforcement diagnostic now stands down when it detects `any` in either channel, so tsc's own error at the actual mistake is what you see instead of it being buried under ours.

## 0.6.1

### Patch Changes

- [#16](https://github.com/justinwaite/react-router-effect/pull/16) [`353db98`](https://github.com/justinwaite/react-router-effect/commit/353db98149b0ffe65cd55536fa5c5051d1f47a27) Thanks [@justinwaite](https://github.com/justinwaite)! - Clearer type errors when a loader/action has an unhandled error or an unmet requirement.

  Previously, leaving a non-domain error unhandled surfaced as the opaque **"Expected 2 arguments, but got 1"** (and a missing service requirement as an inscrutable "not assignable to `never`"). Both now report a readable message — and the offending types — right at the `makeLoader`/`makeAction` call:

  - **Unhandled error** → _"This loader/action can fail with an error the library does not handle. Catch it in the effect (e.g. `Effect.catchTag`), make it Respondable, or add it to your `DomainError` union."_ with `unhandledErrors` naming the error tags.
  - **Missing requirement** → _"This loader/action requires a service the factory does not provide. Add it to your runtime or requestContext, or handle it in the effect."_ with `missingRequirements` naming the service(s).

  No API change: valid loaders/actions type-check exactly as before, and the enforcement semantics are identical — only the diagnostics improved.

## 0.6.0

### Minor Changes

- [#13](https://github.com/justinwaite/react-router-effect/pull/13) [`6240f1d`](https://github.com/justinwaite/react-router-effect/commit/6240f1dbd7eb374a7f4fa90e98469f6b351994c5) Thanks [@justinwaite](https://github.com/justinwaite)! - Return `Respond` from the factory and extend it via a `respond` option; the inner config is now a builder function.

  The inner factory call takes a **builder** that receives the base `Respond` helpers (`early` / `throw` / `redirect`), so your `errorHandlers` can recover/throw with them — and the factory returns a single `Respond`: the base helpers merged with any `respond` extensions you add. This collapses `Respond` to one symbol per app, so your routes auto-import it with no ambiguity against a library export.

  ```ts
  export const { makeLoader, makeAction, Respond } =
    makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
      respond: { formError: (reply) => new FormError({ reply }) },
      errorHandlers: { FormError: (e) => Respond.early({ reply: e.reply }) },
    }));
  ```

  **Breaking:** the top-level `Respond` value export is removed — destructure `Respond` from the factory return instead. The config-object form is replaced by the builder-function form: `makeLoaderOrActionFactory<E>()((Respond) => ({ ... }))`. The route-error classes, `isRouteError`, and all type exports (`AnyRouteError`, `ErrorHandler`, `RequestContextKey`) are unchanged.

## 0.5.0

### Minor Changes

- [#11](https://github.com/justinwaite/react-router-effect/pull/11) [`b218783`](https://github.com/justinwaite/react-router-effect/commit/b21878369329035bb12d77f410ebf4b1c14e22a2) Thanks [@justinwaite](https://github.com/justinwaite)! - Type-safe `errorHandlers`: autocompleting keys and inferred `error` parameters.

  Handler keys now autocomplete to your declared domain-error tags, and each handler's `error` parameter is typed from its key — no annotation needed:

  ```ts
  makeLoaderOrActionFactory<DomainErrors>()({
    errorHandlers: {
      // key autocompletes to a domain-error tag; `error` is MyDomainError automatically
      MyDomainError: (error) =>
        Effect.fail(new Response(error.message, { status: 400 })),
    },
  });
  ```

  A handler keyed by an unknown tag, or returning something other than a library route error / failing `Effect`, is now a compile error reported **on that handler** (previously it surfaced on the factory call). Precise recover types are still derived from each handler's return.

  Existing code that annotated handler parameters keeps working — the annotations are now redundant.

## 0.4.0

### Minor Changes

- [#9](https://github.com/justinwaite/react-router-effect/pull/9) [`f0018ae`](https://github.com/justinwaite/react-router-effect/commit/f0018aeae6196459a409aff153a094c38836de8e) Thanks [@justinwaite](https://github.com/justinwaite)! - Support per-request services from React Router middleware.

  Pass a `requestContext` — a React Router context key holding a per-request effect `Context.Context` — to the factory. Middleware sets a fresh context on each request; the runner reads `args.context.get(requestContext)` and provides those services to the loader/action, so effects can require request-scoped services (the current user, a request id, a per-request transaction) with no `Effect.provide`:

  ```ts
  // a plain React Router context key — `createContext` is RR's own
  export const requestContext: RequestContextKey<RequestContext> =
    createContext();

  // middleware sets a fresh value per request
  export const middleware: Route.MiddlewareFunction[] = [
    ({ context, request }, next) => {
      context.set(
        requestContext,
        Context.make(RequestContext, { userId: readUser(request) })
      );
      return next();
    },
  ];

  // wire the same key into the factory
  const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()({
    runtime,
    requestContext,
  });

  // the loader requires RequestContext directly — fresh each request
  const loader = makeLoader(() =>
    Effect.gen(function* () {
      const { userId } = yield* RequestContext;
      return { userId };
    })
  );
  ```

  Effects may require both the runtime's app-wide services and the request context's request-scoped services; requiring anything else is a compile error. Adds a `RequestContextKey<ReqServices>` type alias (`RouterContext<Context.Context<ReqServices>>`) for annotating the key.

## 0.3.0

### Minor Changes

- [#7](https://github.com/justinwaite/react-router-effect/pull/7) [`012b5b7`](https://github.com/justinwaite/react-router-effect/commit/012b5b78333551ecb43897d2abab74160fba7674) Thanks [@justinwaite](https://github.com/justinwaite)! - Support providing a `ManagedRuntime` to the factory, make `errorHandlers` optional, and widen the React Router peer range to include v8.

  **Runtime support.** Pass a `runtime` (an effect `ManagedRuntime`) to the factory and loader/action effects may require its services directly — no per-call `Effect.provide`:

  ```ts
  const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
    runtime: getAppRuntime(), // provides Database, MyService, ...
    errorHandlers: { ... },
  });

  // `MyService` is satisfied by the runtime, not provided here:
  const loader = makeLoader((args: Route.LoaderArgs) =>
    Effect.gen(function* () {
      const svc = yield* MyService;
      return { data: yield* svc.load(args) };
    }),
  );
  ```

  The runtime's services are inferred and become the effect's allowed requirement channel: requiring a service the runtime provides type-checks, while requiring one it doesn't is a compile error. With no `runtime`, effects must still require nothing (unchanged behavior).

  **Optional `errorHandlers`.** `errorHandlers` may now be omitted, so a factory can be configured with just a runtime, or with nothing at all:

  ```ts
  makeLoaderOrActionFactory()({ runtime });
  makeLoaderOrActionFactory()({});
  ```

  **Peer range.** `react-router` is now `^7.16.0 || ^8.0.0`.

## 0.2.0

### Minor Changes

- [#3](https://github.com/justinwaite/react-router-effect/pull/3) [`250092f`](https://github.com/justinwaite/react-router-effect/commit/250092fd2e0f33b9b1b81eee6f6a7f69fd56324b) Thanks [@justinwaite](https://github.com/justinwaite)! - Enforce handling of non-domain errors at the type level.

  `makeLoaderOrActionFactory` now takes the app's domain errors as a type argument and is curried so the handler types are still inferred:

  ```ts
  const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
    errorHandlers: { ... },
  });
  ```

  Declared domain errors may be left unhandled (handled by a registered handler, rendered via `HttpServerRespondable`, or fall through to the 500 default). Any **non-domain** error a route consumes — e.g. a service-specific failure — must now be handled in the loader/action, or `makeLoader`/`makeAction` fails to type-check. This gives app-wide default handling for declared errors while enforcing explicit handling of feature/service-specific ones.

  **Breaking:** the factory is now called as `makeLoaderOrActionFactory<DomainErrors>()({ errorHandlers })` (note the extra `()`), registered handlers must be keyed by a declared domain error, and the factory now returns only `{ makeLoader, makeAction }` (the redundant `makeLoaderOrAction` alias was removed).
