import { Effect } from "effect";

import { Respond } from "../lib/route-factory.server";

/** A resource route that only redirects, through the factory's `Respond.redirect`. */
export const loader = Effect.fn("loader.todosOld")(function* () {
  return yield* Respond.redirect("/todos", 301);
});
