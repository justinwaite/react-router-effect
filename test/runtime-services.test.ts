import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import type { LoaderFunctionArgs } from "react-router";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, Respond } from "../src/index.ts";

// ---------------------------------------------------------------------------
// A small app runtime: a `Database` and a `Greeter` that depends on it. The
// factory is given this runtime so loader/action effects can require these
// services WITHOUT providing layers themselves.
// ---------------------------------------------------------------------------

/** Counts how many times the layer is built — proves the runtime builds once. */
let databaseBuilds = 0;

class Database extends Context.Service<Database>()("test/Database", {
  make: Effect.sync(() => {
    databaseBuilds += 1;
    return {
      query: (sql: string) => Effect.succeed(`rows for [${sql}]`),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

class Greeter extends Context.Service<Greeter>()("test/Greeter", {
  make: Effect.gen(function* () {
    const db = yield* Database;
    return {
      greet: (name: string) =>
        Effect.gen(function* () {
          const rows = yield* db.query(`select * from greetings where name = '${name}'`);
          return `Hello, ${name}! (${rows})`;
        }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

// Provide `Database` to `Greeter`, and keep both in the runtime's services so a
// loader may require either directly.
const AppLayer = Greeter.layer.pipe(Layer.provideMerge(Database.layer));
const runtime = ManagedRuntime.make(AppLayer);

afterAll(() => runtime.dispose());

const args = {} as LoaderFunctionArgs;

async function settle<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}

// ---------------------------------------------------------------------------
// Runtime-provided services.
// ---------------------------------------------------------------------------

describe("makeLoader / makeAction with a runtime", () => {
  // No domain errors, no handlers — just a runtime. Exercises the optional
  // `errorHandlers` path too.
  const { makeLoader, makeAction } = makeLoaderOrActionFactory()({ runtime });

  it("resolves an effect that requires a runtime service (no provide)", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        return yield* greeter.greet("world");
      }),
    );
    await expect(loader(args)).resolves.toBe(
      "Hello, world! (rows for [select * from greetings where name = 'world'])",
    );
  });

  it("resolves an effect that requires a transitive service directly", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.query("select 1");
      }),
    );
    await expect(loader(args)).resolves.toBe("rows for [select 1]");
  });

  it("builds the runtime's layer once across many runs", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        return yield* greeter.greet("again");
      }),
    );
    await loader(args);
    await loader(args);
    await loader(args);
    // The Database layer was constructed a single time and cached by the runtime.
    expect(databaseBuilds).toBe(1);
  });

  it("still recovers a directly-raised Respond.early while using a service", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        yield* greeter.greet("ignored");
        yield* Respond.early({ message: "short-circuit" });
        return "unreachable";
      }),
    );
    await expect(loader(args)).resolves.toMatchObject({
      type: "DataWithResponseInit",
      data: { message: "short-circuit" },
    });
  });

  it("makeAction also runs against the runtime", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        return yield* greeter.greet("action");
      }),
    );
    await expect(action(args)).resolves.toBe(
      "Hello, action! (rows for [select * from greetings where name = 'action'])",
    );
  });
});

describe("runtime + registered domain-error handlers compose", () => {
  class GreetError extends Data.TaggedError("GreetError")<{ readonly reason: string }> {}

  const { makeLoader } = makeLoaderOrActionFactory<GreetError>()({
    runtime,
    errorHandlers: {
      GreetError: (error: GreetError) => Respond.early({ failed: error.reason }),
    },
  });

  it("runs the service then recovers a registered domain error via the runtime", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const greeter = yield* Greeter;
        yield* greeter.greet("x");
        yield* new GreetError({ reason: "nope" });
        return "unreachable";
      }),
    );
    await expect(loader(args)).resolves.toMatchObject({
      type: "DataWithResponseInit",
      data: { failed: "nope" },
    });
  });
});

// ---------------------------------------------------------------------------
// Optional `errorHandlers`.
// ---------------------------------------------------------------------------

describe("errorHandlers is optional", () => {
  it("a factory configured with an empty config still works", async () => {
    const { makeLoader } = makeLoaderOrActionFactory()({});
    const loader = makeLoader((_a: LoaderFunctionArgs) => Effect.succeed(123));
    await expect(loader(args)).resolves.toBe(123);
  });

  it("an unhandled non-domain error falls through to a 500 with no handlers", async () => {
    class SomeError extends Data.TaggedError("SomeError")<{}> {}
    const { makeLoader } = makeLoaderOrActionFactory()({});
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      // No domain errors are declared, so this must be handled inline; mapping it
      // to a library route error (throw) keeps it type-correct and exercises the
      // missing-handlers runtime path.
      Effect.gen(function* () {
        yield* new SomeError();
        return true;
      }).pipe(Effect.catchTag("SomeError", () => Effect.fail(Respond.throw({ boom: true }, 500)))),
    );
    const result = await settle(loader(args));
    expect(result.ok).toBe(false);
  });
});
