---
"react-router-effect": minor
---

Serve React Router from a Cloudflare Worker, and build per-request services as a scoped layer.

- `react-router-effect/worker` adds `ReactRouterWorker.make`, an adapter whose `fetch` is a Worker's fetch handler. It wraps every route module with the route factory, as the Node adapter does: a route function that returns an Effect runs with the factory's runtime, request context and error handling, and any other route function passes through. It passes the Worker's `Request` to React Router and returns React Router's `Response` as it is. It imports nothing from Node.
- `WorkerContext` gives route Effects the Worker's env and execution context, and `waitUntil` for Effects: the Effect runs after the response with the services of the fiber that calls it. Register the Worker's env type with `Register`'s `workerEnv`.
- `requestLayer`, on both adapters, builds the services of one request as a `Layer`, such as a database connection. The adapter builds it for every request in a scope of its own and closes the scope when the response ends: after its body is sent or cancelled, and on the Worker after the request's `waitUntil` Effects end. The layer may require the services of the factory's runtime, and is type-checked against them.
- `getLoadContext`, on the Worker adapter, makes the router context of a request, so promise route functions keep reading their context keys while an app moves to Effect.
- The Worker adapter runs the request in a server span when the runtime has a tracer that exports spans, with the parent from the request's trace headers.

`RouteHandlers` gains an optional `runtime`, and `FactoryTypes` an optional `Runtime` type parameter. `ReactRouterHttp.make` now infers the factory and `clientAssets` as type parameters of their own, so a request layer is checked against the factory's runtime; the app it makes has the same type as before.
