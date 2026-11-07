# react-router-effect

Serve a [React Router](https://reactrouter.com) framework-mode app from [Effect](https://effect.website)'s
Node HTTP server, and write its loaders, actions and middleware as Effects.

A route function that returns an `Effect` runs with your app's services. When it fails with a tagged
error, the route factory you configure once decides what happens: recover with data for
`useLoaderData`, send the error to the error boundary, or redirect. The type of the route's data
lists what the route can return.

```ts
export const loader = Effect.fn("loader.profile")(function* ({
  params,
}: EffectRouteArgs<Route.LoaderArgs>) {
  const profile = yield* (yield* Profiles).get(params.id); // fails with your domain errors
  if (!profile.public) yield* Respond.early({ restricted: true }); // recover with typed data
  return { profile };
});
// Route.ComponentProps["loaderData"]: { profile: Profile } | { restricted: boolean }
```

If your app does not serve React Router from an Effect HTTP server, read
[Without the Effect HTTP server](#without-the-effect-http-server).

## Install

```bash
vp add react-router-effect effect @effect/platform-node
```

`effect`, `@effect/platform-node` and `react-router` are peer dependencies. The library requires
Effect 4.1 (`effect@^4.1.0`). Only `react-router-effect/vite` imports `@effect/platform-node`.

## Get started

[`examples/node`](examples/node) is an app with these files. It also has development with
Vite, tests against the production build, and benchmarks.

### 1. Create the route factory

The route factory has what every route Effect needs: the runtime that provides your services, and
the handlers for your domain errors.

```ts
// app/lib/route-factory.server.ts
import { ManagedRuntime } from "effect";
import { makeEffectRouteFactory } from "react-router-effect";

import { InvalidTodo, Todos } from "./services.server";

export const runtime = ManagedRuntime.make(Todos.layer);

// Pin the domain errors, then the handler types are inferred.
export const routeFactory = makeEffectRouteFactory<InvalidTodo>()((Respond) => ({
  runtime,
  errorHandlers: {
    // A form error goes back to the form as data, with a 422.
    InvalidTodo: (error) => Respond.early({ error: error.message }, 422),
  },
}));

// Routes import this `Respond`. No library export has the same name.
export const { Respond } = routeFactory;
```

### 2. Create the server app

`App` is a layer of routes on Effect's `HttpRouter`. `ReactRouter.layer` loads the build with your
route factory. `ReactRouter.routes` registers React Router as the catch-all route.
`ReactRouterAssets.layer` registers the files of the client build. Your own routes and middleware go
in the same `Layer.mergeAll`.

```ts
// server/app.ts
import { Layer } from "effect";
import { ReactRouter, ReactRouterAssets } from "react-router-effect/server";

import { routeFactory } from "../app/lib/route-factory.server";

export const App = Layer.mergeAll(ReactRouter.routes, ReactRouterAssets.layer).pipe(
  Layer.provide(
    ReactRouter.layer({
      build: () => import("virtual:react-router/server-build"),
      factory: routeFactory,
    }),
  ),
);
```

### 3. Serve it

`server.js` serves `App` with `HttpRouter.serve`, which also logs each request. It is the only file
that does not reload in development. When the server starts in production, `App` loads the build and
reads the client build. If the server cannot read the client build, it fails to start with a
`ClientBuildError` that names the resolved directory.

```js
// server.js
import { createServer } from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";

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

### 4. Build the server

Make `server/app.ts` the entry of the server build. `react-router build` then writes `App` to
`build/server/index.js`.

```ts
// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  environments: { ssr: { build: { rollupOptions: { input: "./server/app.ts" } } } },
});
```

```bash
react-router build
NODE_ENV=production node server.js
```

For development, read [Development with Vite](#development-with-vite).

### 5. Write routes as Effects

A loader, action or middleware is an `Effect.fn`. It needs no wrapper. The adapter runs it with the
factory's runtime and error handlers.

```ts
// app/routes/todos.tsx
import { Effect } from "effect";
import { data } from "react-router";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/todos";

import { Todos } from "../lib/services.server";

export const loader = Effect.fn("loader.todos")(function* () {
  return { todos: yield* (yield* Todos).list };
});

