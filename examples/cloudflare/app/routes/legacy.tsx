import type { Route } from "./+types/legacy";

import { workerEnvContext } from "../lib/env-context";

/**
 * A plain promise loader. The adapter passes it through to React Router
 * unchanged. It reads the Worker's env from the context that `loadContext`
 * makes.
 */
export async function loader({ context }: Route.LoaderArgs) {
  return { greeting: context.get(workerEnvContext).GREETING };
}

export default function Legacy({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1 data-testid="legacy">{loaderData.greeting}</h1>
    </main>
  );
}
