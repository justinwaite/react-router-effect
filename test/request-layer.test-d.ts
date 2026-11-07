import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { HttpServerRequest } from "effect/http";
import type { ServerBuild } from "react-router";
import { describe, expectTypeOf, it } from "vite-plus/test";

import { makeEffectRouteFactory } from "../src/index.ts";
import * as ReactRouterHttp from "../src/server.ts";
import * as ReactRouterWorker from "../src/worker.ts";

class AppConfig extends Context.Service<AppConfig, { readonly name: string }>()("test/AppConfig") {}
class Connection extends Context.Service<Connection, { readonly id: number }>()(
  "test/Connection",
) {}
class Unprovided extends Context.Service<Unprovided, {}>()("test/Unprovided") {}

declare const build: ServerBuild;

const factory = makeEffectRouteFactory()(() => ({
  runtime: ManagedRuntime.make(Layer.succeed(AppConfig)({ name: "app" })),
}));
const bare = makeEffectRouteFactory()(() => ({}));

/** A layer of `Connection` that requires `R`. */
declare const layerOf: <R>() => Layer.Layer<Connection, Error, R>;

describe("the Worker adapter's request layer", () => {
  it("may require the runtime's services and WorkerContext", () => {
    ReactRouterWorker.make({
      build,
      factory,
      requestLayer: () => layerOf<AppConfig | ReactRouterWorker.WorkerContext>(),
    });
  });

  it("may not require a service the runtime does not provide", () => {
    ReactRouterWorker.make({
      build,
      factory,
      // @ts-expect-error `Unprovided` is not a service of the runtime
      requestLayer: () => layerOf<Unprovided>(),
    });
    ReactRouterWorker.make({
      build,
      factory: bare,
      // @ts-expect-error a factory without a runtime provides nothing
      requestLayer: () => layerOf<AppConfig>(),
    });
  });

  it("gets the request and the Worker's arguments", () => {
    ReactRouterWorker.make({
      build,
      factory,
      requestLayer: (request, worker) => {
        expectTypeOf(request).toEqualTypeOf<Request>();
        expectTypeOf(worker.ctx).toHaveProperty("waitUntil");
        return Layer.succeed(Connection)({ id: 1 });
      },
    });
  });

  it("makes a fetch handler", () => {
    const handler = ReactRouterWorker.make({ build, factory });
    expectTypeOf(handler.fetch).returns.toEqualTypeOf<Promise<Response>>();
  });

  it("types WorkerContext.waitUntil by the Effect's requirements", () => {
    const program = Effect.gen(function* () {
      const worker = yield* ReactRouterWorker.WorkerContext;
      yield* worker.waitUntil(
        Effect.gen(function* () {
          return (yield* AppConfig).name;
        }),
      );
    });
    expectTypeOf<Effect.Success<typeof program>>().toEqualTypeOf<void>();
    expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<never>();
    expectTypeOf<Effect.Services<typeof program>>().toEqualTypeOf<
      ReactRouterWorker.WorkerContext | AppConfig
    >();
  });
});

describe("the Node adapter's request layer", () => {
  it("may require the runtime's services and the HTTP request", () => {
    ReactRouterHttp.make({
      build,
      factory,
      requestLayer: () => layerOf<AppConfig | HttpServerRequest.HttpServerRequest>(),
    });
  });

  it("may not require a service the runtime does not provide", () => {
    ReactRouterHttp.make({
      build,
      factory,
      // @ts-expect-error `Unprovided` is not a service of the runtime
      requestLayer: () => layerOf<Unprovided>(),
    });
  });

  it("keeps the app's type", () => {
    const app = ReactRouterHttp.make({ build, factory, requestLayer: () => layerOf<never>() });
    expectTypeOf(app).toEqualTypeOf<
      Effect.Effect<
        Effect.Effect<
          import("effect/http").HttpServerResponse.HttpServerResponse,
          import("effect/http").HttpServerError.RequestError,
          HttpServerRequest.HttpServerRequest
        >,
        never,
        never
      >
    >();
  });
});
