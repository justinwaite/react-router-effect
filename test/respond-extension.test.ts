import { Data } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, ReturnableDataError } from "../src/index.ts";

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}

describe("respond extension (runtime)", () => {
  it("returns the base helpers merged with custom ones", () => {
    const { Respond } = makeLoaderOrActionFactory()(() => ({
      respond: { formError: (reply: string) => new FormError({ reply }) },
    }));
    // the custom helper constructs the domain error
    expect(Respond.formError("oops")).toBeInstanceOf(FormError);
    expect(Respond.formError("oops").reply).toBe("oops");
    // the base helper is still there and behaves normally
    expect(Respond.early({ ok: true })).toBeInstanceOf(ReturnableDataError);
  });
});
