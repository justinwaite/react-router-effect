import type { Route } from "./+types/legacy";

import { cloudflareContext } from "../lib/cloudflare-context";

/** A promise loader: the adapter passes it through, with the context `getLoadContext` made. */
export async function loader({ context }: Route.LoaderArgs) {
  return { greeting: context.get(cloudflareContext).env.GREETING };
}

export default function Legacy({ loaderData }: Route.ComponentProps) {
  return <p data-testid="legacy">{loaderData.greeting}</p>;
}