// `InvalidTodo` is not handled here. The route factory turns it into `{ error }` data with a 422.
export const action = Effect.fn("action.todos")(function* ({
  request,
}: EffectRouteArgs<Route.ActionArgs>) {
  const form = yield* Effect.promise(() => request.formData());
  const todo = yield* (yield* Todos).add(String(form.get("title")));
  return data({ todo }, { status: 201 });
});
```

`EffectRouteArgs` keeps hooks that take `typeof action` or `typeof loader` typed, such as
`useFetcher<typeof action>()`. [Plain Effect loaders, actions and
middleware](#plain-effect-loaders-actions-and-middleware) explains why. A route function that does
not return an Effect passes through to React Router unchanged, so promise loaders keep working in
the same app.

## Handle errors

An Effect can short-circuit in three ways, with the `Respond` helpers:

| Helper                         | Outcome | Where it lands                                      |
| ------------------------------ | ------- | --------------------------------------------------- |
| `Respond.early(value, init?)`  | recover | resolves with `data(value, init)` → `useLoaderData` |
| `Respond.throw(value, init?)`  | throw   | rejects with `data(value, init)` → error boundary   |
| `Respond.redirect(url, init?)` | throw   | rejects with a redirect `Response`                  |

Declare your app's domain errors as the type argument of `makeEffectRouteFactory`. You can register
one handler for each. A handler remaps its error. It returns one of these:

- A library route error: `Respond.early(...)`, `Respond.throw(...)` or `Respond.redirect(...)`.
- An `Effect`: `Effect.succeed(value)` recovers with `value`, and `Effect.fail(response)` throws a
  `Response` or `DataWithResponseInit`.

```ts
import { Data, Effect } from "effect";

class FormError extends Data.TaggedError("FormError")<{ reply: SubmissionResponse }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ message: string }> {}
class DbError extends Data.TaggedError("DbError")<{ query: string }> {}

// `DbError` has no handler below, so it falls through to the 500 default.
type DomainErrors = FormError | BadInputError | DbError;

export const routeFactory = makeEffectRouteFactory<DomainErrors>()((Respond) => ({
  // App-specific helpers. The returned `Respond` has them next to the base helpers.
  respond: {
    formError: (reply: SubmissionResponse) => new FormError({ reply }),
  },
  errorHandlers: {
    // Keys autocomplete to your domain-error tags, and `error` is typed from its key.
    // Recover: pass the reply to the component.
    FormError: (error) => Respond.early({ reply: error.reply }),
    // Throw: send to the error boundary.
    BadInputError: (error) => Effect.fail(new Response(error.message, { status: 400 })),
  },
}));
```

A declared domain error can have no handler. If it implements `HttpServerRespondable`, it renders
its own response. A registered handler still takes precedence. Otherwise it falls through to a 500.

```ts
import { HttpServerRespondable, HttpServerResponse } from "effect/http";

