import { Data, Effect } from "effect";
import type { LoaderFunctionArgs } from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory } from "../src/index.ts";

// ---------------------------------------------------------------------------
// `errorHandlers` keys are constrained to the domain-error tags (so they
// autocomplete), and each handler's `error` parameter is typed from its key —
// no annotation needed. (Precise recover types from un-annotated handlers are
// covered comprehensively in loader-action-data.test-d.ts.)
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class BadInputError extends Data.TaggedError("BadInputError")<{ readonly code: number }> {}
type DomainErrors = FormError | BadInputError;

describe("handler params are inferred from their key", () => {
  it("types each error param without an annotation", () => {
    makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
      errorHandlers: {
        FormError: (error) => {
          expectTypeOf(error).toEqualTypeOf<FormError>();
          return Respond.early({ reply: error.reply });
        },
        BadInputError: (error) => {
          expectTypeOf(error).toEqualTypeOf<BadInputError>();
          return Effect.succeed({ doubled: error.code * 2 });
        },
      },
    }));
  });

  it("rejects a handler keyed by a non-domain tag", () => {
    makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
      errorHandlers: {
        // @ts-expect-error — NotADomainError is not one of the domain-error tags.
        NotADomainError: (_error) => Respond.early({ x: 1 }),
      },
    }));
  });

  it("a loader arg is unaffected — only the handler params are inferred here", () => {
    const { makeLoader } = makeLoaderOrActionFactory<DomainErrors>()((Respond) => ({
      errorHandlers: { FormError: (error) => Respond.early({ reply: error.reply }) },
    }));
    const loader = makeLoader((_a: LoaderFunctionArgs) => Effect.succeed(1));
    expectTypeOf(loader).toBeFunction();
  });
});
