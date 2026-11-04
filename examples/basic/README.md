# Example: React Router on the Effect HTTP server

A React Router framework-mode app served by `react-router-effect` on Effect's Node HTTP server. It
is the package's reference app: its tests run against the production build, and its benchmarks
measure the adapter against React Router's own servers.

```sh
vp install              # in the repository root
vp run build            # the package, in the repository root
cd examples/basic
vp run dev              # Vite in middleware mode, on http://localhost:3000
vp run build && vp run start
vp run typecheck        # react-router typegen, then tsc with the route check
vp run test             # builds, then tests the production and development servers
vp run bench            # the adapter's cost per request, in process
node bench/http.ts      # load over HTTP, against Express and @react-router/node
```

## What it shows

| File                              | What it shows                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| `server/app.ts`                   | `ReactRouterHttp.make`: the build, the factory, the client build, request services |
| `server/main.ts`                  | The app's own server: listening, logging, compression, Vite in development         |
| `server.js`                       | Starts the server through Vite in development, from the build otherwise            |
| `app/lib/route-factory.server.ts` | The route factory, its runtime and error handler, and the `Register`               |
| `app/lib/route-effects.check.ts`  | The route check: fails to compile on an unhandled error                            |
| `app/root.tsx`                    | An Effect middleware that provides a service around `next()` and sets a cookie     |
| `app/routes/home.tsx`             | An Effect loader whose data streams a promise                                      |
| `app/routes/todos.tsx`            | An Effect action: a recovered domain error, `useFetcher<typeof action>()`          |
| `app/routes/todos-old.ts`         | A redirect through `Respond.redirect`                                              |
| `app/routes/legacy.tsx`           | A plain promise loader, which the adapter passes through                           |
| `app/routes/events.ts`            | Server-sent events from an Effect `Stream`, interrupted when the client leaves     |

The adapter is the boundary to React Router: everything React Router needs, the app does not write.
The app owns the HTTP server and its middleware.

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
| document, promise       | 1,256 req/s          | 1,189 req/s      | 1,042 req/s         | 88%        | 87–94% |
| document, Effect        | 1,433 req/s          | 1,355 req/s      | 1,200 req/s         | 89%        | 87–89% |
| `.data`, promise loader | 3,582 req/s          | 3,328 req/s      | 2,885 req/s         | 87%        | 84–90% |
| `.data`, Effect loader  | 3,524 req/s          | 3,221 req/s      | 2,779 req/s         | 86%        | 85–90% |
| action, promise         | 3,882 req/s          | 3,532 req/s      | 2,719 req/s         | 77%        | 74–78% |
| action, Effect          | 3,741 req/s          | 3,487 req/s      | 2,777 req/s         | 80%        | 78–82% |
| client file             | –                    | 10,934 req/s     | 4,716 req/s         | 43%        | 39–43% |

Where the time goes, per request against `@react-router/node`, Express / the adapter:

| Case                    | Total         | The server itself | Request and response against Web ones | The adapter's own work |
| ----------------------- | ------------- | ----------------- | ------------------------------------- | ---------------------- |
| document, promise       | +17 / +127 µs | +22 / +5 µs       | -5 / +59 µs                           | +64 µs                 |
| document, Effect        | +46 / +152 µs | +23 / +5 µs       | +24 / +44 µs                          | +103 µs                |
| `.data`, promise loader | +28 / +65 µs  | +23 / +5 µs       | +5 / +20 µs                           | +40 µs                 |
| `.data`, Effect loader  | +30 / +68 µs  | +23 / +6 µs       | +6 / +22 µs                           | +40 µs                 |
| action, promise         | +14 / +114 µs | +8 / +4 µs        | +6 / +55 µs                           | +55 µs                 |
| action, Effect          | +16 / +92 µs  | +8 / +4 µs        | +9 / +41 µs                           | +47 µs                 |

A server varies by 2–10% between rounds on this machine, about 10–30 µs on a `.data` request and
more on a document, so read the rows as approximate.

- **The server itself.** Effect's HTTP server costs 4–6 µs per request. Express costs 22–23 µs
  on a GET, most of it `express.static` looking for a file on every request before React Router
  runs, and 8 µs on a POST, which `express.static` skips.
- **Request and response against Web ones.** `@react-router/express` converts as
  `@react-router/node` does, so Express adds next to nothing here. On Effect's server, React
  Router's response body streams through an Effect `Stream`, chunk by chunk, so documents, which
  stream the most chunks, pay the most. Actions also read the request body through an Effect stream.
  The response body is an `HttpServerResponse` so that the app's own
  middleware, such as compression, can work on it; writing it to Node directly would bypass that.
- **The adapter's own work**, 40–103 µs: what the adapter adds to `effect-minimal`. It is the
  request fiber's context for route Effects, the abort signal, which watches the response body with
  `Stream.onExit`, the client build lookup, the call into React Router with interruption, the
  response conversion, and the tracing check. The document rows vary the most between rounds.

What changed the numbers:

- Loading a production build once, not on every request, copying response headers once, and
  listing the client build once per build.
- The adapter uses only Effect's HTTP modules. Two Node-specific versions were faster but are not
  kept. Reading the request body with React Router's `createReadableStreamFromReadable` cost about
  33 µs less per request than Effect's stream (`bench/request-body.ts`). Listening for the Node
  response's `close` event cost about 25 µs less per request than a `Stream.onExit` on the response
  body.
- Did not help, so not kept: streaming a client file with headers kept from its first response,
  without the static server's second lookup; piping the response body through Node streams
  (`Readable.fromWeb` and a raw response), slower by 30–80 µs per request.

Client files are at 41% of `express.static`: Effect's `HttpStaticServer` stats each file twice and
writes through a raw Node pipe that builds an abort error per response. Both are in Effect, not the
adapter; in production, put a CDN in front of `/assets/`.
