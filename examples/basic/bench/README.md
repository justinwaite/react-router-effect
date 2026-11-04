# Performance

The benchmarks measure the adapter against React Router's own servers, with the same build and the
same route code. The baselines run route Effects through the same route factory, which provides the
request's services, maps errors and attaches the action metadata. The setup is one Node 24 process
with 50 connections. Each number is the median of 3 rounds:

| Case                    | `@react-router/node` | Express template | react-router-effect | vs Express |
| ----------------------- | -------------------- | ---------------- | ------------------- | ---------- |
| document, promise       | 1,256 req/s          | 1,189 req/s      | 1,042 req/s         | 88%        |
| document, Effect        | 1,433 req/s          | 1,355 req/s      | 1,200 req/s         | 89%        |
| `.data`, promise loader | 3,582 req/s          | 3,328 req/s      | 2,885 req/s         | 87%        |
| `.data`, Effect loader  | 3,524 req/s          | 3,221 req/s      | 2,779 req/s         | 86%        |
| action, promise         | 3,882 req/s          | 3,532 req/s      | 2,719 req/s         | 77%        |
| action, Effect          | 3,741 req/s          | 3,487 req/s      | 2,777 req/s         | 80%        |
| client file             | n/a                  | 10,934 req/s     | 4,716 req/s         | 43%        |

From `examples/basic`, `node bench/http.ts --gaps` splits the time per request, for Express and for
the adapter. Effect's HTTP server costs 4 to 6 µs per request. Express with `express.static` costs
22 to 23 µs on a GET. The adapter loses that back in converting the request and React Router's
response. Both bodies stream through an Effect `Stream`, so the app's middleware can work on them.
This costs 20 to 59 µs per request, most for documents and actions. The adapter's own work adds 40
to 103 µs. It includes the request's services, the abort signal and the cookies. Client files go through Effect's `HttpStaticServer`,
which looks each file up twice. In production, put a CDN in front of `/assets/`.

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
   response body. This saved about 25 µs per request.

Both changes tie the adapter to Effect's Node HTTP server, and the first adds `@react-router/node`
as a peer dependency. Run `node bench/http.ts` before and after to confirm the gain on your machine.

[The example's README](../README.md#benchmarks) describes each benchmark, how to run it, and where
the time goes.
