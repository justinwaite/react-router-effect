---
"react-router-effect": minor
---

The route factory now attaches its request metadata to the data of every loader, as it does for every action. The types of plain Effect loaders already included the optional `__meta` key, but the key was never there at runtime. Fixes #78.

The metadata API has new names, because it is no longer only for actions:

- The factory configuration `actionMeta` is now `routeMeta`.
- The `Register` key `actionMeta` is now `routeMeta`.
- `ActionMetaArgs` is now `RouteMetaArgs`, `WithActionMeta` is now `WithRouteMeta`, and `actionMetaKey` is now `routeMetaKey`.

The `makeLoader` wrapper now types its data with the metadata, as `makeAction` does. To migrate, rename `actionMeta` to `routeMeta` in the factory configuration and in `Register`.

The route metadata API is unstable, and a minor version can change it. The rest of the route factory stays stable.
