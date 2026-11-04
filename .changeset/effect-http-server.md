---
"react-router-effect": minor
---

Serve React Router from the Effect HTTP server, and write loaders, actions and middleware as plain `Effect.fn` functions.

- `react-router-effect/server` adds `ReactRouterHttp.make`, an adapter that serves a React Router build as an Effect HTTP app: the Web request and its abort signal, cookies as Effect cookies, streamed bodies, and the client build with `clientAssets`. It wraps every route module with the route factory, so a route function that returns an Effect runs with the factory's runtime, request context and error handling, and any other route function passes through.
- With a server span from Effect's HTTP tracer and a tracer that exports spans, the adapter runs each middleware, loader and action in a span of its own, nested as React Router calls them, and sets `http.route` on the server span.
- `@effect/platform-node` is an optional peer dependency, needed only by `react-router-effect/vite`. `react-router-effect/server` uses only Effect's HTTP modules. It converts React Router's `Set-Cookie` values into the response's cookies, so Effect keeps one cookie per name.
- `react-router-effect/vite` adds `ReactRouterVite.devMiddleware`, which runs Vite's dev middleware in front of the app on Effect's Node HTTP server.
- `RouteEffectCheck` fails to compile with a message that lists each route and export when a route Effect leaves an error unhandled or needs a service that is not provided.
- The factory takes `actionMeta`, which the adapter attaches to every action's data under `__meta`.
- An effect middleware can provide services and log annotations around `next()` for every effect downstream.
- Effects are branded with React Router's `unstable_SerializesTo`, so `Route.ComponentProps` and React Router's hooks type the data of Effect loaders and actions. `EffectRouteArgs` and `RouteData` type hooks that read `typeof loader`.
- Requires `effect` 4.1 or later.
