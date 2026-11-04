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

[`examples/basic`](examples/basic) is an app with these files. It also has development with
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

`ReactRouterHttp.make` returns an Effect that makes an Effect HTTP app. The app runs React Router
with your route factory.

```ts
// server/app.ts
import { ReactRouterHttp } from "react-router-effect/server";

import { routeFactory } from "../app/lib/route-factory.server";

export const reactRouterApp = ReactRouterHttp.make({
  build: () => import("virtual:react-router/server-build"),
  factory: routeFactory,
  clientAssets: true, // serves build/client in production
});
```

### 3. Serve it

The server makes the app once, when it starts, and serves it with its own Effect HTTP server and its
own middleware. In production, making the app loads the build and reads the client build. If the
server cannot read the client build, it fails to start, and the error names the resolved directory.

```ts
// server/main.ts
import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpServer } from "effect/http";

import { reactRouterApp } from "./app";

Layer.unwrap(
  Effect.map(reactRouterApp, (app) => HttpServer.serve(app, HttpMiddleware.logger)),
).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
);
```

### 4. Build the server

Make `server/main.ts` the entry of the server build. The build then contains your server, and
`react-router build` writes it to `build/server/index.js`.

```ts
// vite.config.ts
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [reactRouter()],
  environments: { ssr: { build: { rollupOptions: { input: "./server/main.ts" } } } },
});
```

```bash
react-router build
NODE_ENV=production node build/server/index.js
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

The adapter option `requestContext` builds the services before React Router runs. Every middleware,
loader and action sees them, and no middleware has to set them:

```ts
ReactRouterHttp.make({
  build: () => import("virtual:react-router/server-build"),
  factory: routeFactory,
  requestContext: (request) =>
    Context.make(RequestInfo, {
      id: request.headers.get("x-request-id") ?? crypto.randomUUID(),
      startedAt: Date.now(),
    }),
});
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

## The adapter

`react-router-effect/server` is a React Router adapter for Effect's Node HTTP server
(`@effect/platform-node`). It handles everything between an `HttpServerRequest` and React Router. That
is the Web `Request` and its abort signal, the route factory, and the client build. It also converts
React Router's `Response`, with its streamed body and its cookies. The adapter is an
Effect HTTP app like any other. The app serves it with its own Effect HTTP server and keeps its own
middleware: logging, compression, tracing, proxies and other routes.

React Router keeps doing what it does for any other server adapter: documents, `.data` requests,
streamed promises, resource routes, the lazy route manifest and middleware. Before React Router
sees the build, the adapter runs every loader, action and middleware through your route factory:

- A route function that returns an Effect runs with the factory's runtime and request context.
  Its failures go through the factory's error handlers.
- Any other route function passes through. Promise loaders and `makeLoader` wrappers keep working.

The options:

- `build` is the server build, or a function that loads it.
- `factory` is the route factory.
- `requestContext: (request) => Context` builds the request's services before React Router runs.
- `clientAssets: true` serves the client build, `build.assetsBuildDirectory` under
  `build.publicPath`, before React Router. Files under `assets/` use a content hash in their name,
  and the adapter caches them for a year as immutable. It caches other files for an hour. It serves
  the files as `express.static` does. A directory serves its index file, such as a prerendered page.
  A directory path without the trailing slash redirects to the path with it. It does not serve
  dotfiles, and a request it does not serve goes to React Router. Like `express.static`, it looks up
  each GET and HEAD request in the file system. It serves only a build that it loads once: in
  production mode, or a build value. It never serves a development build, where Vite serves the
  client. `assetsBuildDirectory` is relative to the working directory of the server. If the adapter
  cannot read it, making the app fails with a `ClientBuildError` that names the resolved directory.
  It needs the platform's file system, which `NodeHttpServer.layer` provides.
- `mode` is React Router's server mode. The default is `process.env.NODE_ENV`. In production the
  adapter loads the build once.

The Web request comes from `HttpServerRequest.toWeb`, body included. Effect's stream sends the
`100 Continue` when React Router reads the body of a request that sends `Expect: 100-continue`.

The request URL is the one Effect derives from the request. An app behind a proxy applies the
headers it trusts in its own middleware, with `request.modify` or `HttpMiddleware.xForwardedHeaders`.
The request signal aborts only if the response ends early. That happens when the client leaves while
React Router runs, or while the body streams. A completed response never aborts it.

React Router logs and answers the errors of route code. If the adapter's own steps fail, for example
a `requestContext` that throws, the adapter logs the error with `Effect.logError` and answers 500.
The log goes to the loggers of the app's Effect runtime.

### Development with Vite

In development Vite serves the client. `react-router-effect/vite` runs Vite's middleware in front of
the app, on Effect's Node HTTP server:

```ts
import { ReactRouterVite } from "react-router-effect/vite";

const vite = await createServer({ server: { middlewareMode: true } });
HttpServer.serve(Effect.flatten(reactRouterApp).pipe(ReactRouterVite.devMiddleware(vite)));
```

In development, making the app does nothing but return it, so the server can make it for each
request. Load the module that calls `ReactRouterHttp.make` through `vite.ssrLoadModule`. Then the route
modules, the factory and the adapter share Vite's module graph. The example's `server.js` and
`server/main.ts` do this.

### Cookies

Set cookies from route code with React Router's cookie helpers, `createCookie` and the session
storages, as in any React Router app. The adapter converts React Router's `Set-Cookie` values into
the response's `cookies`, as `HttpServerResponse.fromWeb` does. Effect HTTP middleware around the
adapter can read and change them like any other cookie. A response that replaces React Router's has
none of them.

Effect keeps one cookie per name and only the attributes it knows: `Max-Age`, `Domain`, `Path`,
`Expires`, `HttpOnly`, `Secure`, `Partitioned`, `Priority` and `SameSite`. If one response sets the
same cookie name twice, for example to expire it on one path and set it on another, only the last
one is sent.

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

When the request has a server span, the adapter traces React Router. The span comes from
`HttpMiddleware.tracer` with a tracer that exports spans, such as `OtelTracer`. Each middleware,
loader and action runs in a span of its own, such as `react-router.loader routes/todos`. The spans
nest as React Router calls the functions. This is the example's `GET /todos`:

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

- Effect 4.1 or later, React Router 8.3 or later for the adapter, and `skipLibCheck`. The brand
  augments `Effect`, and TypeScript cannot test the variance annotations of that augmentation.
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

Without the adapter there is no `requestContext` option. Set the context key in a plain React Router
middleware. The factory's `requestContext` reads it, and provides those services to the loader or
action:

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
- `react-router-effect/server` exports `ReactRouterHttp.make`, and the types `RouteEffectCheck` and
  `RouteEffectFailures`.
- `react-router-effect/vite` exports `ReactRouterVite.devMiddleware`, for development. It needs
  `@effect/platform-node`.

## Development

```bash
vp install   # install dependencies
vp test      # run the test suite
vp check     # format, lint, type-check
vp pack      # build the library
```

## License

MIT
