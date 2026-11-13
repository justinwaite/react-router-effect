---
"react-router-effect": patch
---

An effect middleware's `next()` dies with a downstream crash, instead of failing with it as a `FailureResponse`. Before this fix, an `Error` from a later middleware of a resource route reached the effect middleware above it as a typed failure. The effect middleware then answered with the library's plain `500 Internal Server Error` response. React Router does not call `handleError` for a thrown `Response`, so the crash wrote no log, and the middleware spans ended without the error. Now the middleware rejects with the original error: React Router passes it to `handleError`, and the spans end with it. A downstream `Response` or `data(...)` still fails as before.