class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}
```

Any other error that a route consumes must be handled in the route. This includes a
service-specific error that is not a declared domain error. Catch it or map it. This gives the app
defaults for declared errors. The errors of one feature or service need explicit handling.
[The route check](#the-route-check) reports an unhandled error at compile time.

## Provide services

### App-wide services with a runtime

The `runtime` is an Effect [`ManagedRuntime`](https://effect.website). The factory builds it once and
reuses it for every request. Route Effects require its services directly, with no `Effect.provide`
in the route. The runtime's services are the allowed requirements of a route Effect. A route that
requires another service is a compile error. Without a `runtime`, a route Effect must require
nothing.

```ts
export const loader = Effect.fn("loader.profile")(function* ({
  params,
}: EffectRouteArgs<Route.LoaderArgs>) {
  const svc = yield* MyService; // the runtime provides MyService
  return { profile: yield* svc.load(params.id) };
});
```

`errorHandlers` is optional. A factory can have a runtime only, or nothing:

```ts
makeEffectRouteFactory()(() => ({ runtime }));
makeEffectRouteFactory()(() => ({}));
```

### Per-request services

The runtime provides app-wide services. A request-scoped service is the current user, a request id,
or a transaction for one request. There are two ways to provide one.

A route-scoped router middleware on `ReactRouter.routes` provides services to React Router's
requests. Every middleware, loader and action sees them, and no React Router middleware has to set
them:

```ts
// server/app.ts
const RequestServices = HttpRouter.middleware((app) =>
  Effect.provideServiceEffect(
    app,
    RequestInfo,
    HttpServerRequest.HttpServerRequest.use((request) =>
      Effect.succeed({
        id: request.headers["x-request-id"] ?? crypto.randomUUID(),
        startedAt: Date.now(),
      }),
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
    }),
  ),
);
```

A [middleware](https://reactrouter.com/how-to/middleware) can also provide services. An effect
middleware provides them around `next()`, and everything downstream of `next()` can require them:

```ts
// app/root.tsx
export const middleware = [
  Effect.fn("middleware.visitor")(function* ({
    request,
    next,
  }: EffectMiddlewareArgs<Route.MiddlewareFunction>) {
    const name = yield* readVisitor(request);
    return yield* next().pipe(
      Effect.provideService(Visitor, { name }),
      Effect.annotateLogs({ visitor: name }),
    );
  }),
];
```

Tell the factory which services the request provides with a context key:

```ts
// app/lib/route-factory.server.ts
import { createContext } from "react-router";
import type { RequestContextKey } from "react-router-effect";

export const requestContext: RequestContextKey<RequestInfo | Visitor> = createContext();

