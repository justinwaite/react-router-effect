---
"react-router-effect": patch
---

Under the Vite dev server, the adapter now attaches `actionMeta` to a `data(...)` that the app builds. The app and the adapter can load different copies of React Router there. The adapter now finds a `data(...)` wrapper by its shape, as React Router does, and not by its class. A record with the fields `type: "DataWithResponseInit"`, `data` and `init` now gets the metadata on `data`, because React Router sends only that field. Fixes #79.
