# react-router-effect

## 0.2.0

### Minor Changes

- [#3](https://github.com/justinwaite/react-router-effect/pull/3) [`250092f`](https://github.com/justinwaite/react-router-effect/commit/250092fd2e0f33b9b1b81eee6f6a7f69fd56324b) Thanks [@justinwaite](https://github.com/justinwaite)! - Enforce handling of non-domain errors at the type level.

  `makeLoaderOrActionFactory` now takes the app's domain errors as a type argument and is curried so the handler types are still inferred:

  ```ts
  const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
    errorHandlers: { ... },
  });
  ```

  Declared domain errors may be left unhandled (handled by a registered handler, rendered via `HttpServerRespondable`, or fall through to the 500 default). Any **non-domain** error a route consumes — e.g. a service-specific failure — must now be handled in the loader/action, or `makeLoader`/`makeAction` fails to type-check. This gives app-wide default handling for declared errors while enforcing explicit handling of feature/service-specific ones.

  **Breaking:** the factory is now called as `makeLoaderOrActionFactory<DomainErrors>()({ errorHandlers })` (note the extra `()`), registered handlers must be keyed by a declared domain error, and the factory now returns only `{ makeLoader, makeAction }` (the redundant `makeLoaderOrAction` alias was removed).
