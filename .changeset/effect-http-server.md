---
"react-router-effect": minor
---

Serve React Router from the Effect HTTP server, and write loaders, actions and middleware as plain `Effect.fn` functions.

- `react-router-effect/server` adds `ReactRouterHttp.make`, an adapter that serves a React Router build as an Effect HTTP app: the Web request and its abort signal, every `Set-Cookie` value, streamed bodies, and the client build with `clientAssets`. It wraps every route module with the route factory, so a route function that returns an Effect runs with the factory's runtime, request context and error handling, and any other route function passes through.
- With a server span from Effect's HTTP tracer and a tracer that exports spans, the adapter runs each middleware, loader and action in a span of its own, nested as React Router calls them, and sets `http.route` on the server span.
- `react-router-effect/server` targets Effect's Node HTTP server: `@effect/platform-node` and `@react-router/node` are optional peer dependencies, needed only by `react-router-effect/server` and `react-router-effect/vite`. A React Router app on Node already has `@react-router/node`.
- `react-router-effect/vite` adds `ReactRouterVite.devMiddleware`, which runs Vite's dev middleware in front of the app on Effect's Node HTTP server.
- `RouteEffectCheck` fails to compile with a message that lists each route and export when a route Effect leaves an error unhandled or needs a service that is not provided.
- The factory takes `actionMeta`, which the adapter attaches to every action's data under `__meta`.
- An effect middleware can provide services and log annotations around `next()` for every effect downstream.
- Effects are branded with React Router's `unstable_SerializesTo`, so `Route.ComponentProps` and React Router's hooks type the data of Effect loaders and actions. `EffectRouteArgs` and `RouteData` type hooks that read `typeof loader`.
- Requires `effect` 4.1 or later.
