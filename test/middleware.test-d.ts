import { Context, Data, Effect, Layer, ManagedRuntime } from "effect";
import { HttpServerRespondable, HttpServerResponse } from "effect/unstable/http";
import type {
  MiddlewareFunction,
  RouterContextProvider,
  UNSAFE_DataWithResponseInit as DataWithResponseInit,
} from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeEffectRouteFactory } from "../src/index.ts";

// ---------------------------------------------------------------------------
// `makeMiddleware` pinned to a route's generated `Route.MiddlewareFunction`.
//
// Pinning it hands the *whole* call explicit type arguments — TypeScript has no
// partial inference — so the effect's error/requirement channels can no longer
// be inferred. They must still be checked: exactly the effects `makeLoader` /
// `makeAction` accept must type-check here, and the ones they reject must not.
// ---------------------------------------------------------------------------

/** Declared, registered domain error. */
class MyDomainError extends Data.TaggedError("MyDomainError")<{ readonly message: string }> {}
/** Declared domain error with NO registered handler → flows to the 500 default. */
class DbError extends Data.TaggedError("DbError")<{ readonly query: string }> {}
/** Declared domain error that renders itself via HttpServerRespondable. */
class NotAuthorizedError extends Data.TaggedError("NotAuthorizedError")<{}> {
  [HttpServerRespondable.symbol](): Effect.Effect<HttpServerResponse.HttpServerResponse> {
    return HttpServerResponse.json({ error: "Not authorized" }, { status: 403 }).pipe(Effect.orDie);
  }
}
/** A service-specific error a single route consumes — NOT a declared domain error. */
class FooServiceError extends Data.TaggedError("FooServiceError")<{ readonly reason: number }> {}

type DomainErrors = MyDomainError | DbError | NotAuthorizedError;

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

/**
 * A stand-in for a route's generated `Route.MiddlewareFunction`: server middleware
 * resolving with a `Response`, with the route's own `params` on `args`. Written out
 * (rather than `MiddlewareFunction<Response>`) so these tests also cover the shape
 * typegen actually emits — narrowed args, its own inline `next`.
 */
type RouteMiddlewareFunction = (
  args: {
    readonly request: Request;
    readonly params: { readonly id: string };
    readonly context: Readonly<RouterContextProvider>;
  },
  next: () => Promise<Response>,
) => Promise<Response | void> | Response | void;

const { makeMiddleware, Respond } = makeEffectRouteFactory<DomainErrors>()(() => ({
  errorHandlers: {
    MyDomainError: (error: MyDomainError) =>
      Effect.fail(new Response(error.message, { status: 400 })),
    // DbError and NotAuthorizedError intentionally have no handler.
  },
}));

describe("a pinned middleware types its args, next and result from the route", () => {
  it("args and next come from the pinned middleware type", () => {
    makeMiddleware<RouteMiddlewareFunction>((args, next) =>
      Effect.gen(function* () {
        expectTypeOf(args.params).toEqualTypeOf<{ readonly id: string }>();
        expectTypeOf(args.request).toEqualTypeOf<Request>();
        // `next` is wrapped as an effect resolving with the route's own result,
        // failing with the finished response a downstream throw produced.
        expectTypeOf(next).returns.toEqualTypeOf<
          Effect.Effect<Response, DataWithResponseInit<unknown> | Response>
        >();
        return yield* next();
      }),
    );
  });

  it("the wrapper drops into the route's own middleware array", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) => next());
    const middlewares: RouteMiddlewareFunction[] = [middleware];
    expectTypeOf(middlewares).toBeArray();
    expectTypeOf(middleware).returns.resolves.toEqualTypeOf<Response | undefined>();
  });

  it("succeeding with something the route can't return fails to type-check", () => {
    // @ts-expect-error — this route's middleware resolves with a Response, not a string.
    makeMiddleware<RouteMiddlewareFunction>((_args, _next) => Effect.succeed("nope"));
  });
});

describe("a pinned middleware propagates the errors the library handles", () => {
  it("a registered domain error type-checks", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        yield* new MyDomainError({ message: "boom" });
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("a declared domain error with no handler type-checks (it flows to the 500)", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        yield* new DbError({ query: "select 1" });
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("a respondable domain error with no handler type-checks", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        yield* new NotAuthorizedError();
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("library route errors raised directly need no handling", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        yield* Respond.redirect("/login");
        yield* Respond.early({ restricted: true });
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("a downstream next() failure needs no handling", () => {
    // `next()` fails with the finished response a downstream throw produced; the
    // library re-throws it as-is, so the middleware needn't catch it to re-raise it.
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) => next());
    expectTypeOf(middleware).toBeFunction();
  });
});

describe("a pinned middleware still enforces handling of everything else", () => {
  it("leaving a service error unhandled fails to type-check", () => {
    makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      // @ts-expect-error — FooServiceError isn't a declared domain error, a library
      // route error, or respondable, so it must be handled in the effect first.
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return yield* next();
      }),
    );
  });

  it("a service error mixed in with domain errors still forces handling", () => {
    makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      // @ts-expect-error — DbError is fine, but FooServiceError still must be handled.
      Effect.gen(function* () {
        yield* new DbError({ query: "select 1" });
        yield* new FooServiceError({ reason: 1 });
        return yield* next();
      }),
    );
  });

  it("handling the service error makes it type-check", () => {
    const middleware = makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return yield* next();
      }).pipe(
        Effect.catchTag("FooServiceError", (error) =>
          Effect.fail(Respond.throw({ reason: error.reason }, 422)),
        ),
      ),
    );
    expectTypeOf(middleware).toBeFunction();
  });
});

describe("a pinned middleware enforces the factory's provided services", () => {
  const runtime = ManagedRuntime.make(InRuntime.layer);
  const factory = makeEffectRouteFactory<DomainErrors>()(() => ({ runtime }));

  it("requiring a runtime-provided service type-checks", () => {
    const middleware = factory.makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      Effect.gen(function* () {
        const svc = yield* InRuntime;
        yield* svc.ping();
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("requiring a service the runtime does NOT provide fails to type-check", () => {
    factory.makeMiddleware<RouteMiddlewareFunction>((_args, next) =>
      // @ts-expect-error — NotInRuntime is not provided by the configured runtime.
      Effect.gen(function* () {
        const svc = yield* NotInRuntime;
        yield* svc.pong();
        return yield* next();
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Unpinned: no type argument, so the effect's channels infer as they do for
// `makeLoader` / `makeAction` — including the call-site diagnostic.
// ---------------------------------------------------------------------------

describe("an unpinned middleware infers from the effect", () => {
  it("domain errors and library route errors type-check", () => {
    const middleware = makeMiddleware((_args, next) =>
      Effect.gen(function* () {
        yield* new DbError({ query: "select 1" });
        yield* Respond.redirect("/login");
        return yield* next();
      }),
    );
    expectTypeOf(middleware).toBeFunction();
  });

  it("leaving a service error unhandled fails to type-check", () => {
    makeMiddleware((_args, next) =>
      // @ts-expect-error — FooServiceError must be handled before makeMiddleware accepts it.
      Effect.gen(function* () {
        yield* new FooServiceError({ reason: 1 });
        return yield* next();
      }),
    );
  });

  it("defaults args and next to react-router's own MiddlewareFunction", () => {
    const middleware = makeMiddleware((_args, next) => next());
    expectTypeOf(middleware).parameter(0).toEqualTypeOf<Parameters<MiddlewareFunction>[0]>();
    expectTypeOf(middleware).returns.resolves.toEqualTypeOf<unknown>();
  });
});
