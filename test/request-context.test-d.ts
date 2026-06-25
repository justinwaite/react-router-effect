import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createContext, type LoaderFunctionArgs } from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, type RequestContextKey } from "../src/index.ts";

// ---------------------------------------------------------------------------
// With a `requestContext` configured, an effect may require its per-request
// services; requiring a service neither the runtime nor the request context
// provides must fail to type-check.
// ---------------------------------------------------------------------------

class RequestContext extends Context.Service<RequestContext, { readonly userId: string }>()(
  "test/RequestContext",
) {}

class AppConfig extends Context.Service<AppConfig>()("test/AppConfig", {
  make: Effect.succeed({ appName: "demo" }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

/** A service provided by neither the runtime nor the request context. */
class Unprovided extends Context.Service<Unprovided, { readonly nope: true }>()(
  "test/Unprovided",
) {}

const requestContext: RequestContextKey<RequestContext> = createContext();
const runtime = ManagedRuntime.make(AppConfig.layer);

describe("requestContext satisfies an effect's request-scoped services", () => {
  const { makeLoader, makeAction } = makeLoaderOrActionFactory()({ requestContext });

  it("an effect requiring the request service type-checks", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return { userId };
      }),
    );
    expectTypeOf(loader).returns.resolves.toEqualTypeOf<{ userId: string }>();
  });

  it("makeAction satisfies request services the same way", () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return userId;
      }),
    );
    expectTypeOf(action).returns.resolves.toEqualTypeOf<string>();
  });

  it("requiring a service neither runtime nor request context provides fails", () => {
    // @ts-expect-error — Unprovided is not in the runtime or the request context,
    // so the effect's requirement channel is unsatisfied.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const svc = yield* Unprovided;
        return svc.nope;
      }),
    );
  });
});

describe("runtime services and request services compose", () => {
  const { makeLoader } = makeLoaderOrActionFactory()({ runtime, requestContext });

  it("an effect may require both", () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const cfg = yield* AppConfig; // runtime
        const { userId } = yield* RequestContext; // request context
        return { who: `${cfg.appName}:${userId}` };
      }),
    );
    expectTypeOf(loader).returns.resolves.toEqualTypeOf<{ who: string }>();
  });

  it("still rejects a service provided by neither", () => {
    // @ts-expect-error — Unprovided is in neither source.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        yield* AppConfig;
        yield* RequestContext;
        yield* Unprovided;
        return true;
      }),
    );
  });
});

describe("without a requestContext, request services are not available", () => {
  const { makeLoader } = makeLoaderOrActionFactory()({ runtime });

  it("requiring a request-scoped service fails to type-check", () => {
    // @ts-expect-error — no requestContext is configured, so RequestContext is not
    // provided and the effect may not require it.
    makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return userId;
      }),
    );
  });
});
