import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createContext, type LoaderFunctionArgs, RouterContextProvider } from "react-router";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { makeLoaderOrActionFactory, type RequestContextKey } from "../src/index.ts";

// ---------------------------------------------------------------------------
// A request-scoped service, set by "middleware" on a React Router context key,
// then pulled out by the runner and made available to the loader/action effect.
// ---------------------------------------------------------------------------

class RequestContext extends Context.Service<RequestContext, { readonly userId: string }>()(
  "test/RequestContext",
) {}

const requestContext: RequestContextKey<RequestContext> = createContext();

/** Stand in for middleware: build the per-request context and stash it on the key. */
function argsForRequest(userId: string): LoaderFunctionArgs {
  const context = new RouterContextProvider();
  context.set(requestContext, Context.make(RequestContext, { userId }));
  return { context } as unknown as LoaderFunctionArgs;
}

describe("request context (no runtime)", () => {
  const { makeLoader, makeAction } = makeLoaderOrActionFactory()({ requestContext });

  it("provides the per-request service to the effect", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return { greeting: `hi ${userId}` };
      }),
    );
    await expect(loader(argsForRequest("u_1"))).resolves.toEqual({ greeting: "hi u_1" });
  });

  it("reads a fresh value per request", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return userId;
      }),
    );
    await expect(loader(argsForRequest("alice"))).resolves.toBe("alice");
    await expect(loader(argsForRequest("bob"))).resolves.toBe("bob");
  });

  it("makeAction also receives the request context", async () => {
    const action = makeAction((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const { userId } = yield* RequestContext;
        return { actedBy: userId };
      }),
    );
    await expect(action(argsForRequest("u_9"))).resolves.toEqual({ actedBy: "u_9" });
  });
});

// ---------------------------------------------------------------------------
// Runtime services and per-request services compose.
// ---------------------------------------------------------------------------

class AppConfig extends Context.Service<AppConfig>()("test/AppConfig", {
  make: Effect.succeed({ appName: "demo" }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

describe("runtime services + request context compose", () => {
  const runtime = ManagedRuntime.make(AppConfig.layer);
  afterAll(() => runtime.dispose());

  const { makeLoader } = makeLoaderOrActionFactory()({ runtime, requestContext });

  it("an effect may require both an app service and a request service", async () => {
    const loader = makeLoader((_a: LoaderFunctionArgs) =>
      Effect.gen(function* () {
        const cfg = yield* AppConfig; // from the runtime
        const { userId } = yield* RequestContext; // from the per-request context
        return { who: `${cfg.appName}:${userId}` };
      }),
    );
    await expect(loader(argsForRequest("u_42"))).resolves.toEqual({ who: "demo:u_42" });
  });
});
