import { Data, Effect } from "effect";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

class BadInputError extends Data.TaggedError("BadInputError")<{ readonly message: string }> {}

// ---------------------------------------------------------------------------
// The factory only accepts handlers that remap to a library route error or to
// an `Effect` failing with a response. Anything else must be a compile error.
// ---------------------------------------------------------------------------

describe("factory handler validation", () => {
  it("accepts handlers that return a library route error", () => {
    const factory = makeLoaderOrActionFactory({
      errorHandlers: {
        BadInputError: (error: BadInputError) => Respond.early({ message: error.message }),
      },
    });
    expectTypeOf(factory.makeLoader).toBeFunction();
    expectTypeOf(factory.makeAction).toBeFunction();
  });

  it("accepts handlers that return a failing Effect", () => {
    const factory = makeLoaderOrActionFactory({
      errorHandlers: {
        BadInputError: (error: BadInputError) =>
          Effect.fail(new Response(error.message, { status: 400 })),
      },
    });
    expectTypeOf(factory.makeLoader).toBeFunction();
  });

  it("rejects a handler that returns a bare (non-route-error) value", () => {
    // The invalid handler makes the factory's validation argument required, so the
    // call errors here (missing argument) rather than at the handler itself.
    // @ts-expect-error — 42 is neither a library route error nor a failing Effect.
    makeLoaderOrActionFactory({
      errorHandlers: {
        BadInputError: (_error: BadInputError) => 42,
      },
    });
  });

  it("rejects a handler whose Effect fails with a non-response value", () => {
    // @ts-expect-error — Effect.fail("boom") rejects with a string, not a Response/Data.
    makeLoaderOrActionFactory({
      errorHandlers: {
        BadInputError: (_error: BadInputError) => Effect.fail("boom"),
      },
    });
  });
});
