import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import type { LoaderFunctionArgs } from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory } from "../src/index.ts";

// ---------------------------------------------------------------------------
// A runtime provides services to loader/action effects: an effect may require
// the runtime's services (no `Effect.provide`), but requiring a service the
// runtime does NOT provide must fail to type-check.
// ---------------------------------------------------------------------------

class InRuntime extends Context.Service<InRuntime>()("test/InRuntime", {
  make: Effect.succeed({ ping: (): Effect.Effect<string> => Effect.succeed("pong") }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

class NotInRuntime extends Context.Service<NotInRuntime>()("test/NotInRuntime", {
  make: Effect.succeed({ pong: (): Effect.Effect<number> => Effect.succeed(1) }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const runtime = ManagedRuntime.make(InRuntime.layer);

describe("a configured runtime satisfies an effect's required services", () => {
  const { makeLoader, makeAction, Respond } = makeLoaderOrActionFactory()(() => ({ runtime }));

  it("an effect requiring a runtime-provided service type-checks", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* InRuntime;
        return yield* svc.ping();
      }),
    );
    // Resolved value flows through unchanged (no errors, no recovers).
    expectTypeOf(loader).returns.resolves.toEqualTypeOf<string>();
  });

  it("makeAction satisfies runtime services the same way", () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* InRuntime;
        return yield* svc.ping();
      }),
    );
    expectTypeOf(action).returns.resolves.toEqualTypeOf<string>();
  });

  it("requiring a service the runtime does NOT provide fails to type-check", () => {
    // @ts-expect-error — NotInRuntime is not provided by the configured runtime,
    // so the effect's requirement channel is unsatisfied.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* NotInRuntime;
        return yield* svc.pong();
      }),
    );
  });

  it("runtime services compose with directly-raised recover types", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* InRuntime;
        yield* svc.ping();
        yield* Respond.early({ recovered: true });
        return 42;
      }),
    );
    // The success value and the Respond.early recover both surface.
    expectTypeOf(loader).returns.resolves.toMatchTypeOf<
      number | { readonly data: { recovered: boolean } }
    >();
  });
});

describe("without a runtime, effects must require nothing", () => {
  const { makeLoader } = makeLoaderOrActionFactory()(() => ({}));

  it("requiring any service fails to type-check", () => {
    // @ts-expect-error — no runtime is configured, so RServices is `never` and the
    // effect may not require InRuntime.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* InRuntime;
        return yield* svc.ping();
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// `errorHandlers` is optional.
// ---------------------------------------------------------------------------

describe("errorHandlers is optional", () => {
  class SomeDomainError extends Data.TaggedError("SomeDomainError")<{ readonly m: string }> {}

  it("an empty config produces makeLoader / makeAction", () => {
    const factory = makeLoaderOrActionFactory()(() => ({}));
    expectTypeOf(factory.makeLoader).toBeFunction();
    expectTypeOf(factory.makeAction).toBeFunction();
  });

  it("a runtime-only config (no errorHandlers) produces makeLoader / makeAction", () => {
    const factory = makeLoaderOrActionFactory()(() => ({ runtime }));
    expectTypeOf(factory.makeLoader).toBeFunction();
    expectTypeOf(factory.makeAction).toBeFunction();
  });

  it("declared domain errors with no errorHandlers still type-check", () => {
    const { makeLoader } = makeLoaderOrActionFactory<SomeDomainError>()(() => ({}));
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        // No handler registered, but it's a declared domain error → flows to 500.
        yield* new SomeDomainError({ m: "boom" });
        return true;
      }),
    );
    expectTypeOf(loader).toBeFunction();
  });
});
