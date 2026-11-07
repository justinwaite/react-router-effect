import { Effect } from "effect";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/note";

import { NotFound } from "../lib/route-factory.server";
import { Connection } from "../lib/services.server";

/** `NotFound` is not handled here: the route factory throws it as a 404. */
export const loader = Effect.fn("loader.note")(function* ({
  params,
}: EffectRouteArgs<Route.LoaderArgs>) {
  if (params.id !== "1") return yield* new NotFound({ what: `Note ${params.id}` });
  return { note: yield* (yield* Connection).query(`select note ${params.id}`) };
});

export default function Note({ loaderData }: Route.ComponentProps) {
  return <p data-testid="note">{loaderData.note}</p>;
}
