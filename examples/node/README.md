# Example: React Router on Node

A React Router framework-mode app served by `react-router-effect` on Effect's Node HTTP server. Its
tests run against the production build, and its benchmarks measure the adapter against React
Router's own servers. The [Cloudflare example](../cloudflare) serves the same kind of `App` from a
Worker.

```sh
vp install              # in the repository root
vp run build            # the package, in the repository root
cd examples/node
vp run dev              # Vite in middleware mode, on http://localhost:3000
vp run build && vp run start
vp run typecheck        # react-router typegen, then tsc with the route check
vp run test             # builds, then tests the production and development servers
vp run bench            # the adapter's cost per request, in process
node bench/http.ts      # load over HTTP, against Express and @react-router/node
```

## What it shows

| File                              | What it shows                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `server/app.ts`                   | `App`: React Router, the client build, request services, a route of its own    |
| `server.js`                       | Serves `App` with compression, through `ReactRouterVite.layer` in development  |
| `app/lib/route-factory.server.ts` | The route factory, its runtime and error handler, and the `Register`           |
| `app/lib/route-effects.check.ts`  | The route check: fails to compile on an unhandled error                        |
| `app/root.tsx`                    | An Effect middleware that provides a service around `next()` and sets a cookie |
| `app/routes/home.tsx`             | An Effect loader whose data streams a promise                                  |
| `app/routes/todos.tsx`            | An Effect action: a recovered domain error, `useFetcher<typeof action>()`      |
| `app/routes/todos-old.ts`         | A redirect through `Respond.redirect`                                          |
| `app/routes/legacy.tsx`           | A plain promise loader, which the adapter passes through                       |
| `app/routes/events.ts`            | Server-sent events from an Effect `Stream`, interrupted when the client leaves |

The adapter is the boundary to React Router: everything React Router needs, the app does not write.
The app owns the HTTP server and its middleware.

## Development with Vite

In development, Vite serves the client and loads the server code. `ReactRouterVite.layer(vite,
loadApp)`, from `react-router-effect/vite`, passes each request to Vite first. For a request that
Vite passes on, it calls `loadApp` and serves the request with the `App` that `loadApp` returns.
`server.js` uses it, and it is the only file that does not reload in development:

```js
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
```

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

## Requests on Effect's Node server

If a request sends `Expect: 100-continue`, Effect's stream sends the `100 Continue` at the moment
React Router reads the body.

The request URL is the one that Effect derives from the request: its path, its `host` header and its
protocol. An app behind a proxy applies the headers that it trusts with
`HttpMiddleware.xForwardedHeaders`, as a server middleware or a global router middleware. Both run
before the router reads the request. `HttpMiddleware.tracer` runs outside the server middleware, so
its span has the request before the change.

Behind a chain of proxies, React Router can expect a different host and scheme than
`xForwardedHeaders` gives. If `X-Forwarded-Host` or `X-Forwarded-Proto` does not have one value for
each `X-Forwarded-For` entry, `xForwardedHeaders` ignores that header. Express takes the first value
of each header. If your app is behind a proxy, make sure that the correct headers reach the server.

Effect's Node server writes the head of a streamed response with its first chunk. So an
`EventSource` client sees the response open at the first event, and not at the return of the route.

## Tracing

Provide the tracer to the layer that calls `HttpRouter.serve`, in `server.js`:

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

Effect's Node server runs each request with the services of that layer. A tracer that only `App`
provides makes no server span, so the adapter adds no spans.

## Benchmarks

The baselines serve the same build with React Router's own request handler. Their route functions
run through the same route factory, so the Effect runtime, the request's services, the error
handlers and the action metadata cost the same on both sides. Each server runs in its own process,
and none logs, compresses or traces.

- `bench/handler.bench.ts`: one request at a time, in one process: `@react-router/node` against the
  adapter on Effect's Node HTTP server, both on loopback.
