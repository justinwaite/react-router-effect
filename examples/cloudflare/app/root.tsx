import { Predicate } from "effect";
import { isRouteErrorResponse, Links, Meta, NavLink, Outlet, Scripts } from "react-router";

import type { Route } from "./+types/root";

export function Layout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "40rem" }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <nav style={{ display: "flex", gap: "1rem" }}>
        <NavLink to="/">Home</NavLink>
        <NavLink to="/notes/1">Note</NavLink>
        <NavLink to="/legacy">Promise loader</NavLink>
      </nav>
      <Outlet />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message =
    isRouteErrorResponse(error) &&
    Predicate.hasProperty(error.data, "message") &&
    Predicate.isString(error.data.message)
      ? error.data.message
      : "Something went wrong";
  return (
    <main>
      <h1 data-testid="error">{message}</h1>
    </main>
  );
}
