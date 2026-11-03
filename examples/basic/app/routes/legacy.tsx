import type { Route } from "./+types/legacy";

/** A plain promise loader. The adapter passes it through to React Router unchanged. */
export async function loader() {
  return { message: "Served by a promise loader", servedAt: new Date().toISOString() };
}

export default function Legacy({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1 data-testid="message">{loaderData.message}</h1>
      <p>{loaderData.servedAt}</p>
    </main>
  );
}
