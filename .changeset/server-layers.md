---
"react-router-effect": minor
---

Serve React Router with layers of Effect's `HttpRouter`, on Node or on Cloudflare Workers. The new layers replace `ReactRouterHttp.make` and `ReactRouterVite.devMiddleware`.

The adapter's API is unstable, and a minor version can change it. Every export of `react-router-effect/server` and `react-router-effect/vite` has the JSDoc tag `@stability unstable`. The route factory and the other exports of `react-router-effect` are stable.

- `ReactRouter.layer(options)` provides the `ReactRouter` service: the build, and the Effect that answers a request. Its options are `build`, `factory`, `mode` and `loadContext`. `loadContext` makes React Router's load context for each request, as `getLoadContext` does for `@react-router/express`.
- `mode` is required, such as `import.meta.env.MODE`. The adapter no longer reads `process.env.NODE_ENV`. As in React Router, any mode but `development` and `test` runs in production mode: the layer then loads a build function once, at layer build.
- The same `App` serves on every platform of Effect's HTTP router. `HttpRouter.serve` serves it on Node. `HttpRouter.toWebHandler` serves it from a Cloudflare Worker, or from another runtime with Web requests and responses. On such a runtime, a client that cancels the streamed body also aborts the request signal. The repository's `examples/cloudflare` shows a Worker.
- `ReactRouter.routes` registers React Router as the catch-all route of the app's router. A route of the app wins over it. A GET route of the app also answers HEAD, as it does in Express.
- `ReactRouterAssets.layer` serves the client build as routes. It caches the hashed directory of the build's manifest for a year as immutable, and each other file for an hour. A directory with an `index.html` serves that file, and a root `index.html` serves `/`. The layer serves no dotfiles. If it cannot read the client build, the server fails to start with `ReactRouterAssets.ClientBuildError`.
- `ReactRouterVite.layer(vite, loadApp)` serves the app in development on Node. It passes each request to Vite first. Then it serves the request with the `App` that `loadApp` returns, and it builds a new `App` after an edit. `ReactRouterVite.ViteDevServer` takes an optional `ssrFixStacktrace`, which maps the stack of an error to the source files.
- On React Router 8, `http.route` on the server span is the pattern of the matched routes, also for a page that runs no route function.

Removed: `ReactRouterHttp` with `make`, `Options`, `App`, `BuildSource` and `ClientAssetServices`, the `clientAssets` and `requestContext` options, and `ReactRouterVite.devMiddleware`. On React Router 7, the adapter needs `future.v8_middleware`. The package now requires Node 22 or later (`engines.node`).

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
