# Performance

The benchmarks measure the adapter against React Router's own servers, with the same build and the
same route code. The baselines run route Effects through the same route factory, which provides the
request's services, maps errors and attaches the action metadata. The setup is one Node 24 process
with 50 connections. Each number is the median of 3 rounds:

| Case                    | `@react-router/node` | Express template | react-router-effect | vs Express |
| ----------------------- | -------------------- | ---------------- | ------------------- | ---------- |
| document, promise       | 1,251 req/s          | 1,142 req/s      | 1,106 req/s         | 97%        |
| document, Effect        | 1,361 req/s          | 1,287 req/s      | 1,181 req/s         | 92%        |
| `.data`, promise loader | 3,484 req/s          | 3,139 req/s      | 2,907 req/s         | 93%        |
| `.data`, Effect loader  | 3,350 req/s          | 3,022 req/s      | 2,883 req/s         | 95%        |
| action, promise         | 3,612 req/s          | 3,522 req/s      | 3,092 req/s         | 88%        |
| action, Effect          | 3,448 req/s          | 3,378 req/s      | 3,018 req/s         | 89%        |
| client file             | n/a                  | 10,633 req/s     | 4,354 req/s         | 41%        |

From `examples/basic`, `node bench/http.ts --gaps` splits the time per request, for Express and for
the adapter. Effect's HTTP server costs 4 to 6 µs per request. Express with `express.static` costs
22 to 25 µs on a GET. The adapter loses that back in converting React Router's response. Its body
streams through an Effect `Stream`, so the app's middleware can work on it. This costs 10 to 100 µs
per request, most for documents. The adapter's own work adds 21 to 29 µs. It includes the request's
services, the abort signal and every cookie. Client files go through Effect's `HttpStaticServer`,
which looks each file up twice. In production, put a CDN in front of `/assets/`.

[The example's README](../README.md#benchmarks) describes each benchmark, how to run it, and where
the time goes.
