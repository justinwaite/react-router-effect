# Example: React Router on a Cloudflare Worker

A React Router framework-mode app served by `react-router-effect` from a Cloudflare Worker. Its
tests run the Worker in workerd: the production build with `vp preview`, and development with
`react-router dev`.

```sh
vp install              # in the repository root
vp run build            # the package, in the repository root
cd examples/cloudflare
vp run typecheck        # wrangler types, react-router typegen, then tsc with the route check
vp run dev              # the Cloudflare Vite plugin, on http://localhost:5173
vp run build && vp run preview
vp run test             # builds, then tests the production build and development in workerd
```

## What it shows

| File                              | What it shows                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `workers/app.ts`                  | `ReactRouterWorker.make`: the build, the factory, a request layer, a load context |
| `app/lib/route-factory.server.ts` | The route factory, its runtime and error handler, and the Worker env's `Register` |
| `app/lib/services.server.ts`      | An app-wide service, and a per-request connection built as a scoped layer         |
| `app/lib/route-effects.check.ts`  | The route check: fails to compile on an unhandled error or a missing service      |
| `app/root.tsx`                    | An Effect loader that reads the Worker's env through `WorkerContext`              |
| `app/routes/home.tsx`             | A promise that streams after the shell, on the request's connection               |
| `app/routes/note.tsx`             | A domain error that the factory throws to the error boundary as a 404             |
| `app/routes/legacy.tsx`           | A plain promise loader, which reads the context that `getLoadContext` made        |
| `app/routes/background.ts`        | `WorkerContext.waitUntil`: work after the response, with the request's services   |
| `app/routes/stats.ts`             | What the isolate saw: connections opened and closed, for the tests                |
