import { Context, Data, Deferred, Effect, Layer, ManagedRuntime } from "effect";
import {
  RouterContextProvider,
  createContext,
  isRouteErrorResponse,
  type LoaderFunctionArgs,
} from "react-router";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  deferredFailureMessage,
  makeEffectRouteFactory,
  type DeferHandled,
  type RequestContextKey,
} from "../src/index.ts";

class Greeting extends Context.Service<Greeting, { readonly word: string }>()("test/Greeting") {
  static readonly layer = Layer.succeed(this, { word: "hello" });
}
class Visitor extends Context.Service<Visitor, { readonly name: string }>()("test/Visitor") {}

const runtime = ManagedRuntime.make(Greeting.layer);
afterAll(() => runtime.dispose());

const requestContext: RequestContextKey<Visitor> = createContext();
const { handlers, defer } = makeEffectRouteFactory()(() => ({ runtime, requestContext }));

/** Loader args with the request's services, and the controller that aborts the request. */
const makeArgs = () => {
  const controller = new AbortController();
  const context = new RouterContextProvider();
  context.set(requestContext, Context.make(Visitor, { name: "ada" }));
  const request = new Request("http://localhost/", { signal: controller.signal });
  return { controller, args: { request, context, params: {} } as unknown as LoaderFunctionArgs };
};

/** A promise that settles, as `<Await>` reads it. */
const settle = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe("defer", () => {
  it("returns before the deferred work finishes, with the loader's services", async () => {
    const latch = Deferred.makeUnsafe<void>();
    const loader = handlers.loader(
      Effect.fn("loader")(function* () {
        const now = "now";
        return {
          now,
          later: yield* defer(
            Effect.gen(function* () {
              yield* Deferred.await(latch);
              return `${(yield* Greeting).word}, ${(yield* Visitor).name}`;
            }),
          ),
        };
      }),
    );
    const { args } = makeArgs();
    const data = await loader(args);
    expect(data.now).toBe("now");
    Effect.runSync(Deferred.succeed(latch, undefined));
    await expect(data.later).resolves.toBe("hello, ada");
  });

  it("works at the end of a pipe", async () => {
    const loader = handlers.loader(() =>
      Effect.gen(function* () {
        return {
          later: yield* Effect.succeed(20).pipe(
            Effect.map((n) => n + 1),
            defer,
          ),
        };
      }),
    );
    const data = await loader(makeArgs().args);
    await expect(data.later).resolves.toBe(21);
  });

  it("interrupts the deferred work when the request aborts", async () => {
    let finalized = false;
    const started = Deferred.makeUnsafe<void>();
    const loader = handlers.loader(() =>
      Effect.gen(function* () {
        return {
          later: yield* defer(
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Effect.sync(() => (finalized = true))),
            ),
          ),
        };
      }),
    );
    const { args, controller } = makeArgs();
    const data = await loader(args);
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    const result = await settle(data.later);
    expect(finalized).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("rejects a defect with no server details", async () => {
    const loader = handlers.loader(() =>
      Effect.gen(function* () {
        return { later: yield* defer(Effect.die(new Error("db password is hunter2"))) };
      }),
    );
    const result = await settle((await loader(makeArgs().args)).later);
    expect(result.ok).toBe(false);
    const error = result.ok ? undefined : (result.error as Error);
    expect(error?.message).toBe(deferredFailureMessage);
    expect(error?.stack).toBeUndefined();
    expect(error?.cause).toBeUndefined();
  });

  it("interrupts the deferred work when the loader fails after deferring", async () => {
    let finalized = false;
    let promise: Promise<never> | undefined;
    const loader = handlers.loader(() =>
      Effect.gen(function* () {
        promise = yield* defer(
          Effect.never.pipe(Effect.ensuring(Effect.sync(() => (finalized = true)))),
        );
        // Lets the deferred fiber start, so its finalizer is registered.
        yield* Effect.yieldNow;
        return yield* Effect.die("loader broke");
      }),
    );
    await expect(loader(makeArgs().args)).rejects.toBeDefined();
    // Nobody reads `promise`: vitest fails the run on an unhandled rejection.
    expect(finalized).toBe(true);
    expect(promise).toBeDefined();
  });

  it("runs the deferred work in the loader's trace", async () => {
    const loader = handlers.loader(() =>
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        return {
          traceId: span.traceId,
          later: yield* defer(
            Effect.currentSpan.pipe(
              Effect.map((s) => s.traceId),
              Effect.orDie,
            ),
          ),
        };
      }).pipe(Effect.withSpan("loader"), Effect.orDie),
    );
    const data = await loader(makeArgs().args);
    await expect(data.later).resolves.toBe(data.traceId);
  });
});

