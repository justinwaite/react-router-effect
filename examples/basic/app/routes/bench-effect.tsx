import { Effect } from "effect";
import type { EffectRouteArgs } from "react-router-effect";

import type { Route } from "./+types/bench-effect";

import { benchItems } from "../lib/bench-items";
import { textField } from "../lib/form";

/** The benchmark's Effect loader and action. `bench-promise.tsx` does the same with promises. */
export const loader = Effect.fn("loader.benchEffect")(() => Effect.succeed({ items: benchItems }));

export const action = Effect.fn("action.benchEffect")(function* ({
  request,
}: EffectRouteArgs<Route.ActionArgs>) {
  const form = yield* Effect.promise(() => request.formData());
  return { saved: textField(form, "title") };
});

export default function BenchEffect({ loaderData }: Route.ComponentProps) {
  return (
    <ul>
      {loaderData.items.map((item) => (
        <li key={item.id}>{item.title}</li>
      ))}
    </ul>
  );
}
