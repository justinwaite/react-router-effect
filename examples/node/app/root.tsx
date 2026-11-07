import { Effect } from "effect";
import {
  createCookie,
  isRouteErrorResponse,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { EffectMiddlewareArgs } from "react-router-effect";

import type { Route } from "./+types/root";

import { RequestInfo, Visitor } from "./lib/services.server";

/** Remembers the visitor between requests. */
const visitorCookie = createCookie("visitor", {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 365,
});

/**
 * An Effect middleware. It provides `Visitor` to every loader, action and
 * middleware downstream of `next()`, annotates their logs, and sets the
 * visitor cookie on the response of a new visitor.
 */
export const middleware = [
  Effect.fn("middleware.visitor")(function* ({
    request,
    next,
  }: EffectMiddlewareArgs<Route.MiddlewareFunction>) {
    const known: unknown = yield* Effect.promise(() =>
      visitorCookie.parse(request.headers.get("cookie")),
    );
    const name = typeof known === "string" ? known : `visitor-${crypto.randomUUID().slice(0, 8)}`;
    const response = yield* next().pipe(
      Effect.provideService(Visitor, { name, isNew: typeof known !== "string" }),
      Effect.annotateLogs({ visitor: name }),
    );
    if (typeof known !== "string") {
      response.headers.append(
        "set-cookie",
        yield* Effect.promise(() => visitorCookie.serialize(name)),
      );
    }
    return response;
  }),
];

/** An Effect loader with no arguments: it reads services only. */
export const loader = Effect.fn("loader.root")(function* () {
  const visitor = yield* Visitor;
  const request = yield* RequestInfo;
  return { visitor: visitor.name, requestId: request.id };
});

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

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
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <nav style={{ display: "flex", gap: "1rem" }}>
        <NavLink to="/">Home</NavLink>
        <NavLink to="/todos">Todos</NavLink>
        <NavLink to="/legacy">Promise loader</NavLink>
        <a href="/events">Event stream</a>
      </nav>
      <p>
        Hello, <span data-testid="visitor">{loaderData.visitor}</span>
      </p>
      <Outlet />
      <footer>
        <small>Request {loaderData.requestId}</small>
      </footer>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong";
  return (
    <main>
      <h1>{message}</h1>
    </main>
  );
}
