import { Data, Effect } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import type { LoaderFunctionArgs } from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

// ---------------------------------------------------------------------------
// The factory's contract: app-wide *declared domain errors* may be left to the
// library (handled, or fall through to the 500 / auto-respond default), but any
// *non-domain* error a route consumes (e.g. a service-specific failure) MUST be
// handled in the loader/action — otherwise `makeLoader`/`makeAction` won't type.
// ---------------------------------------------------------------------------

/** Declared, registered domain error. */
class MyDomainError extends Data.TaggedError("MyDomainError")<{ readonly message: string }> {}
/** Declared domain error with NO registered handler → flows to the 500 default. */
class DbError extends Data.TaggedError("DbError")<{ readonly query: string }> {}
/** Declared domain error that renders itself via HttpServerRespondable. */
class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}

type DomainErrors = MyDomainError | DbError | NotAuthorizedError;

/** A service-specific error a single route consumes — NOT a declared domain error. */
class FooServiceError extends Data.TaggedError("FooServiceError")<{ readonly reason: number }> {}

const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
  errorHandlers: {
    MyDomainError: (error: MyDomainError) =>
      Effect.fail(new Response(error.message, { status: 400 })),
    // DbError and NotAuthorizedError intentionally have no handler.
  },
});

describe("declared domain errors need no handling in the loader/action", () => {
  it("a registered domain error type-checks", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new MyDomainError({ message: "boom" });
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });

  it("a declared domain error with no handler type-checks (it flows to the 500)", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new DbError({ query: "select 1" });
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });

  it("a respondable domain error with no handler type-checks", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });

  it("library route errors raised directly need no handling", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.redirect("/login");
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });
});

describe("non-domain errors MUST be handled in the loader/action", () => {
  it("leaving a service error unhandled fails to type-check", () => {
    // @ts-expect-error — FooServiceError isn't a declared domain error, a library
    // route error, or respondable, so makeLoader requires it to be handled first.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return true;
      }),
    );
  });

  it("the same is enforced for makeAction", () => {
    // @ts-expect-error — FooServiceError must be handled before makeAction accepts it.
    makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return true;
      }),
    );
  });

  it("a service error mixed in with domain errors still forces handling", () => {
    // @ts-expect-error — DbError is fine, but FooServiceError still must be handled.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new DbError({ query: "select 1" });
        yield* new FooServiceError({ reason: 1 });
        return true;
      }),
    );
  });

  it("handling the service error by recovering makes it type-check", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return true;
      }).pipe(Effect.catchTag("FooServiceError", () => Effect.succeed(false))),
    );
    expectTypeOf(loader).toBeFunction();
  });

  it("handling it by mapping to a library route error makes it type-check", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return true;
      }).pipe(
        Effect.catchTag("FooServiceError", (error) =>
          Effect.fail(Respond.throw({ reason: error.reason }, 422)),
        ),
      ),
    );
    expectTypeOf(loader).toBeFunction();
  });

  it("handling it by mapping to a declared domain error makes it type-check", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return true;
      }).pipe(
        Effect.catchTag("FooServiceError", (error) =>
          Effect.fail(new DbError({ query: String(error.reason) })),
        ),
      ),
    );
    expectTypeOf(loader).toBeFunction();
  });
});
