---
"react-router-effect": minor
---

Support providing a `ManagedRuntime` to the factory, make `errorHandlers` optional, and widen the React Router peer range to include v8.

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
