---
"react-router-effect": minor
---

Support per-request services from React Router middleware.

Pass a `requestContext` — a React Router context key holding a per-request effect `Context.Context` — to the factory. Middleware sets a fresh context on each request; the runner reads `args.context.get(requestContext)` and provides those services to the loader/action, so effects can require request-scoped services (the current user, a request id, a per-request transaction) with no `Effect.provide`:

```ts
// a plain React Router context key — `createContext` is RR's own
export const requestContext: RequestContextKey<RequestContext> = createContext();

// middleware sets a fresh value per request
export const middleware: Route.MiddlewareFunction[] = [
  ({ context, request }, next) => {
    context.set(requestContext, Context.make(RequestContext, { userId: readUser(request) }));
    return next();
  },
];

// wire the same key into the factory
const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()({ runtime, requestContext });

// the loader requires RequestContext directly — fresh each request
const loader = makeLoader(() =>
  Effect.gen(function* () {
    const { userId } = yield* RequestContext;
    return { userId };
  }),
);
```

Effects may require both the runtime's app-wide services and the request context's request-scoped services; requiring anything else is a compile error. Adds a `RequestContextKey<ReqServices>` type alias (`RouterContext<Context.Context<ReqServices>>`) for annotating the key.
