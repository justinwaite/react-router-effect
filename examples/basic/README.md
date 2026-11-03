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
  call React Router: `HttpServerRequest.toWeb` with the adapter's request body, the handler, and
  `HttpServerResponse.fromWeb`. The adapter's own work is its difference to `effect-minimal`.
- `bench/request-body.ts`: the request body alone, from Node's stream to a Web `Request` and its
  form data, per way of reading it.

The last run, on one Node 24 process with 50 connections, 5 seconds per case, the median of 3
rounds. The last column is the range of the 3 rounds.

| Case                    | `@react-router/node` | Express template | react-router-effect | vs Express | Rounds |
| ----------------------- | -------------------- | ---------------- | ------------------- | ---------- | ------ |
| document, promise       | 1,251 req/s          | 1,142 req/s      | 1,106 req/s         | 97%        | 88–97% |
| document, Effect        | 1,361 req/s          | 1,287 req/s      | 1,181 req/s         | 92%        | 92–95% |
| `.data`, promise loader | 3,484 req/s          | 3,139 req/s      | 2,907 req/s         | 93%        | 91–95% |
| `.data`, Effect loader  | 3,350 req/s          | 3,022 req/s      | 2,883 req/s         | 95%        | 92–99% |
| action, promise         | 3,612 req/s          | 3,522 req/s      | 3,092 req/s         | 88%        | 87–89% |
| action, Effect          | 3,448 req/s          | 3,378 req/s      | 3,018 req/s         | 89%        | 87–92% |
| client file             | –                    | 10,633 req/s     | 4,354 req/s         | 41%        |        |

Where the time goes, per request against `@react-router/node`, Express / the adapter:

| Case                    | Total         | The server itself | Request and response against Web ones | The adapter's own work |
| ----------------------- | ------------- | ----------------- | ------------------------------------- | ---------------------- |
| document, promise       | +76 / +104 µs | +22 / +5 µs       | +54 / +101 µs                         | -1 µs                  |
| document, Effect        | +42 / +112 µs | +23 / +4 µs       | +19 / +86 µs                          | +22 µs                 |
| `.data`, promise loader | +32 / +57 µs  | +25 / +6 µs       | +7 / +28 µs                           | +23 µs                 |
| `.data`, Effect loader  | +32 / +48 µs  | +23 / +5 µs       | +9 / +23 µs                           | +21 µs                 |
| action, promise         | +7 / +47 µs   | +7 / +4 µs        | 0 / +14 µs                            | +29 µs                 |
| action, Effect          | +6 / +41 µs   | +7 / +5 µs        | -1 / +10 µs                           | +27 µs                 |

A server varies by 2–10% between rounds on this machine, about 10–30 µs on a `.data` request and
more on a document, so read the rows as approximate.

- **The server itself.** Effect's HTTP server costs 4–6 µs per request. Express costs 22–25 µs
  on a GET, most of it `express.static` looking for a file on every request before React Router
  runs, and 7 µs on a POST, which `express.static` skips.
- **Request and response against Web ones.** `@react-router/express` converts as
  `@react-router/node` does, so Express adds next to nothing here. On Effect's server, React
  Router's response body streams through an Effect `Stream`, chunk by chunk, so documents, which
  stream the most chunks, pay the most. The body is an `HttpServerResponse` so that the app's own
  middleware, such as compression, can work on it; writing it to Node directly would bypass that.
- **The adapter's own work**, 21–29 µs: what the adapter adds to `effect-minimal`. Switching its
  parts off one at a time, all of them together, brought it to `effect-minimal`'s cost. They are
  the request fiber's context for route Effects, the abort signal of the request, the client build
  lookup, the call into React Router with interruption, the response conversion that keeps every
  cookie, and the tracing check. None measured above about 15 µs on its own, which is below what this
  machine resolves reliably, and each is a feature the adapter needs.

What changed the numbers:

- The request body. `HttpServerRequest.toWeb` reads a body through an Effect stream, which costs
  about 33 µs more per request under load than React Router's `createReadableStreamFromReadable`
  (`bench/request-body.ts`). The adapter reads bodies with React Router's function, as
  `@react-router/node` does. A request that sends `Expect` keeps Effect's stream, which sends the
  `100 Continue`. Actions went from 81% to 88% of Express.
- The abort signal. A `Stream.onExit` on the response body aborted the signal when a client left
  mid-stream, and wrapped every chunk. Listening for the Node response's `close` event, as
  `@react-router/node` does, cost about 25 µs less per request.
- Loading a production build once, not on every request, writing `Set-Cookie` values raw, copying
  response headers once, and listing the client build once per build.
- Did not help, so not kept: streaming a client file with headers kept from its first response,
  without the static server's second lookup; piping the response body through Node streams
  (`Readable.fromWeb` and a raw response), slower by 30–80 µs per request.

Client files are at 41% of `express.static`: Effect's `HttpStaticServer` stats each file twice and
writes through a raw Node pipe that builds an abort error per response. Both are in Effect, not the
adapter; in production, put a CDN in front of `/assets/`.
