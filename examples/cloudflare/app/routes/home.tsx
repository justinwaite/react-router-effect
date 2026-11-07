import { Effect } from "effect";
import { Suspense } from "react";
import { Await } from "react-router";

import type { Route } from "./+types/home";

import { Connection } from "../lib/services.server";

/**
 * Queries the request's connection now, and again after the shell is sent.
 * The second result streams in later, and the connection stays open until it
 * has: the request layer's scope closes when the body ends.
 */
export const loader = Effect.fn("loader.home")(function* () {
  const connection = yield* Connection;
  const now = yield* connection.query("select now");
  const later = Effect.runPromise(
    Effect.sleep("200 millis").pipe(Effect.andThen(connection.query("select later"))),
  );
  return { now, later };
});

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      <p data-testid="now">{loaderData.now}</p>
      <Suspense fallback={<p>Querying…</p>}>
        <Await resolve={loaderData.later}>{(later) => <p data-testid="later">{later}</p>}</Await>
      </Suspense>
    </section>
  );
}