export const routeFactory = makeEffectRouteFactory<DomainErrors>()(() => ({
  runtime,
  requestContext,
}));
```

A route Effect can then require the runtime's services and the request's services. Any other
requirement is a compile error. `RequestContextKey<ReqServices>` is an alias of
`RouterContext<Context.Context<ReqServices>>`.

The adapter sets this key to the request fiber's context before React Router runs. That context
holds the server span, `HttpServerRequest` and the services of the router middleware. Do not set the
key to a new context in a React Router middleware, as an app without the adapter does. A new context
replaces those services for every function after that middleware. Provide request services with a
router middleware or an effect middleware, as this section shows.

## The adapter

`react-router-effect/server` is a React Router adapter for Effect's HTTP router, on Effect's Node
HTTP server (`@effect/platform-node`). It is the Effect counterpart of `@react-router/express`. It
handles everything between an `HttpServerRequest` and React Router. That is the Web `Request` and
its abort signal, the route factory, and the client build. It also converts React Router's
`Response`, with its streamed body and its cookies. The app keeps its own server, middleware and
routes.

React Router keeps doing what it does for any other server adapter: documents, `.data` requests,
streamed promises, resource routes, the lazy route manifest and middleware. Before React Router
sees the build, the adapter runs every loader, action and middleware through your route factory:

- A route function that returns an Effect runs with the factory's runtime and request context.
  Its failures go through the factory's error handlers.
- Any other route function passes through. Promise loaders and `makeLoader` wrappers keep working.

The layers:

- `ReactRouter.layer(options)` provides the `ReactRouter` service. Its options are these:
  - `build` is the server build, or a function that loads it.
  - `factory` is the route factory.
  - `mode` is React Router's server mode. The default is `process.env.NODE_ENV`. At layer build, the
    layer loads a build value once, or a build function in production mode. Any other build loads
    for each request.
  - `loadContext` makes React Router's load context for each request. Read
    [The load context](#the-load-context).
- `ReactRouter.routes` registers React Router as the catch-all route on `*`.
- `ReactRouterAssets.layer` registers the files of the client build. Read
  [The client build](#the-client-build).
- `ReactRouterVite.layer`, from `react-router-effect/vite`, serves the app in development. Read
  [Development with Vite](#development-with-vite).

Provide one value of `ReactRouter.layer` to every layer that reads the service, as `App` does with
`Layer.provide`. Two values load the build twice.

### The load context

`loadContext` does for the adapter what `getLoadContext` does for `@react-router/express`. It
returns an Effect of a `RouterContextProvider`. Plain loaders and actions, and `handleRequest` in
`entry.server.tsx`, read its values with `context.get`. Route Effects read services from their
Effect context. So give route Effects services with router middleware, not with `loadContext`.

```ts
ReactRouter.layer({
  build: () => import("virtual:react-router/server-build"),
  factory: routeFactory,
  loadContext: (request) =>
    Effect.sync(() => {
      const context = new RouterContextProvider();
      context.set(localeKey, request.headers["accept-language"] ?? "en");
      return context;
    }),
});
```

The Effect gets the services of the layer and the services of the request. The services of the
request, such as its scope, win. The adapter adds its own keys to the provider. If the Effect dies,
the client gets an empty 500.

### Routes and middleware

The route that a request matches decides which middleware runs on it. Effect has three kinds of
middleware:

- A server middleware, the `middleware` option of `HttpRouter.serve`, wraps every request. It also
  wraps the send of the response, so a change to the response with `Effect.map` does not reach the
  client. `HttpMiddleware.compression` works there.
- A global router middleware, `HttpRouter.middleware(fn, { global: true })`, wraps every route.
- A route-scoped middleware, `HttpRouter.middleware(fn).layer`, applies only to the routes of the
  layers that you provide it to.

Route-scoped middleware selects the middleware of each kind of request. `HttpRouter.serve` logs
every request. To leave file requests out of that log, provide `HttpRouter.disableLogger` to the
assets layer only:

```ts
export const App = Layer.mergeAll(
  ReactRouter.routes.pipe(Layer.provide(RequestServices)),
  ReactRouterAssets.layer.pipe(Layer.provide(HttpRouter.disableLogger)),
  HttpRouter.middleware(HttpMiddleware.compression(), { global: true }),
).pipe(
  Layer.provide(
    ReactRouter.layer({
      build: () => import("virtual:react-router/server-build"),
      factory: routeFactory,
    }),
  ),
);
```

The order of two route-scoped middleware layers on one route is not fixed. If the order matters,
join them into one middleware with `combine`:
`HttpRouter.middleware(first).combine(HttpRouter.middleware(second)).layer`.

These rules apply to the routes:

- An exact route wins over a route with a parameter, and both win over a wildcard. So your own
  routes and the files of the client build win over React Router's `*`.
- A route of your own on `*` or `/*`, for a method that React Router's route has, collides with it.
  Then the server fails to start. A route of your own with the path of a file of the client build
  fails the same way.
- If a HEAD request matches no HEAD route, it uses the GET route of its path. `ReactRouter.routes`
  registers no HEAD route. So a GET route of your own answers HEAD, as it does in Express.
- React Router's route takes the methods of `HttpMethod.all`: GET, POST, PUT, DELETE, PATCH,
  OPTIONS, TRACE and QUERY, and HEAD through GET. A request with another method, such as PROPFIND,
  gets a 404 from the router.
- Register `ReactRouter.routes` at the root of the router. Under a prefix, the router removes the
  prefix from the request's URL, and React Router gets the wrong path. To serve the app under a
  path, set React Router's `basename`.
- The router ignores the case of the path. On a file system that is case-sensitive, a request for a
  file with the wrong case matches the file's route and gets a 404.

### The client build

`ReactRouterAssets.layer` serves `build.assetsBuildDirectory` under `build.publicPath`, as the two
`express.static` lines of React Router's Express template do. It needs the platform's file system,
which `NodeHttpServer.layer` provides.

- The hashed directory is the directory of the build's manifest URL, such as `/assets`. React
  Router's build writes files with a content hash in their names there. The layer caches them for a
  year as immutable. A request under the hashed directory gets a 404 for a file that the directory
  does not have. A path with `..` does not get out of the hashed directory.
- Each other file gets its own route for GET and HEAD, and the layer caches it for an hour. At
  server start, the layer reads the client build. If a file is added outside the hashed directory
  later, the layer serves it only after a restart.
- A directory with an `index.html`, such as a prerendered page, serves that file. Its path without
  the trailing slash redirects to the path with it. A root `index.html`, such as a prerendered home
  page, serves `/`, and React Router's catch-all yields to it.
- If the manifest URL is not under `publicPath`, or it is at the root of `publicPath`, there is no
  hashed directory. Then the layer caches every file for an hour.
- The layer serves no dotfiles, such as `.vite/manifest.json`, as `express.static` does.
- The layer registers nothing for a build that loads for each request, such as a development build.
  Vite serves the client there. It also registers nothing for a `publicPath` on another origin.
- `assetsBuildDirectory` is relative to the working directory of the server. If the layer cannot
  read it, the server fails to start with a `ClientBuildError` that names the resolved directory.
  If a file name has a `*`, the server fails to start with a `ClientBuildError` too, because the
  router cannot match that name.

### Requests

The Web request comes from `HttpServerRequest.toWeb`, body included. If a request sends
`Expect: 100-continue`, Effect's stream sends the `100 Continue` at the moment React Router reads
the body.

The request URL is the one that Effect derives from the request: its path, its `host` header and its
protocol. An app behind a proxy applies the headers that it trusts with
`HttpMiddleware.xForwardedHeaders`, as a server middleware or a global router middleware. Both run
before the router reads the request. `HttpMiddleware.tracer` runs outside the server middleware, so
its span has the request before the change.

Behind a chain of proxies, React Router can expect a different host and scheme than
`xForwardedHeaders` gives. If `X-Forwarded-Host` or `X-Forwarded-Proto` does not have one value for
each `X-Forwarded-For` entry, `xForwardedHeaders` ignores that header. Express takes the first value
of each header. If your app is behind a proxy, make sure that the correct headers reach the server.

If the client leaves while React Router runs or while the body streams, the response ends early, and
the request signal aborts. A completed response never aborts it.

Effect's Node server writes the head of a streamed response with its first chunk. So an
`EventSource` client sees the response open at the first event, and not at the return of the route.

React Router logs and answers the errors of route code. If the adapter's own steps fail, for example
a `loadContext` that dies, the adapter logs the error with `Effect.logError`. Then it answers an
empty 500. The log goes to the loggers of the app's Effect runtime.

### Development with Vite

In development, Vite serves the client and loads the server code. `ReactRouterVite.layer(vite,
loadApp)`, from `react-router-effect/vite`, passes each request to Vite first. For a request that
Vite passes on, it calls `loadApp` and serves the request with the `App` that `loadApp` returns. The
`server.js` of [Serve it](#3-serve-it) uses it.

Load `server/app.ts` with `vite.ssrLoadModule`. Then the route modules, the factory and the adapter
share Vite's module graph. When `loadApp` returns a new `App` value, after an edit, the layer builds
the new `App` and closes the old one. Concurrent requests share one build.

- A defect, such as a Vite error or an `App` that fails to build, goes to the app's loggers, and the
  client gets an empty 500. Before that, the layer calls `vite.ssrFixStacktrace`, so the stack shows
  your source files.
- The `routerConfig` option of `HttpRouter.serve` applies to the server's router only. In
  development, the `App` has its own router, with the default configuration.
- Vite's middleware takes Node requests, so the layer needs Effect's Node HTTP server.
- Keep the websocket of Vite's HMR (hot module replacement) on its own port. The port is 24678 by
  default, and `server.ws.port` sets another one. Do not give Vite the app's Node server with
  `server.ws.server`, or with its older name `server.hmr.server`. Effect's Node server runs the app
  for every upgrade request, and the app's response closes Vite's websocket.

### Cookies

Set cookies from route code with React Router's cookie helpers, `createCookie` and the session
storages, as in any React Router app. The adapter converts React Router's `Set-Cookie` values into
the response's `cookies`, as `HttpServerResponse.fromWeb` does. A router middleware on
`ReactRouter.routes` can read and change them like any other cookie. A response that replaces React
Router's has none of them.

Effect keeps one cookie per name and only the attributes it knows: `Max-Age`, `Domain`, `Path`,
`Expires`, `HttpOnly`, `Secure`, `Partitioned`, `Priority` and `SameSite`. One response can set the
same cookie name twice, for example to expire it on one path and set it on another. Then Effect
sends only the last one.

### Content type

Effect gives a streamed body without a content type `application/octet-stream`. A resource route
that returns such a body sends that type, and the browser downloads the response. Examples are a
`ReadableStream`, bytes, or the body of another service's response. With Express, the response has
no content type, and the browser guesses one. Set `Content-Type` in the route:

```ts
return new Response(Readable.toWeb(file) as ReadableStream, {
  headers: { "content-type": "application/pdf" },
});
```

### Tracing

When the request has a server span, the adapter traces React Router. If the app provides a tracer
that exports spans, such as `OtelTracer`, Effect's HTTP server makes the server span. Provide the
tracer to the layer that calls `HttpRouter.serve`, in `server.js`:

```js
NodeRuntime.runMain(
  Layer.launch(
    HttpRouter.serve(App).pipe(
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
      // The app's tracer layer, such as an `OtelTracer` layer from `@effect/opentelemetry`.
      Layer.provide(TracerLive),
    ),
  ),
);
```

Effect's server runs each request with the services of that layer. A tracer that only `App`
provides makes no server span, so the adapter adds no spans.

Each middleware, loader and action runs in a span of its own, such as
`react-router.loader routes/todos`.
The spans nest as React Router calls the functions. This is the example's `GET /todos`:

```text
GET                           the server span, with http.route=/todos
└─ react-router.middleware root
   └─ middleware.visitor      the Effect middleware's own span, around next()
      ├─ react-router.loader root
      │  └─ loader.root       the route Effect's span
      └─ react-router.loader routes/todos
         └─ loader.todos
```

A middleware's span covers everything its `next()` runs: the next middleware, then the loaders and
the action. Route Effects nest under the span of their function. Effect's OpenTelemetry tracer makes
the current Effect span the active OpenTelemetry context. So the clients that an OpenTelemetry
instrumentation traces nest there too, such as a database driver that a promise loader calls.
Without a server span, or with Effect's native tracer, whose spans go nowhere, the adapter adds no
spans and no cost.

On React Router 8, the adapter sets `http.route` on the server span to the pattern of the matched
routes, such as `/todos/:id`. It does this also for a page that runs no route function. A request
that matches no route keeps the router's `*`. On React Router 7, a page that runs no route function
also keeps `*`. `ReactRouter.layer` reads the tracer once, at layer build. So it does not see a
tracer that the app provides only inside a request.

## Route functions

### Plain Effect loaders, actions and middleware

```ts
export const loader = Effect.fn("loader.dashboard")(function* () {
  const { organization } = yield* AuthContext.getScope;
  return { organization };
});

export const action = Effect.fn("action.createTax")(function* ({
  request,
}: EffectRouteArgs<Route.ActionArgs>) {
  const submission = yield* parseSubmission(request);
  return data({ reply: submission.reply() }, { status: 201 });
});

export const middleware = [
  Effect.fn("middleware.adminOnly")(function* ({
    next,
  }: EffectMiddlewareArgs<Route.MiddlewareFunction>) {
    const user = yield* AuthContext.getUser;
    if (user.role !== "admin") return redirect("/settings");
    return yield* next().pipe(Effect.annotateLogs({ userId: user.id }));
  }),
];
```

- Route data: Effects are branded with React Router's `unstable_SerializesTo`. So
  `Route.ComponentProps` types the data of an Effect loader or action, including what the factory
  recovers.
  - Hooks that take `typeof loader` or `typeof action`, such as `useFetcher<typeof action>()`,
    read the data through React Router's `SerializeFrom`. It treats a function as a client
    function when its argument has the members of client loader args, and gives client functions
    their raw return value. Typegen's `Route.LoaderArgs` and `Route.ActionArgs` have those same
    members, so for an Effect the hook would type the data as the Effect itself.
  - Take the args through `EffectRouteArgs<Route.LoaderArgs>`. It makes `pattern` optional, so the
    argument no longer matches and the hook reads the brand. A loader without args needs nothing.
  - `RouteData<typeof loader>` reads the brand directly and applies React Router's serialization.
    The brand records the data before serialization: it has to keep Effect's subtype order, and
    React Router's `Serialize` does not.
- Middleware: an effect middleware gets `next` as an effect in its args. Services, log annotations
  and the span that it provides around `next()` reach every route Effect downstream. `context.set`
  keeps working. You cannot annotate a route array with an effect middleware as
  `Route.MiddlewareFunction[]`.
- Action metadata: `actionMeta` in the factory config is read after every action resolves. The
  adapter attaches it to the action's data under `__meta`.
- Tests: `routeFactory.handlers.loader(loader)(args)` runs a route function as the server does.

### Register what the factory recovers

A plain Effect loader cannot see the factory's handlers. Declare what they recover once:

```ts
declare module "react-router-effect" {
  interface Register {
    recover: { FormValidationError: { reply: SubmissionResponse } };
    actionMeta: { realtimeEventIds: ReadonlyArray<string> };
  }
}
```

Declare the types directly. Reading them from `typeof routeFactory` is circular.

### The route check

`RouteEffectCheck` reads the route modules that React Router's typegen registers. It fails to
compile in three cases:

- A route Effect can fail with an error that the factory does not handle.
- A route Effect needs a service that the runtime and the request context do not provide.
- `Register` disagrees with the factory.

```ts
import type { RouteEffectCheck } from "react-router-effect/server";

export const routeEffects: RouteEffectCheck<typeof routeFactory> = {};
```

```text
Type '{}' is missing the following properties from type ...:
  "routes/billing#loader must handle PlaidApiError",
  "routes/admin#middleware needs a provider for app/Session"
```

### Requirements and limits

- Effect 4.1 or later, and `skipLibCheck`. The brand augments `Effect`, and TypeScript cannot test
  the variance annotations of that augmentation.
- For the adapter, React Router 8.3 or later, or React Router 7.16 or later with
  `future.v8_middleware`. The adapter gives React Router a `RouterContextProvider` as its load
  context, and React Router 7 accepts one only with that flag.
- A route module export must be a function. A bare `Effect` value is not a loader.
- Prerendering (`prerender`) and RSC mode call the build without the adapter.

## Without the Effect HTTP server

If your app serves React Router from Express, `@react-router/node`, a serverless platform or another
server, the adapter does not apply. The same route factory still returns `makeLoader`, `makeAction`
and `makeMiddleware`. Each wraps one route function. The wrapper runs the Effect with the factory's
runtime and error handlers, and returns a function that React Router calls.

```ts
// app/routes/profile.ts
import { Effect } from "effect";
import { makeLoader, Respond } from "../route.server.ts";
import type { Route } from "./+types/profile";

export const loader = makeLoader((args: Route.LoaderArgs) =>
  Effect.gen(function* () {
    const profile = yield* getProfile(args.params.id); // can fail with FormError / BadInputError
    if (!profile.public) {
      yield* Respond.early({ restricted: true }); // recover with typed data
    }
    return { profile };
  }),
);
```

Take `makeLoader`, `makeAction`, `makeMiddleware` and `Respond` from the factory:

```ts
// app/route.server.ts
export const { makeLoader, makeAction, makeMiddleware, Respond } =
  makeEffectRouteFactory<DomainErrors>()((Respond) => ({
    runtime: appRuntime,
    errorHandlers: {/* ... */},
  }));
