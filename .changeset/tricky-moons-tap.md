---
"react-router-effect": patch
---

Fix `makeMiddleware` rejecting handled errors when pinned to a route's middleware type.

Passing `Route.MiddlewareFunction` as a type argument makes the call fully explicit —
TypeScript has no partial type-argument inference — so the effect's error and requirement
channels defaulted to `never` and every failure was reported as unassignable, including
domain errors the `errorHandlers` remap and the failure `next()` itself produces. They now
default to what the library handles and the factory provides, so a pinned middleware admits
the same effects an unpinned one (or a `makeLoader`/`makeAction` call) does, and still
rejects unhandled errors and unprovided services.

The wrapper is also typed as the route's own middleware now — `(args, next) =>
Promise<Result | undefined>` — so it assigns to `Route.MiddlewareFunction[]` directly.
