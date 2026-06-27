# react-router-effect

Wrap [React Router](https://reactrouter.com) framework-mode loaders and actions with
[Effect](https://effect.website), and get **typed, declarative error handling** for free.

Write your loader/action as an `Effect`. When it short-circuits with a tagged error, the
library decides — based on handlers you register once — whether to **recover** (return data
the component reads via `useLoaderData`) or **throw** (send it to the error boundary or issue
a redirect). The resolved type of every loader/action reflects exactly what it can return.

```ts
const loader = makeLoader((args: Route.LoaderArgs) =>
  Effect.gen(function* () {
    const user = yield* getUser(args); // may fail with your domain errors
    if (!user.onboarded) {
      yield* Respond.redirect("/onboarding"); // throw → redirect
    }
    return { user };
  }),
);
// loader: (args) => Promise<{ user: User } /* | recovered shapes */>
```

## Install

```bash
vp add react-router-effect effect react-router
```

`effect` and `react-router` are peer dependencies.

## Concepts

A loader/action effect can short-circuit in three ways, via the `Respond` helpers:

| Helper                         | Outcome     | Where it lands                                      |
| ------------------------------ | ----------- | --------------------------------------------------- |
| `Respond.early(value, init?)`  | **recover** | resolves with `data(value, init)` → `useLoaderData` |
| `Respond.throw(value, init?)`  | **throw**   | rejects with `data(value, init)` → error boundary   |
| `Respond.redirect(url, init?)` | **throw**   | rejects with a redirect `Response`                  |

You declare your app's **domain errors** as a type argument to the factory, and may register a
handler per domain error. A handler _remaps_ an error by returning either:

- a library route error — `Respond.early(...)` / `Respond.throw(...)` / `Respond.redirect(...)`; or
- an `Effect` — `Effect.succeed(value)` to **recover** with `value`, or `Effect.fail(response)`
  to **throw** a `Response` / `DataWithResponseInit`.

A **declared domain error** may be left unhandled:

- if it implements [`HttpServerRespondable`](https://effect.website) it's rendered automatically
  from its own response;
- otherwise it falls through to a **500**.

**Any other error** a route consumes — a service-specific error that isn't a declared domain
error — **must be handled** in the loader/action (caught or mapped), or `makeLoader`/`makeAction`
fails to type-check with a message naming the unhandled error(s). This gives app-wide defaults for
declared errors while enforcing explicit handling of feature/service-specific ones. (Likewise, an
effect that requires a service neither the `runtime` nor the `requestContext` provides fails to
type-check with a message naming the missing service.)

## Usage

### 1. Configure the factory once

```ts
// app/route.server.ts
import { Data, Effect } from "effect";
import { makeLoaderOrActionFactory } from "react-router-effect";

class FormError extends Data.TaggedError("FormError")<{ reply: SubmissionResponse }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ message: string }> {}
class DbError extends Data.TaggedError("DbError")<{ query: string }> {}

// Declare every error your app handles app-wide. `DbError` has no handler below,
// so it falls through to the 500 default.
type DomainErrors = FormError | BadInputError | DbError;

// Curried: pin the domain errors, then the handler types are inferred. The config
// is a *builder* — it receives `Respond` (the library's `early`/`throw`/`redirect`)
// so your handlers can recover/throw, and the factory hands back a single `Respond`
// for your routes to import (no auto-import ambiguity with a library export).
export const { makeLoader, makeAction, Respond } = makeLoaderOrActionFactory<DomainErrors>()(
  (Respond) => ({
    // App-specific helpers — merged onto the returned `Respond` (base helpers win):
    respond: {
      formError: (reply: SubmissionResponse) => new FormError({ reply }),
    },
    errorHandlers: {
      // keys autocomplete to your domain-error tags; `error` is typed from its key.
      // recover: short-circuit and hand the reply to the component
      FormError: (error) => Respond.early({ reply: error.reply }),
      // throw: send to the error boundary
      BadInputError: (error) => Effect.fail(new Response(error.message, { status: 400 })),
    },
  }),
);
```

> **One `Respond`, no annotations.** Your routes import the `Respond` returned here — there's
> no library-level `Respond` to clash with it on auto-import. Handler keys autocomplete to your
> declared domain-error tags, each `error` parameter is typed from its key, and the precise
> recover types are derived from each handler's return.

### 2. Write loaders/actions as effects

```ts
// app/routes/profile.ts
import { Effect } from "effect";
import { makeLoader, Respond } from "../route.server.ts";
import type { Route } from "./+types/profile";

const loaderEffect = ({ params }: Route.LoaderArgs) =>
  Effect.gen(function* () {
    const profile = yield* getProfile(params.id); // may fail with FormError / BadInputError
    if (!profile.public) {
      yield* Respond.early({ restricted: true }); // recover with typed data
    }
    return { profile };
  });

export const loader = makeLoader((args: Route.LoaderArgs) => loaderEffect(args));
```

The resolved type is computed from the effect and your handlers:

```ts
type LoaderData = Route.ComponentProps["loaderData"];
// { profile: Profile } | DataWithResponseInit<{ restricted: boolean }>
//   ( BadInputError throws, so it never appears here )
```

### Self-rendering domain errors

If a domain error implements `HttpServerRespondable`, you don't need to register a handler —
it renders its own response:

```ts
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";

class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}
```

A registered handler, if present, still takes precedence over the error's own response.

### Providing services with a runtime

Pass a `runtime` (an effect [`ManagedRuntime`](https://effect.website)) and your loaders/actions
may require its services directly — no per-call `Effect.provide`. The runtime is built once and
reused for every request:

```ts
// app/runtime.server.ts
import { ManagedRuntime } from "effect";
export const appRuntime = ManagedRuntime.make(AppLayer); // provides Database, MyService, ...

// app/route.server.ts
export const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()(() => ({
  runtime: appRuntime,
  errorHandlers: { ... },
}));

// app/routes/profile.ts — `MyService` is satisfied by the runtime, not provided here:
const loader = makeLoader((args: Route.LoaderArgs) =>
  Effect.gen(function* () {
    const svc = yield* MyService;
    return { profile: yield* svc.load(args.params.id) };
  }),
);
```

The runtime's services become the effect's allowed requirement channel: requiring a service the
runtime provides type-checks, while requiring one it _doesn't_ is a compile error. With no
`runtime`, effects must require nothing.

`errorHandlers` is optional too — configure a factory with just a runtime, or with nothing:

```ts
makeLoaderOrActionFactory()(() => ({ runtime }));
makeLoaderOrActionFactory()(() => ({}));
```

### Per-request services from middleware

The runtime provides app-wide services. For **request-scoped** services — the current user, a
request id, a per-request transaction — use [middleware](https://reactrouter.com/how-to/middleware).
Middleware sets a fresh effect `Context` on a React Router context key each request; the factory's
`requestContext` reads it and provides those services to the loader/action:

```ts
// app/request-context.server.ts
import { Context } from "effect";
import { createContext } from "react-router";
import type { RequestContextKey } from "react-router-effect";

class RequestContext extends Context.Service<
  RequestContext,
  {
    readonly userId: string;
  }
>()("app/RequestContext") {}

// `requestContext` is a plain React Router context key — `createContext` is RR's own.
export const requestContext: RequestContextKey<RequestContext> = createContext();

// app/routes/profile.ts — middleware sets a fresh value per request:
export const middleware: Route.MiddlewareFunction[] = [
  ({ context, request }, next) => {
    context.set(requestContext, Context.make(RequestContext, { userId: readUser(request) }));
    return next();
  },
];

// app/route.server.ts — wire the same key into the factory:
export const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()(() => ({
  runtime: appRuntime,
  requestContext,
}));

// the loader requires RequestContext directly — no provide, fresh each request:
export const loader = makeLoader(() =>
  Effect.gen(function* () {
    const { userId } = yield* RequestContext;
    return { userId };
  }),
);
```

Effects may now require both the runtime's services and the request context's; requiring anything
else is a compile error. `RequestContextKey<ReqServices>` is a type alias for
`RouterContext<Context.Context<ReqServices>>` — sugar for annotating the key, nothing more.

## API

- **`makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({ errorHandlers?, runtime?, requestContext?, respond? }))`**
  → `{ makeLoader, makeAction, Respond }` (the two makers are the same wrapper). The config is a
  _builder_ that receives the base `Respond`; all its fields are optional. The returned `Respond` is
  the base helpers merged with your `respond` extensions (base helpers win). A non-domain error left
  in a loader/action's error channel — or a required service that neither the `runtime` nor the
  `requestContext` provides — is a compile error.
- **`RequestContextKey<ReqServices>`** — type of the React Router context key for a per-request
  effect context (`RouterContext<Context.Context<ReqServices>>`).
- **`Respond`** (returned from the factory) — `early` (recover), `throw`, `redirect`, plus any
  `respond` helpers you add.
- **`ReturnableDataError`**, **`ThrowableDataError`**, **`ThrowableRedirectError`** — the library
  route errors, and **`isRouteError`** to narrow them.
- **`ErrorHandler<Err>`** — the handler signature type.

## Development

```bash
vp install   # install dependencies
vp test      # run the test suite
vp check     # format, lint, type-check
vp pack      # build the library
```

## License

MIT