// ---------------------------------------------------------------------------
// The factory's defer: deferred failures go through the error handlers.
// ---------------------------------------------------------------------------

class ReviewsDown extends Data.TaggedError("ReviewsDown")<{}> {}
class Forbidden extends Data.TaggedError("Forbidden")<{}> {}
class Teapot extends Data.TaggedError("Teapot")<{}> {}
class Fallback extends Data.TaggedError("Fallback")<{}> {}
class Moved extends Data.TaggedError("Moved")<{}> {}
class NoHandler extends Data.TaggedError("NoHandler")<{}> {}

type Domain = ReviewsDown | Forbidden | Teapot | Fallback | Moved | NoHandler;

const factory = makeEffectRouteFactory<Domain>()((Respond) => ({
  errorHandlers: {
    ReviewsDown: () => Respond.early({ reviews: "unavailable" }),
    Forbidden: () => Respond.throw({ reason: "no" }, 403),
    Teapot: () =>
      Effect.fail(
        new Response(JSON.stringify({ short: "stout" }), {
          status: 418,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    Fallback: () => Effect.succeed("fallback"),
    Moved: () => Respond.redirect("/elsewhere"),
  },
}));

/** Runs `work` deferred in a factory loader and settles its promise. */
const settleDeferred = async (work: Effect.Effect<unknown, DeferHandled<Domain>>) => {
  const loader = factory.handlers.loader(() =>
    Effect.gen(function* () {
      return { later: yield* factory.defer(work) };
    }),
  );
  return settle((await loader(makeArgs().args)).later);
};

describe("the factory's defer", () => {
  it("resolves with what a handler's Respond.early recovers", async () => {
    expect(await settleDeferred(new ReviewsDown())).toEqual({
      ok: true,
      value: { reviews: "unavailable" },
    });
  });

  it("resolves with what a handler's Effect.succeed recovers", async () => {
    expect(await settleDeferred(new Fallback())).toEqual({ ok: true, value: "fallback" });
  });

  it("resolves with a Respond.early raised directly", async () => {
    expect(await settleDeferred(factory.Respond.early(7))).toEqual({ ok: true, value: 7 });
  });

  it("rejects with an ErrorResponse for a handler's Respond.throw", async () => {
    const result = await settleDeferred(new Forbidden());
    const error = result.ok ? undefined : result.error;
    expect(isRouteErrorResponse(error)).toBe(true);
    expect(error).toMatchObject({ status: 403, data: { reason: "no" } });
  });

  it("rejects with an ErrorResponse for a Respond.throw raised directly", async () => {
    const result = await settleDeferred(factory.Respond.throw("bad", 400));
    expect(result.ok ? undefined : result.error).toMatchObject({ status: 400, data: "bad" });
  });

  it("rejects with an ErrorResponse that holds a failed Response's JSON body", async () => {
    const result = await settleDeferred(new Teapot());
    expect(result.ok ? undefined : result.error).toMatchObject({
      status: 418,
      data: { short: "stout" },
    });
  });

  it("rejects with no server details for a redirect or a domain error with no handler", async () => {
    for (const work of [new Moved(), new NoHandler()]) {
      const result = await settleDeferred(work);
      const error = result.ok ? undefined : (result.error as Error);
      expect(isRouteErrorResponse(error)).toBe(false);
      expect(error?.message).toBe(deferredFailureMessage);
    }
  });
});
