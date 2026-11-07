import { Effect } from "effect";

import { runInBackground } from "../lib/background.server";
import { stats } from "../lib/services.server";

/** A resource route that answers at once, and counts after the response with `waitUntil`. */
export const loader = Effect.fn("loader.background")(function* () {
  yield* runInBackground(
    Effect.sleep("50 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          stats.background++;
        }),
      ),
    ),
  );
  return Response.json({ scheduled: true });
});