- `bench/http.ts`: load over HTTP from `autocannon` against `@react-router/node` on `node:http`,
  React Router's Express template with `express.static`, and the adapter on Effect's Node HTTP
  server. Each round runs every server in turn, and the tables show the median of 3 rounds.
- `bench/http.ts --gaps`: splits the time per request into its parts, for Express and for the
  adapter. Three floor servers answer every request with a fixed body, without React Router:
  `node:http`, Effect's server, and Express with the template's `express.static`. Their difference
  to `node:http` is each server's own cost. `effect-minimal` is the least an Effect server can do to
  call React Router: `HttpServerRequest.toWeb`, the handler, and `HttpServerResponse.fromWeb`. The adapter's own work is its difference to `effect-minimal`.
- `bench/request-body.ts`: the request body alone, from Node's stream to a Web `Request` and its
  form data, per way of reading it.

The last run, on one Node 24 process with 50 connections, 5 seconds per case, the median of 3
rounds. The last column is the range of the 3 rounds.

| Case                    | `@react-router/node` | Express template | react-router-effect | vs Express | Rounds |
| ----------------------- | -------------------- | ---------------- | ------------------- | ---------- | ------ |
| document, promise       | 1,298 req/s          | 1,212 req/s      | 1,070 req/s         | 88%        | 85–95% |
| document, Effect        | 1,443 req/s          | 1,346 req/s      | 1,164 req/s         | 86%        | 84–88% |
| `.data`, promise loader | 3,615 req/s          | 3,185 req/s      | 2,869 req/s         | 90%        | 88–92% |
| `.data`, Effect loader  | 3,574 req/s          | 3,147 req/s      | 2,737 req/s         | 87%        | 87–91% |
| action, promise         | 3,803 req/s          | 3,517 req/s      | 2,657 req/s         | 76%        | 73–76% |
| action, Effect          | 3,638 req/s          | 3,429 req/s      | 2,679 req/s         | 78%        | 76–81% |
| client file             | –                    | 11,388 req/s     | 4,582 req/s         | 40%        | 39–41% |

Where the time goes, per request against `@react-router/node`. Run `node bench/http.ts --gaps` to
measure each part on your machine.

- **The server itself.** Effect's HTTP server costs less than Express. On a GET, most of the cost
  of Express is `express.static`, which looks for a file on every request before React Router runs.
  A POST skips `express.static`.
- **Request and response against Web ones.** `@react-router/express` converts as
  `@react-router/node` does, so Express adds next to nothing here. On Effect's server, React
  Router's response body streams through an Effect `Stream`, chunk by chunk, so documents, which
  stream the most chunks, pay the most. Actions also read the request body through an Effect stream.
  The response body is an `HttpServerResponse` so that the app's own
  middleware, such as compression, can work on it; writing it to Node directly would bypass that.
- **The adapter's own work**: what the adapter adds to `effect-minimal`. It includes the request
  fiber's context for route Effects and the abort signal, which watches the response body with
  `Stream.onExit`. It also includes the call into React Router with interruption, the response
  conversion and the tracing check.

What changed the numbers:

- Loading a production build once, not on every request, copying response headers once, and
  listing the client build once per build.
- The adapter uses only Effect's HTTP modules. Two Node-specific versions were faster but are not
  kept. Reading the request body with React Router's `createReadableStreamFromReadable` cost about
  33 µs less per request than Effect's stream (`bench/request-body.ts`). Listening for the Node
  response's `close` event was faster than a `Stream.onExit` on the response body.
- Did not help, so not kept: streaming a client file with headers kept from its first response,
  without the static server's second lookup; piping the response body through Node streams
  (`Readable.fromWeb` and a raw response), which was slower.

Client files are at 40% of `express.static`: Effect's `HttpStaticServer` stats each file twice and
writes through a raw Node pipe that builds an abort error per response. Both are in Effect, not the
adapter; in production, put a CDN in front of `/assets/`.
