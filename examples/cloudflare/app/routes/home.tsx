import { Effect } from "effect";
import { Suspense } from "react";
import { Await } from "react-router";

import type { Route } from "./+types/home";

import { Connection, Format, WorkerEnv } from "../lib/services.server";

export const meta: Route.MetaFunction = () => [{ title: "react-router-effect on Cloudflare" }];

/**
 * An Effect loader. It reads the Worker's env from the runtime and the
 * request's connection. Its data holds a promise that queries the connection
 * after the shell is sent: the connection stays open until the body ends.
 */
export const loader = Effect.fn("loader.home")(function* () {
  const env = yield* WorkerEnv;
  const format = yield* Format;
  const connection = yield* Connection;
  const later = Effect.runPromise(
    Effect.sleep("100 millis").pipe(Effect.andThen(connection.query("select 1"))),
  );
  return { greeting: format.title(env.GREETING), connection: connection.id, later };
});

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1 data-testid="greeting">{loaderData.greeting}</h1>
      <p>
        Connection <span data-testid="connection">{loaderData.connection}</span>
      </p>
      <Suspense fallback={<p>Querying…</p>}>
        <Await resolve={loaderData.later}>{(row) => <p data-testid="later">{row}</p>}</Await>
      </Suspense>
    </main>
  );
}
