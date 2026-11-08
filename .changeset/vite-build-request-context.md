---
"react-router-effect": patch
---

`ReactRouterVite.layer` builds a new `App` without the services of the request that starts the build. Before, an `App` that keeps its build's services, such as an `HttpApiBuilder` group, saw that first request's `HttpServerRequest` on every later request after an edit.
