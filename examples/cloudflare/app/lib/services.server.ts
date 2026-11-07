import { Context, Effect, Layer } from "effect";

/**
 * What the Worker's isolate saw: connections opened and closed, and work done
 * after responses. `/stats` reports it, so the tests can watch the request
 * layer's scope.
 */
export const stats = { opened: 0, closed: 0, background: 0 };

/**
 * An app-wide service, in the runtime: it holds no I/O object, so it can
 * outlive a request.
 */
export class Format extends Context.Service<Format, { readonly title: (text: string) => string }>()(
  "example/Format",
) {
  static readonly layer = Layer.succeed(Format)({
    title: (text) => text.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  });
}

/**
 * A per-request resource, such as a database connection: a Worker cannot
 * share one across requests. The request layer opens it for every request,
 * and closes it when the response ends.
 */
export class Connection extends Context.Service<
  Connection,
  {
    readonly id: number;
    /** Dies when the connection is closed: the request layer closed it too soon. */
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
