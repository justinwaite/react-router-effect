import { Context, Data, Effect } from "effect";
import {
  data,
  useFetcher,
  useLoaderData,
  type RouterContextProvider,
  type UNSAFE_DataWithResponseInit as DataWithResponseInit,
} from "react-router";
import type { GetAnnotations, GetInfo } from "react-router/internal";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeEffectRouteFactory, type RouteData } from "../src/index.ts";
import type { RouteEffectCheck, RouteEffectFailures } from "../src/check.ts";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

class FormError extends Data.TaggedError("FormError")<{ readonly reply: string }> {}
class PlaidError extends Data.TaggedError("PlaidError")<{}> {}
class Database extends Context.Service<Database, { readonly query: string }>()("test/Database") {}
class Unprovided extends Context.Service<Unprovided, { readonly x: 1 }>()("test/Unprovided") {}

declare module "../src/route-data.ts" {
  interface Register {
    recover: { FormError: { reply: string } };
    actionMeta: { readonly requestId: string };
  }
}

/** Route args as React Router's typegen gives them. */
type LoaderArgs = {
  request: Request;
  url: URL;
  params: { id: string };
  pattern: string;
  context: Readonly<RouterContextProvider>;
};

declare const runtime: import("effect").ManagedRuntime.ManagedRuntime<Database, never>;

const routeFactory = makeEffectRouteFactory<FormError>()((Respond) => ({
  runtime,
  errorHandlers: { FormError: (error) => Respond.early({ reply: error.reply }) },
  actionMeta: () => ({ requestId: "r" }),
}));

const zeroArg = Effect.fn("zeroArg")(function* () {
  if (Math.random() > 2) return yield* new FormError({ reply: "x" });
  return { when: new Date(), name: "a" };
});
const withArgs = Effect.fn("withArgs")(({ params }: LoaderArgs) =>
  Effect.succeed({ id: params.id }),
);
const withData = Effect.fn("withData")(() => Effect.succeed(data({ ok: true as const }, 201)));
const responseOrData = Effect.fn("responseOrData")(() =>
  Effect.succeed(Math.random() > 1 ? new Response("") : { a: 1 }),
);
const recoversOnly = Effect.fn("recoversOnly")(function* () {
  return yield* routeFactory.Respond.early({ reply: "early" });
});

/** A route module type, as `typeof import(...)` gives it. */
type Module = { loader: typeof zeroArg; action: typeof withArgs; default: () => null };
type Annotations = GetAnnotations<
  GetInfo<{ file: "x.tsx"; module: Module }> & {
    module: Module;
    matches: [{ id: "x"; module: Module }];
  }
>;

// ---------------------------------------------------------------------------
// Route data.
// ---------------------------------------------------------------------------

describe("route data of plain Effect loaders", () => {
  it("types Route.ComponentProps with the success and the registered recover data", () => {
    expectTypeOf<Annotations["ComponentProps"]["loaderData"]>().toEqualTypeOf<
      | ({ when: Date; name: string } & { __meta?: { readonly requestId: string } })
      | ({ reply: string } & { __meta?: { readonly requestId: string } })
    >();
  });

  it("types React Router's hooks for a zero-argument loader", () => {
    expectTypeOf(useLoaderData<typeof zeroArg>()).toEqualTypeOf<
      | ({ when: Date; name: string } & { __meta?: { readonly requestId: string } })
      | ({ reply: string } & { __meta?: { readonly requestId: string } })
    >();
  });

  it("types React Router's hooks for a loader that takes args through RouteData", () => {
    expectTypeOf(useFetcher<RouteData<typeof withArgs>>().data).toEqualTypeOf<
      ({ id: string } & { __meta?: { readonly requestId: string } }) | undefined
    >();
  });

  it("unwraps data(), drops a Response, and keeps recover-only data", () => {
    expectTypeOf<RouteData<typeof withData>>().toEqualTypeOf<
      { ok: true } & { __meta?: { readonly requestId: string } }
    >();
    expectTypeOf<RouteData<typeof responseOrData>>().toEqualTypeOf<
      { a: number } & { __meta?: { readonly requestId: string } }
    >();
    expectTypeOf<RouteData<typeof recoversOnly>>().toEqualTypeOf<
      { reply: string } & { __meta?: { readonly requestId: string } }
    >();
  });

  it("leaves non-Effect functions to React Router", () => {
    const plain = (args: LoaderArgs) => Promise.resolve({ plain: args.params.id });
    expectTypeOf<RouteData<typeof plain>>().toEqualTypeOf<typeof plain>();
  });
});

// ---------------------------------------------------------------------------
// The brand keeps Effect's assignability.
// ---------------------------------------------------------------------------

