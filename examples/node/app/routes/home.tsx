import { Effect } from "effect";
import { Suspense } from "react";
import { Await } from "react-router";

import type { Route } from "./+types/home";

import { Todos } from "../lib/services.server";

export const meta: Route.MetaFunction = () => [{ title: "react-router-effect example" }];

/**
 * An Effect loader whose data holds a promise. React Router sends the rest of
 * the data first and streams the promise's value when it resolves.
 */
export const loader = Effect.fn("loader.home")(function* () {
  const todos = yield* (yield* Todos).list;
  const summary = Effect.runPromiseWith(yield* Effect.context())(
    Effect.sleep("300 millis").pipe(Effect.as(`${todos.length} todos, summarized slowly`)),
  );
  return { count: todos.length, summary };
});

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1>react-router-effect</h1>
      <p>
        <span data-testid="count">{loaderData.count}</span> todos on the list.
      </p>
      <Suspense fallback={<p>Summarizing…</p>}>
        <Await resolve={loaderData.summary}>
          {(summary) => <p data-testid="summary">{summary}</p>}
        </Await>
      </Suspense>
    </main>
  );
}
