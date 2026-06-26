---
"react-router-effect": minor
---

Return `Respond` from the factory and extend it via a `respond` option; the inner config is now a builder function.

The inner factory call takes a **builder** that receives the base `Respond` helpers (`early` / `throw` / `redirect`), so your `errorHandlers` can recover/throw with them — and the factory returns a single `Respond`: the base helpers merged with any `respond` extensions you add. This collapses `Respond` to one symbol per app, so your routes auto-import it with no ambiguity against a library export.

```ts
export const { makeLoader, makeAction, Respond } = makeLoaderOrActionFactory<DomainErrors>()(
  (Respond) => ({
    respond: { formError: (reply) => new FormError({ reply }) },
    errorHandlers: { FormError: (e) => Respond.early({ reply: e.reply }) },
  }),
);
```

**Breaking:** the top-level `Respond` value export is removed — destructure `Respond` from the factory return instead. The config-object form is replaced by the builder-function form: `makeLoaderOrActionFactory<E>()((Respond) => ({ ... }))`. The route-error classes, `isRouteError`, and all type exports (`AnyRouteError`, `ErrorHandler`, `RequestContextKey`) are unchanged.
