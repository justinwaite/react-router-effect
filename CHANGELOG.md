# react-router-effect

## 0.4.0

### Minor Changes

- [#9](https://github.com/justinwaite/react-router-effect/pull/9) [`f0018ae`](https://github.com/justinwaite/react-router-effect/commit/f0018aeae6196459a409aff153a094c38836de8e) Thanks [@justinwaite](https://github.com/justinwaite)! - Support per-request services from React Router middleware.

  Pass a `requestContext` — a React Router context key holding a per-request effect `Context.Context` — to the factory. Middleware sets a fresh context on each request; the runner reads `args.context.get(requestContext)` and provides those services to the loader/action, so effects can require request-scoped services (the current user, a request id, a per-request transaction) with no `Effect.provide`:

  ```ts
  // a plain React Router context key — `createContext` is RR's own
  export const requestContext: RequestContextKey<RequestContext> =
    createContext();

  // middleware sets a fresh value per request
  export const middleware: Route.MiddlewareFunction[] = [
    ({ context, request }, next) => {
      context.set(
        requestContext,
        Context.make(RequestContext, { userId: readUser(request) })
      );
      return next();
    },
  ];

  // wire the same key into the factory
  const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()({
    runtime,
    requestContext,
  });

  // the loader requires RequestContext directly — fresh each request
  const loader = makeLoader(() =>
    Effect.gen(function* () {
      const { userId } = yield* RequestContext;
      return { userId };
    })
  );
  ```

  Effects may require both the runtime's app-wide services and the request context's request-scoped services; requiring anything else is a compile error. Adds a `RequestContextKey<ReqServices>` type alias (`RouterContext<Context.Context<ReqServices>>`) for annotating the key.

## 0.3.0

### Minor Changes

- [#7](https://github.com/justinwaite/react-router-effect/pull/7) [`012b5b7`](https://github.com/justinwaite/react-router-effect/commit/012b5b78333551ecb43897d2abab74160fba7674) Thanks [@justinwaite](https://github.com/justinwaite)! - Support providing a `ManagedRuntime` to the factory, make `errorHandlers` optional, and widen the React Router peer range to include v8.

  **Runtime support.** Pass a `runtime` (an effect `ManagedRuntime`) to the factory and loader/action effects may require its services directly — no per-call `Effect.provide`:

  ```ts
  const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
    runtime: getAppRuntime(), // provides Database, MyService, ...
    errorHandlers: { ... },
  });

  // `MyService` is satisfied by the runtime, not provided here:
  const loader = makeLoader((args: Route.LoaderArgs) =>
    Effect.gen(function* () {
      const svc = yield* MyService;
      return { data: yield* svc.load(args) };
    }),
  );
  ```

  The runtime's services are inferred and become the effect's allowed requirement channel: requiring a service the runtime provides type-checks, while requiring one it doesn't is a compile error. With no `runtime`, effects must still require nothing (unchanged behavior).

  **Optional `errorHandlers`.** `errorHandlers` may now be omitted, so a factory can be configured with just a runtime, or with nothing at all:

  ```ts
  makeLoaderOrActionFactory()({ runtime });
  makeLoaderOrActionFactory()({});
  ```

  **Peer range.** `react-router` is now `^7.16.0 || ^8.0.0`.

## 0.2.0

### Minor Changes

- [#3](https://github.com/justinwaite/react-router-effect/pull/3) [`250092f`](https://github.com/justinwaite/react-router-effect/commit/250092fd2e0f33b9b1b81eee6f6a7f69fd56324b) Thanks [@justinwaite](https://github.com/justinwaite)! - Enforce handling of non-domain errors at the type level.

  `makeLoaderOrActionFactory` now takes the app's domain errors as a type argument and is curried so the handler types are still inferred:

  ```ts
  const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
    errorHandlers: { ... },
  });
  ```

  Declared domain errors may be left unhandled (handled by a registered handler, rendered via `HttpServerRespondable`, or fall through to the 500 default). Any **non-domain** error a route consumes — e.g. a service-specific failure — must now be handled in the loader/action, or `makeLoader`/`makeAction` fails to type-check. This gives app-wide default handling for declared errors while enforcing explicit handling of feature/service-specific ones.

  **Breaking:** the factory is now called as `makeLoaderOrActionFactory<DomainErrors>()({ errorHandlers })` (note the extra `()`), registered handlers must be keyed by a declared domain error, and the factory now returns only `{ makeLoader, makeAction }` (the redundant `makeLoaderOrAction` alias was removed).
