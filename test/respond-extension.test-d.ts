import { Data, Effect } from "effect";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory } from "../src/index.ts";

// ---------------------------------------------------------------------------
// The inner config is a *builder* that receives the base `Respond` (so handlers
// can recover/throw), and the factory returns a single `Respond` — the base
// helpers merged with any `respond` extensions, typed precisely.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
type DomainErrors = FormError;

describe("the factory's returned Respond", () => {
  it("carries the base helpers", () => {
    const { Respond } = makeLoaderOrActionFactory<DomainErrors>()(() => ({}));
    expectTypeOf(Respond.early).toBeFunction();
    expectTypeOf(Respond.throw).toBeFunction();
    expectTypeOf(Respond.redirect).toBeFunction();
  });

  it("merges in `respond` extensions with their precise types", () => {
    const { Respond } = makeLoaderOrActionFactory<DomainErrors>()(() => ({
      respond: {
        formError: (reply: string) => new FormError({ reply }),
      },
    }));
    expectTypeOf(Respond.formError).toEqualTypeOf<(reply: string) => FormError>();
    // base helpers remain available alongside the extension
    expectTypeOf(Respond.early).toBeFunction();
  });

  it("hands the base Respond to the builder for use in errorHandlers", () => {
    const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
      errorHandlers: { FormError: (error) => Respond.early({ reply: error.reply }) },
    }));
    expectTypeOf(makeLoader).toBeFunction();
  });

  it("an extension helper's domain error is recoverable end-to-end", () => {
    const { makeLoader, Respond } = makeLoaderOrActionFactory<DomainErrors>()((respond) => ({
      respond: { formError: (reply: string) => new FormError({ reply }) },
      errorHandlers: { FormError: (error) => respond.early({ reply: error.reply }) },
    }));
    const loader = makeLoader(() =>
      Effect.gen(function* () {
        yield* Respond.formError("invalid");
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });
});
