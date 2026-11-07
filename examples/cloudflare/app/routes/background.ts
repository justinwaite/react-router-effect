import { Effect } from "effect";
import { WorkerContext } from "react-router-effect/worker";

import { Connection, stats } from "../lib/services.server";

/**
 * Answers at once, and does work after the response with the request's
 * connection, which stays open until the work ends.
 */
export const action = Effect.fn("action.background")(function* () {
  const worker = yield* WorkerContext;
  yield* worker.waitUntil(
    Effect.gen(function* () {
      yield* Effect.sleep("100 millis");
      yield* (yield* Connection).query("insert into audit");
      stats.background++;
    }),
  );
  return Response.json({ accepted: true }, { status: 202 });
});