```

`makeLoader` and `makeAction` are the same wrapper. The wrapper computes the resolved type from the
effect and your handlers:

```ts
type LoaderData = Route.ComponentProps["loaderData"];
// { profile: Profile } | DataWithResponseInit<{ restricted: boolean }>
//   ( BadInputError throws, so it never appears here )
```

Without the adapter, an unhandled error is a compile error at the `makeLoader` or `makeAction` call.
The message lists the unhandled errors. An effect can also require a service that neither the
`runtime` nor the `requestContext` provides. That fails the same way, and the message lists the
missing service.

### Middleware

`makeMiddleware` wraps a [middleware](https://reactrouter.com/how-to/middleware) function the same
way, with the same `errorHandlers`. Pin it to the route's generated `Route.MiddlewareFunction`.
Middleware has no separate args-only type, so the full function type is the type argument. If you
omit the type argument, it defaults to React Router's own `MiddlewareFunction`:

```ts
import { Effect } from "effect";
import { makeMiddleware, Respond } from "../route.server.ts";
import type { Route } from "./+types/profile";

export const middleware: Route.MiddlewareFunction[] = [
  makeMiddleware<Route.MiddlewareFunction>(({ request }, next) =>
    Effect.gen(function* () {
      const user = yield* getUser(request); // can fail with FormError / BadInputError
      if (!user) yield* Respond.redirect("/login"); // throw → redirect, same as a loader
      return yield* next(); // run the rest of the chain
    }),
  ),
];
```

The effect gets `next` as `() => Effect.Effect<Result, FailureResponse>`. It is React Router's own
`next: () => Promise<Result>`, wrapped. Call it with `yield*` to run the downstream loaders and
middleware. A downstream throw, such as a nested loader's redirect, becomes a typed failure instead
of a rejected promise. It flows through the same recover and throw handling as a loader or action.

### Per-request services

Without the adapter, no router middleware runs before React Router. Set the context key in a plain
React Router middleware. The factory's `requestContext` reads it, and provides those services to the loader or
action. With the adapter, do not set the key this way, as
[Per-request services](#per-request-services) tells. This is the pattern without the adapter:

```ts
// app/request-context.server.ts
import { Context } from "effect";
import { createContext } from "react-router";
import type { RequestContextKey } from "react-router-effect";