/** An interface that extends Effect, as drizzle's query builders do. */
interface Query<Row> extends Effect.Effect<Row[], PlaidError> {
  readonly table: string;
}

describe("the serialization brand", () => {
  it("keeps a void target accepting any success", () => {
    expectTypeOf(Effect.succeed(true)).toExtend<Effect.Effect<void>>();
  });

  it("keeps an interface that extends Effect assignable to a wider Effect", () => {
    expectTypeOf<Query<{ id: string }>>().toExtend<Effect.Effect<unknown[], PlaidError>>();
    expectTypeOf<Query<{ id: string }>>().toExtend<Effect.Effect<unknown, unknown>>();
  });

  it("keeps yieldable errors assignable to Effect", () => {
    expectTypeOf(new FormError({ reply: "" })).toExtend<Effect.Effect<never, FormError>>();
  });

  it("keeps Effect.fn with pipeables, which intersects Effect<A, E> and Effect<A, any, any>", () => {
    const piped = Effect.fn("piped")(
      function* () {
        if (Math.random() > 2) return yield* new PlaidError();
        return yield* Effect.succeed({ value: 1 });
      },
      Effect.catchTag("PlaidError", () => Effect.succeed({ value: 0 })),
    );
    expectTypeOf(piped()).toExtend<Effect.Effect<{ value: number }>>();
  });
});

// ---------------------------------------------------------------------------
// The route check.
// ---------------------------------------------------------------------------

const handled = Effect.fn("handled")(function* () {
  yield* Database;
  if (Math.random() > 2) yield* new FormError({ reply: "x" });
  return { ok: true };
});
const unhandled = Effect.fn("unhandled")(function* () {
  return yield* new PlaidError();
});
const missing = Effect.fn("missing")(function* () {
  return (yield* Unprovided).x;
});
const badMiddleware = Effect.fn("badMiddleware")(() => Effect.succeed("not a response"));

describe("RouteEffectCheck", () => {
  it("is empty when every Effect is handled and promise routes are skipped", () => {
    type Modules = {
      "routes/ok": { loader: typeof handled; action: (args: LoaderArgs) => Promise<number> };
    };
    expectTypeOf<RouteEffectFailures<typeof routeFactory, Modules>>().toBeNever();
    expectTypeOf<RouteEffectCheck<typeof routeFactory, Modules>>().toEqualTypeOf<{}>();
  });

  it("names each failure in a property that says what to fix", () => {
    type Modules = {
      "routes/billing": { loader: typeof unhandled; action: typeof missing };
      "routes/admin": { middleware: [typeof badMiddleware] };
    };
    expectTypeOf<keyof RouteEffectCheck<typeof routeFactory, Modules>>().toEqualTypeOf<
      | "routes/billing#loader must handle PlaidError"
      | "routes/billing#action needs a provider for test/Unprovided"
      | "routes/admin#middleware must succeed with a Response or nothing"
    >();
  });

  it("names each route, export, unhandled error and missing service", () => {
    type Modules = {
      "routes/ok": { loader: typeof handled };
      "routes/billing": { loader: typeof unhandled; action: typeof missing };
      "routes/admin": { middleware: [typeof badMiddleware] };
    };
    type Failures = RouteEffectFailures<typeof routeFactory, Modules>;
    expectTypeOf<
      Extract<Failures, { route: "routes/billing"; export: "loader" }>["unhandledErrors"]
    >().toEqualTypeOf<"PlaidError">();
    expectTypeOf<
      Extract<Failures, { route: "routes/billing"; export: "action" }>["missingServices"]
    >().toEqualTypeOf<Unprovided>();
    expectTypeOf<
      Extract<Failures, { route: "routes/admin" }>["invalidResults"]
    >().toEqualTypeOf<string>();
    expectTypeOf<Extract<Failures, { route: "routes/ok" }>>().toEqualTypeOf<never>();
  });

  it("reports a registration that disagrees with the factory", () => {
    const other = makeEffectRouteFactory<FormError>()((Respond) => ({
      runtime,
      errorHandlers: { FormError: () => Respond.early({ different: true }) },
      actionMeta: () => ({ requestId: "r" }),
    }));
    type Failures = RouteEffectFailures<typeof other, {}>;
    expectTypeOf<Extract<Failures, { register: "recover" }>>().not.toBeNever();
    expectTypeOf<Extract<Failures, { register: "recover" }>["registered"]>().toEqualTypeOf<{
      FormError: { reply: string };
    }>();
    expectTypeOf<Extract<Failures, { register: "actionMeta" }>>().toBeNever();
  });
});

// Keeps DataWithResponseInit imported for readers of the data() case above.
export type { DataWithResponseInit };
