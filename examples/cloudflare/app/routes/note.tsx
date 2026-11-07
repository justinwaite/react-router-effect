import { Effect } from "effect";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/note";

import { NotFound } from "../lib/route-factory.server";

/** An Effect loader with a domain error, which the factory throws as a 404. */
export const loader = Effect.fn("loader.note")(function* ({
  params,
}: EffectRouteArgs<Route.LoaderArgs>) {
  if (params.id !== "1") return yield* new NotFound({ what: `Note ${params.id}` });
  return { title: "The first note" };
});

export default function Note({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1 data-testid="title">{loaderData.title}</h1>
    </main>
  );
}
