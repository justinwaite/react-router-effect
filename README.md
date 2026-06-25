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

Your own **domain errors** are mapped to one of those outcomes by handlers you register with
the factory. A handler _remaps_ an error by returning either:

- a library route error — `Respond.early(...)` / `Respond.throw(...)` / `Respond.redirect(...)`; or
- an `Effect` — `Effect.succeed(value)` to **recover** with `value`, or `Effect.fail(response)`
  to **throw** a `Response` / `DataWithResponseInit`.

Handling is **optional**:

- An **unregistered** error that implements [`HttpServerRespondable`](https://effect.website)
  is rendered automatically from its own response.
- Any other unregistered error falls through to a **500**.

## Usage

### 1. Configure the factory once

```ts
// app/route.server.ts
import { Data, Effect } from "effect";
import { makeLoaderOrActionFactory, Respond as baseRespond } from "react-router-effect";

class FormError extends Data.TaggedError("FormError")<{ reply: SubmissionResponse }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ message: string }> {}

export const { makeLoader, makeAction } = makeLoaderOrActionFactory({
  errorHandlers: {
    // recover: short-circuit and hand the reply to the component
    FormError: (error: FormError) => baseRespond.early({ reply: error.reply }),
    // throw: send to the error boundary
    BadInputError: (error: BadInputError) =>
      Effect.fail(new Response(error.message, { status: 400 })),
  },
});

// Extend Respond with app-specific helpers if you like:
export const Respond = {
  ...baseRespond,
  formError: (reply: SubmissionResponse) => new FormError({ reply }),
};
```

> **Annotate each handler's parameter.** The registered error set and the precise recover
> types are derived from the handler map's parameter and return types.

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

## API

- **`makeLoaderOrActionFactory({ errorHandlers })`** → `{ makeLoader, makeAction, makeLoaderOrAction }`
  (the three are the same wrapper under different names).
- **`Respond`** — `early` (recover), `throw`, `redirect`.
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
