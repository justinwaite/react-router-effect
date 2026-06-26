import { Data, Effect } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import {
  useActionData,
  useLoaderData,
  type LoaderFunctionArgs,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
} from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

// ---------------------------------------------------------------------------
// What a *component* actually reads. `useLoaderData<typeof loader>()` returns
// `SerializeFrom<typeof loader>`, which strips `DataWithResponseInit<U>` down to
// its serialized body `U`. These aliases assert exactly that component-facing
// type — the data that comes out of a loader/action — not just the raw Promise.
// ---------------------------------------------------------------------------

/** The type a component receives from `useLoaderData<typeof loader>()`. */
type LoaderData<L> = ReturnType<typeof useLoaderData<L>>;
/** The type a component receives from `useActionData<typeof action>()` (pre-submit `undefined`). */
type ActionData<A> = ReturnType<typeof useActionData<A>>;

// ---------------------------------------------------------------------------
// Fixtures: a representative factory exercising every handler-return shape.
// ---------------------------------------------------------------------------

class BadInputError extends Data.TaggedError("BadInputError")<{ readonly message: string }> {}
class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class RecoverableError extends Data.TaggedError("RecoverableError")<{
  readonly fallback: number;
}> {}
class GoAwayError extends Data.TaggedError("GoAwayError")<{}> {}

class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}

type DomainErrors = BadInputError | FormError | RecoverableError | GoAwayError;

// Handler params are intentionally un-annotated — they're typed contextually from
// their key — yet the recover types below stay precise.
const { makeLoader, makeAction } = makeLoaderOrActionFactory<DomainErrors>()({
  errorHandlers: {
    // throw → contributes nothing to the resolved data
    BadInputError: (error) => Effect.fail(new Response(error.message, { status: 400 })),
    // recover → { reply: string }
    FormError: (error) => Respond.early({ reply: error.reply }),
    // recover → { recovered: number }
    RecoverableError: (error) => Effect.succeed({ recovered: error.fallback }),
    // throw → contributes nothing
    GoAwayError: (_error) => Respond.throw({ message: "go away" }),
  },
});

const empty = makeLoaderOrActionFactory()({ errorHandlers: {} });

// ---------------------------------------------------------------------------
// loaderData = the effect's own success ∪ directly-recovered bodies ∪ the
// recoveries of registered handlers whose error can actually occur — with every
// `DataWithResponseInit<U>` unwrapped to `U`.
// ---------------------------------------------------------------------------

describe("loaderData — success & direct route errors", () => {
  it("a pure-success loader yields exactly the success value", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) => Effect.succeed(42));
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<number>();
  });

  it("a directly-raised Respond.early surfaces as its unwrapped body", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ message: "missing foo" });
        return true;
      }),
    );
    // Raw library return still carries the DataWithResponseInit wrapper...
    expectTypeOf(loader).returns.resolves.toEqualTypeOf<
      boolean | DataWithResponseInit<{ message: string }>
    >();
    // ...but the component reads the unwrapped body.
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean | { message: string }>();
  });

  it("a directly-raised Respond.throw does NOT appear in loaderData", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.throw({ boom: true });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean>();
  });

  it("a directly-raised Respond.redirect does NOT appear in loaderData", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.redirect("/login");
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean>();
  });

  it("multiple directly-raised Respond.early bodies union in loaderData", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ a: 1 });
        yield* Respond.early({ b: 2 });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<
      boolean | { a: number } | { b: number }
    >();
  });
});

describe("loaderData — registered handlers", () => {
  it("a handler returning Respond.early recovers as its unwrapped body", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "invalid" });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean | { reply: string }>();
  });

  it("a handler returning Effect.succeed recovers as the success value", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new RecoverableError({ fallback: 7 });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean | { recovered: number }>();
  });

  it("a handler returning Effect.fail (throw) does NOT appear in loaderData", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new BadInputError({ message: "nope" });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean>();
  });

  it("a handler returning Respond.throw does NOT appear in loaderData", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new GoAwayError();
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean>();
  });

  it("only recoveries for errors that can actually occur are included", () => {
    // The factory registers four handlers, but this loader can only raise
    // FormError — so RecoverableError's `{ recovered: number }` must NOT appear.
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "invalid" });
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean | { reply: string }>();
    expectTypeOf<LoaderData<typeof loader>>().not.toEqualTypeOf<
      boolean | { reply: string } | { recovered: number }
    >();
  });
});

describe("loaderData — combinations & aliases", () => {
  it("combines direct recover, handler recover, and a literal success", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* Respond.early({ direct: true });
        yield* new FormError({ reply: "invalid" });
        yield* new RecoverableError({ fallback: 1 });
        return 1 as const;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<
      1 | { direct: boolean } | { reply: string } | { recovered: number }
    >();
  });

  it("an unhandled respondable error is thrown, never recovered (no widening)", () => {
    const loader = empty.makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return true;
      }),
    );
    expectTypeOf<LoaderData<typeof loader>>().toEqualTypeOf<boolean>();
  });
});

// ---------------------------------------------------------------------------
// actionData mirrors loaderData, with the `| undefined` a component sees before
// the action has run.
// ---------------------------------------------------------------------------

describe("actionData", () => {
  it("yields the success value (with pre-submit undefined)", () => {
    const action = makeAction((_a: LoaderFunctionArgs) => Effect.succeed({ created: true }));
    expectTypeOf<ActionData<typeof action>>().toEqualTypeOf<{ created: boolean } | undefined>();
  });

  it("recovers a handler's Respond.early as its unwrapped body", () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new FormError({ reply: "invalid" });
        return true;
      }),
    );
    expectTypeOf<ActionData<typeof action>>().toEqualTypeOf<
      boolean | { reply: string } | undefined
    >();
  });

  it("does not surface thrown handler outcomes", () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* new BadInputError({ message: "nope" });
        return true;
      }),
    );
    expectTypeOf<ActionData<typeof action>>().toEqualTypeOf<boolean | undefined>();
  });
});
