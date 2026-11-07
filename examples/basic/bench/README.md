# Performance

The benchmarks measure the adapter against React Router's own servers, with the same build and the
same route code. The baselines run route Effects through the same route factory, which provides the
request's services, maps errors and attaches the action metadata. The setup is one Node 24 process
with 50 connections. Each number is the median of 3 rounds:

| Case                    | `@react-router/node` | Express template | react-router-effect | vs Express |
| ----------------------- | -------------------- | ---------------- | ------------------- | ---------- |
| document, promise       | 1,298 req/s          | 1,212 req/s      | 1,070 req/s         | 88%        |
| document, Effect        | 1,443 req/s          | 1,346 req/s      | 1,164 req/s         | 86%        |
| `.data`, promise loader | 3,615 req/s          | 3,185 req/s      | 2,869 req/s         | 90%        |
| `.data`, Effect loader  | 3,574 req/s          | 3,147 req/s      | 2,737 req/s         | 87%        |
| action, promise         | 3,803 req/s          | 3,517 req/s      | 2,657 req/s         | 76%        |
| action, Effect          | 3,638 req/s          | 3,429 req/s      | 2,679 req/s         | 78%        |
| client file             | n/a                  | 11,388 req/s     | 4,582 req/s         | 40%        |

From `examples/basic`, `node bench/http.ts --gaps` splits the time per request, for Express and for
the adapter. Effect's HTTP server costs less per request than Express with `express.static` on a
GET. The adapter loses that gain in converting the request and React Router's response. Both bodies
stream through an Effect `Stream`, so the app's middleware can work on them. This costs the most
for documents and actions. The adapter's own work includes the request's services, the abort
signal and the cookies. Client files go through Effect's `HttpStaticServer`, which looks each file
up twice. In production, put a CDN in front of `/assets/`.

## Faster on Node

The adapter uses only Effect's HTTP modules. If its cost per request becomes a bottleneck, two
Node-specific changes in `src/server.ts` measured faster. Neither changes how cookies work.

1. Read the request body with React Router's `createReadableStreamFromReadable` from
   `@react-router/node`, on `NodeHttpServerRequest.toIncomingMessage(request)`, in place of the
   body that `HttpServerRequest.toWeb` streams. This saved about 33 µs per request that has a body
   (`bench/request-body.ts`). Keep `HttpServerRequest.toWeb` for a request that sends `Expect`,
   because its stream sends the `100 Continue`.
2. Listen for the `close` event of `NodeHttpServerRequest.toServerResponse(request)`. If the
   response did not finish, abort the request signal there. Remove the `Stream.onExit` on the
   response body.

Both changes tie the adapter to Effect's Node HTTP server, and the first adds `@react-router/node`
as a peer dependency. Run `node bench/http.ts` before and after to confirm the gain on your machine.

[The example's README](../README.md#benchmarks) describes each benchmark, how to run it, and where
the time goes.
