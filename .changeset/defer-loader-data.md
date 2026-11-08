---
"react-router-effect": minor
---

The route factory now returns `defer`, which is unstable. It starts an Effect without waiting for it, and gives a promise of the result for loader data. React Router streams the promise to `<Await>`. The deferred work gets the services and the span of the loader, and keeps running after the loader returns. An aborted request or a failed loader stops it.

The deferred Effect can fail only with the factory's domain errors, `Respond.early` and `Respond.throw`. The error handlers turn a failure into the promise's value or an `ErrorResponse` for `useAsyncError`. Any other failure rejects the promise with an error that has no server details, and the server logs the cause. An error that the factory does not handle does not compile. Fixes #77.
