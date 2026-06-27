---
"react-router-effect": patch
---

Clearer type errors when a loader/action has an unhandled error or an unmet requirement.

Previously, leaving a non-domain error unhandled surfaced as the opaque **"Expected 2 arguments, but got 1"** (and a missing service requirement as an inscrutable "not assignable to `never`"). Both now report a readable message — and the offending types — right at the `makeLoader`/`makeAction` call:

- **Unhandled error** → _"This loader/action can fail with an error the library does not handle. Catch it in the effect (e.g. `Effect.catchTag`), make it Respondable, or add it to your `DomainError` union."_ with `unhandledErrors` naming the error tags.
- **Missing requirement** → _"This loader/action requires a service the factory does not provide. Add it to your runtime or requestContext, or handle it in the effect."_ with `missingRequirements` naming the service(s).

No API change: valid loaders/actions type-check exactly as before, and the enforcement semantics are identical — only the diagnostics improved.
