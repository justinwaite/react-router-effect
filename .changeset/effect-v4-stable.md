---
"react-router-effect": major
---

The library now targets the stable Effect 4 release. The `effect` peer dependency range changes from `^4.0.0-beta.107` to `^4.0.0`. The library imports the HTTP modules from `effect/http` instead of `effect/unstable/http`, and the Effect 4.0.0 beta releases do not have that path. If you use an Effect 4.0.0 beta, upgrade to `effect@^4.0.0` before you upgrade this package. In your own code, change `effect/unstable/http` imports to `effect/http`.
