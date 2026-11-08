import { Data, Effect } from "effect";
import type { GetAnnotations, GetInfo } from "react-router/internal";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeEffectRouteFactory, type DeferredPromise } from "../src/index.ts";

/** A factory with no domain errors: its `defer` takes only effects that fail with `never`. */
const { defer } = makeEffectRouteFactory()(() => ({}));

class ReviewsDown extends Data.TaggedError("ReviewsDown")<{}> {}

declare const reviews: Effect.Effect<ReadonlyArray<{ readonly stars: number }>, ReviewsDown>;

class Forbidden extends Data.TaggedError("Forbidden")<{}> {}
class Undeclared extends Data.TaggedError("Undeclared")<{}> {}
const factory = makeEffectRouteFactory<ReviewsDown | Forbidden>()((Respond) => ({
  errorHandlers: {
    ReviewsDown: () => Respond.early({ fallback: true }),
    Forbidden: () => Respond.throw("no", 403),
  },
}));
type Reviews = ReadonlyArray<{ readonly stars: number }>;
declare const forbidden: Effect.Effect<Reviews, Forbidden>;
declare const early: Effect.Effect<Reviews, ReturnType<typeof factory.Respond.early<"cached">>>;
declare const undeclared: Effect.Effect<Reviews, Undeclared>;
declare const redirect: Effect.Effect<Reviews, ReturnType<typeof factory.Respond.redirect>>;

describe("defer", () => {
  it("gives a promise of the success type, and fails with never", () => {
    const deferred = defer(Effect.orDie(reviews));
    expectTypeOf(deferred).toEqualTypeOf<
      Effect.Effect<DeferredPromise<ReadonlyArray<{ readonly stars: number }>>, never, never>
    >();
  });

  it("infers at the end of a pipe", () => {
    const deferred = reviews.pipe(
      Effect.catchTag("ReviewsDown", () => Effect.succeed(null)),
      defer,
    );
    expectTypeOf(deferred).toEqualTypeOf<
      Effect.Effect<DeferredPromise<ReadonlyArray<{ readonly stars: number }> | null>, never, never>
    >();
  });

  it("rejects an effect that can still fail, and names the errors", () => {
    // @ts-expect-error ReviewsDown is not handled
    expectTypeOf(defer(reviews)).not.toBeNever();
    // @ts-expect-error ReviewsDown is not handled
    expectTypeOf(reviews.pipe(defer)).not.toBeNever();
  });

  it("streams to the component as a promise of the serialized data", () => {
    const loader = Effect.fn("loader")(function* () {
      return { now: 1, later: yield* defer(Effect.orDie(reviews)) };
    });
    type Module = { loader: typeof loader; default: () => null };
    type LoaderData = GetAnnotations<
      GetInfo<{ file: "x.tsx"; module: Module }> & {
        module: Module;
        matches: [{ id: "x"; module: Module }];
      }
    >["ComponentProps"]["loaderData"];
    expectTypeOf<LoaderData["now"]>().toEqualTypeOf<number>();
    expectTypeOf<LoaderData["later"]>().toEqualTypeOf<
      Promise<ReadonlyArray<{ readonly stars: number }>>
    >();
  });

  describe("the factory's defer", () => {
    it("adds what the handlers recover to the promise type", () => {
      expectTypeOf(factory.defer(reviews)).toEqualTypeOf<
        Effect.Effect<DeferredPromise<Reviews | { fallback: boolean }>, never, never>
      >();
    });

    it("adds nothing for a handler that throws", () => {
      expectTypeOf(factory.defer(forbidden)).toEqualTypeOf<
        Effect.Effect<DeferredPromise<Reviews>, never, never>
      >();
    });

    it("adds the value of a Respond.early raised directly", () => {
      expectTypeOf(factory.defer(early)).toEqualTypeOf<
        Effect.Effect<DeferredPromise<Reviews | "cached">, never, never>
      >();
    });

    it("rejects an undeclared error and a redirect", () => {
      // @ts-expect-error Undeclared is not a domain error of the factory
      expectTypeOf(factory.defer(undeclared)).not.toBeNever();
      // @ts-expect-error a redirect cannot happen after the response started
      expectTypeOf(factory.defer(redirect)).not.toBeNever();
    });
  });
});
