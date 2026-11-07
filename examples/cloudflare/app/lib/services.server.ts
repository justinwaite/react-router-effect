import { Context, Effect, Layer } from "effect";

/** The Worker's bindings, from `wrangler.jsonc`. The route factory's runtime provides it. */
export class WorkerEnv extends Context.Service<WorkerEnv, Env>()("example/WorkerEnv") {}

/**
 * The execution context of the request. `workers/app.ts` passes it with each
 * request, so route Effects read it as a service of the request.
 */
export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  ExecutionContext
>()("example/WorkerExecutionContext") {}

/**
 * What the Worker's isolate saw: connections opened and closed, and work done
 * after responses. `/stats` reports it, so the tests can watch the request's
 * scope.
 */
export const stats: { opened: number; closed: number; background: number } = {
  opened: 0,
  closed: 0,
  background: 0,
};

/**
 * An app-wide service, in the route factory's runtime. It holds no I/O
 * object, so it can outlive a request.
 */
export class Format extends Context.Service<Format, { readonly title: (text: string) => string }>()(
  "example/Format",
) {
  static readonly layer = Layer.succeed(Format)({
    title: (text) => text.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  });
}

/**
 * A resource of one request, such as a database connection. A Worker cannot
 * share I/O objects across requests, so `server/app.ts` opens one for every
 * request, in the request's scope. It closes when the response body ends.
 */
export class Connection extends Context.Service<
  Connection,
  {
    readonly id: number;
    /** Dies when the connection is closed: the request's scope closed too soon. */
    readonly query: (sql: string) => Effect.Effect<string>;
  }
>()("example/Connection") {}

export const ConnectionLive = Layer.effect(Connection)(
  Effect.gen(function* () {
    let open = true;
    const id = yield* Effect.acquireRelease(
      Effect.sync(() => ++stats.opened),
      () =>
        Effect.sync(() => {
          open = false;
          stats.closed++;
        }),
    );
    return {
      id,
      query: (sql: string) =>
        open
          ? Effect.succeed(`connection ${id}: ${sql}`)
          : Effect.die(new Error(`connection ${id} is closed`)),
    };
  }),
);
