---
"react-router-effect": major
---

Add `makeMiddleware`, wrapping a React Router `Route.MiddlewareFunction` as an `Effect` with the same recover/throw/redirect handling as `makeLoader`/`makeAction`. Its `next` is handed to the effect as `() => Effect.Effect<Result, FailureResponse>` — call it with `yield*` to run the rest of the chain; a downstream throw (e.g. a nested loader's redirect) surfaces as a typed failure instead of a rejected promise, and is re-thrown as-is rather than becoming a 500.

**Breaking:** the factory is renamed from `makeLoaderOrActionFactory` to `makeEffectRouteFactory`, now that it also builds `makeMiddleware`. It still returns `{ makeLoader, makeAction, Respond }`, with `makeMiddleware` added.

```ts
export const { makeLoader, makeAction, makeMiddleware, Respond } =
  makeEffectRouteFactory<DomainErrors>()((Respond) => ({ errorHandlers: { ... } }));

export const middleware: Route.MiddlewareFunction[] = [
  makeMiddleware<Route.MiddlewareFunction>(({ request }, next) =>
    Effect.gen(function* () {
      const user = yield* getUser(request); // may fail with a declared domain error
      if (!user) yield* Respond.redirect("/login");
      return yield* next();
    }),
  ),
];
```
