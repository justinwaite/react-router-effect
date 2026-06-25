import { Data, Effect } from "effect";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

class BadInputError extends Data.TaggedError("BadInputError")<{ readonly message: string }> {}
/** A second domain error, declared but not registered with a handler. */
class OtherDomainError extends Data.TaggedError("OtherDomainError")<{ readonly code: string }> {}
/** An error that is NOT part of the declared domain errors. */
class NonDomainError extends Data.TaggedError("NonDomainError")<{ readonly x: number }> {}

type DomainErrors = BadInputError | OtherDomainError;

// ---------------------------------------------------------------------------
// A handler must be keyed by a declared domain error and remap to a library route
// error or an `Effect` failing with a response. Anything else is a compile error.
// ---------------------------------------------------------------------------

describe("factory handler validation", () => {
  it("accepts handlers that return a library route error", () => {
    const factory = makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        BadInputError: (error: BadInputError) => Respond.early({ message: error.message }),
      },
    });
    expectTypeOf(factory.makeLoader).toBeFunction();
    expectTypeOf(factory.makeAction).toBeFunction();
  });

  it("accepts handlers that return a failing Effect", () => {
    const factory = makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        BadInputError: (error: BadInputError) =>
          Effect.fail(new Response(error.message, { status: 400 })),
      },
    });
    expectTypeOf(factory.makeLoader).toBeFunction();
  });

  it("accepts a factory that registers no handler for a declared domain error", () => {
    // OtherDomainError is declared but unhandled — it'll fall through to the 500.
    const factory = makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        BadInputError: (error: BadInputError) => Respond.early({ message: error.message }),
      },
    });
    expectTypeOf(factory.makeLoader).toBeFunction();
  });

  it("rejects a handler that returns a bare (non-route-error) value", () => {
    // The invalid handler makes the factory's validation argument required, so the
    // call errors here (missing argument) rather than at the handler itself.
    // @ts-expect-error — 42 is neither a library route error nor a failing Effect.
    makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        BadInputError: (_error: BadInputError) => 42,
      },
    });
  });

  it("rejects a handler whose Effect fails with a non-response value", () => {
    // @ts-expect-error — Effect.fail("boom") rejects with a string, not a Response/Data.
    makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        BadInputError: (_error: BadInputError) => Effect.fail("boom"),
      },
    });
  });

  it("rejects a handler for an error that isn't a declared domain error", () => {
    // @ts-expect-error — NonDomainError isn't in DomainErrors, so it can't be registered.
    makeLoaderOrActionFactory<DomainErrors>()({
      errorHandlers: {
        NonDomainError: (error: NonDomainError) => Respond.throw({ x: error.x }),
      },
    });
  });
});
