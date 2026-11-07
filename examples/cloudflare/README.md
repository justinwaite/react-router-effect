# Example: React Router on a Cloudflare Worker

A React Router framework-mode app served by `react-router-effect` from a Cloudflare Worker. Its
`App` is the same kind of layer that the [Node example](../node) serves. Only `workers/app.ts` is
specific to Cloudflare: Effect's `HttpRouter.toWebHandler` serves `App` there.

```sh
vp install              # in the repository root
vp run build            # the package, in the repository root
cd examples/cloudflare
vp run typegen          # wrangler types, then react-router typegen
vp run dev              # Vite runs the Worker in workerd
vp run build && vp run preview
vp run typecheck
vp run test             # builds, then tests the production build and development
```

## What it shows

| File                               | What it shows                                                        |
| ---------------------------------- | -------------------------------------------------------------------- |
| `workers/app.ts`                   | The Worker: `HttpRouter.toWebHandler` serves `App`                   |
| `server/app.ts`                    | `App`: React Router, a connection per request, `loadContext`         |
| `app/lib/route-factory.server.ts`  | The route factory, with the Worker's `env` in its runtime            |
| `app/lib/background.server.ts`     | `runInBackground`: an Effect after the response, with `waitUntil`    |
| `app/routes/home.tsx`              | An Effect loader that streams a promise while its connection is open |
| `app/routes/note.tsx`              | A domain error that the factory throws as a 404                      |
| `app/routes/legacy.tsx`            | A promise loader that reads the Worker's `env` from `loadContext`    |
| `app/routes/background.ts`         | A resource route that runs work after its response                   |
| `wrangler.jsonc`, `vite.config.ts` | The Worker's configuration and the Cloudflare Vite plugin            |

## Install

```bash
vp add react-router-effect effect react-router react react-dom isbot
vp add -D @react-router/dev @cloudflare/vite-plugin wrangler
```

A Worker does not need `@effect/platform-node`. Only `react-router-effect/vite` imports it, and a
Worker does not use that entry.

## The Worker

`workers/app.ts` builds the handler once, at module scope. In production, the layer loads the
build at that time. Each request gets the Worker's execution context as a service.

```ts
const app = HttpRouter.toWebHandler(App, { disableLogger: true });

export default {
  fetch: (request, _env, ctx) => app.handler(request, Context.make(WorkerExecutionContext, ctx)),
} satisfies ExportedHandler<Env>;
```

Without `disableLogger`, Effect logs every request to the Worker's console.

## Services

The Worker's `env` comes from `cloudflare:workers` at module scope. The route factory's runtime
provides it, so route Effects can require it:

```ts
import { env } from "cloudflare:workers";

export const runtime = ManagedRuntime.make(
  Layer.mergeAll(Format.layer, Layer.succeed(WorkerEnv)(env)),
);
```

The runtime lasts as long as the isolate. A Worker cannot share I/O objects across requests, so
the runtime's services must not hold one, such as a database connection.

The execution context belongs to one request. `workers/app.ts` passes it with the request. A route
Effect that requires it names it in the factory's request context:

```ts
export const requestContext: RequestContextKey<WorkerExecutionContext | Connection> =
  createContext();
```

A resource of one request, such as a database connection, comes from a router middleware.
`Layer.build` builds it in the request's scope. At the end of the response body, Effect closes that
scope. This is also true for a body that streams a promise:

```ts
const Connections = HttpRouter.middleware((app) =>
  Effect.flatMap(Layer.build(ConnectionLive), (context) => Effect.provideContext(app, context)),
).layer;
```

A platform service, such as a tracer, goes into the layer that `toWebHandler` gets, with
`Layer.provideMerge`. Effect's Web handler serves each request with the services of that layer. A
tracer that `Layer.provide` gives to the layer does not reach the requests, so the adapter makes no
spans:

```ts
const app = HttpRouter.toWebHandler(App.pipe(Layer.provideMerge(TracerLive)));
```

## Work after the response

`runInBackground` in `app/lib/background.server.ts` runs an Effect with Cloudflare's `waitUntil`.
The package does not export it, because `cloudflare:workers` exists only in workerd.

```ts
export const runInBackground = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Exclude<R, Scope.Scope>> =>
  Effect.flatMap(Effect.context<Exclude<R, Scope.Scope>>(), (context) =>
    Effect.sync(() => {
      waitUntil(
        Effect.runPromiseWith(context)(
          effect.pipe(
            Effect.scoped,
            Effect.catchCause((cause) => Effect.logError("A background Effect failed", cause)),
          ),
        ),
      );
    }),
  );
```

The Effect gets the services of the route that calls it. The request's scope closes at the end of
the response body, so the Effect runs in a scope of its own. If it needs a resource, such as a
connection, it opens its own.

## The mode

`mode` is required. The example passes `import.meta.env.MODE`, which the Vite plugins set to
`development` or `production`.

## Requests

React Router gets the Worker's own `Request`. Its URL is already final, so a Worker needs no
`HttpMiddleware.xForwardedHeaders`. Middleware can change the `HttpServerRequest`, for example its URL or
headers. On a Web server, that change does not reach React Router.

`wrangler.jsonc` sets the `enable_request_signal` compatibility flag. With the flag, a client that
leaves aborts the request's signal. Then React Router stops streamed promises, and route code sees
the abort. Without the flag, route code does not see a client that leaves.

## Client files

Cloudflare serves the client build from the Worker's static assets, before the Worker runs. The
Cloudflare Vite plugin sets them up from `build/client`. So the app has no
`ReactRouterAssets.layer`, which reads files from a file system.

## Development

`vite.config.ts` uses `@cloudflare/vite-plugin` with React Router's Vite plugin. In development,
the plugin runs the Worker in workerd. The app does not use `react-router-effect/vite`, which runs
Vite's middleware on Effect's Node server.

## Scheduler

The adapter shares no fibers across requests. The runtime's services can start fibers that
requests share, such as a poller or a cache that refreshes itself. For those fibers, read the note
about Workers in the docs of Effect's `HttpRouter.toWebHandler`. Effect advises
`new Scheduler.MixedScheduler("sync")`.

## Tests

`vp run test` builds the app, then runs the same tests against `vp preview` and `react-router dev`.
Both run the Worker in workerd. The tests check documents, and a promise that streams while the
request's connection is open. They check that the connection closes at the end of the body. They
also check a domain error, `loadContext`, `waitUntil`, and the client files in production.

CI does not run these tests. In the repository root, `test/workerd.test.ts` runs the adapter in
workerd on every CI run.