class RequestContext extends Context.Service<RequestContext, { readonly userId: string }>()(
  "app/RequestContext",
) {}

export const requestContext: RequestContextKey<RequestContext> = createContext();

// app/routes/profile.ts: a middleware sets a fresh value for each request.
export const middleware: Route.MiddlewareFunction[] = [
  ({ context, request }, next) => {
    context.set(requestContext, Context.make(RequestContext, { userId: readUser(request) }));
    return next();
  },
];

// app/route.server.ts: wire the same key into the factory.
export const { makeLoader } = makeEffectRouteFactory<DomainErrors>()(() => ({
  runtime: appRuntime,
  requestContext,
}));

// The loader requires RequestContext directly, with a fresh value for each request.
export const loader = makeLoader(() =>
  Effect.gen(function* () {
    const { userId } = yield* RequestContext;
    return { userId };
  }),
);
```

## API

- `makeEffectRouteFactory<DomainErrors>()((Respond) => ({ errorHandlers?, runtime?, requestContext?, respond?, actionMeta? }))`
  returns `{ makeLoader, makeAction, makeMiddleware, Respond, handlers }`. The config is a builder
  that receives the base `Respond`. All its fields are optional. The returned `Respond` is the base
  helpers merged with your `respond` extensions, and the base helpers win. `makeLoader` and
  `makeAction` are the same wrapper. `makeMiddleware` wraps a `Route.MiddlewareFunction`, and
  defaults to React Router's own `MiddlewareFunction`.
- `handlers` (`loader`, `action`, `middleware`, `requestContext`) is the runner that the server
  adapter applies to every route module.
- `Respond` has `early` (recover), `throw` and `redirect`, and the `respond` helpers that you add.
- `ReturnableDataError`, `ThrowableDataError` and `ThrowableRedirectError` are the library route
  errors. `isRouteError` narrows them.
- `ErrorHandler<Err>` is the handler signature type.
- `RequestContextKey<ReqServices>` is the type of the React Router context key for a per-request
  effect context.
- `EffectRouteArgs<Args>`, `EffectMiddlewareArgs<Middleware>`, `RouteData<F>` and `Register` are the
  types of plain Effect routes.
- `react-router-effect/server` exports `ReactRouter`, with `ReactRouter.layer`, `ReactRouter.routes`
  and the `ReactRouter.Options` type, and `ReactRouterAssets`, with `ReactRouterAssets.layer` and
  `ReactRouterAssets.ClientBuildError`. It also exports the types `RouteEffectCheck` and
  `RouteEffectFailures`.
- `react-router-effect/vite` exports `ReactRouterVite.layer` and the `ReactRouterVite.ViteDevServer`
  type, for development. It needs `@effect/platform-node`.

## Development

```bash
vp install   # install dependencies
vp test      # run the test suite
vp check     # format, lint, type-check
vp pack      # build the library
```

## License

MIT
