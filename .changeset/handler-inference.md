---
"react-router-effect": minor
---

Type-safe `errorHandlers`: autocompleting keys and inferred `error` parameters.

Handler keys now autocomplete to your declared domain-error tags, and each handler's `error` parameter is typed from its key — no annotation needed:

```ts
makeLoaderOrActionFactory<DomainErrors>()({
  errorHandlers: {
    // key autocompletes to a domain-error tag; `error` is MyDomainError automatically
    MyDomainError: (error) => Effect.fail(new Response(error.message, { status: 400 })),
  },
});
```

A handler keyed by an unknown tag, or returning something other than a library route error / failing `Effect`, is now a compile error reported **on that handler** (previously it surfaced on the factory call). Precise recover types are still derived from each handler's return.

Existing code that annotated handler parameters keeps working — the annotations are now redundant.
