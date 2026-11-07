import { Effect } from "effect";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { WorkerContext } from "react-router-effect/worker";

import type { Route } from "./+types/root";

import { Format } from "./lib/services.server";

/** Reads the Worker's env, typed by the `Register`, with an app-wide service. */
export const loader = Effect.fn("loader.root")(function* () {
  const worker = yield* WorkerContext;
  const format = yield* Format;
  return { greeting: format.title(worker.env.GREETING) };
});

export function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <main>
      <h1 data-testid="greeting">{loaderData.greeting}</h1>
      <Outlet />
    </main>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status}: ${(error.data as { readonly message?: string }).message ?? error.statusText}`
    : "Unexpected error";
  return <p data-testid="error">{message}</p>;
}
