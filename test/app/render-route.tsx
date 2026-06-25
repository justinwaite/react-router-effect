/**
 * Mounts a real React Router runtime in the browser via `createRoutesStub` and
 * `vitest-browser-react`. This gives the library a *real* loader/action data
 * lifecycle — the effect runs, `Effect.runPromise` settles, and React Router
 * routes the result to `useLoaderData` / `useActionData` or the `ErrorBoundary`
 * (or follows a redirect) — instead of mocking any of it. That end-to-end flow
 * is exactly what this library exists to provide.
 */
import type { ComponentType } from "react";
import { createRoutesStub, type LoaderFunctionArgs } from "react-router";
import { render } from "vitest-browser-react";

// React Router supplies the full args object at runtime; the library's wrappers
// are what we're actually exercising here.
type DataFn = (args: LoaderFunctionArgs) => unknown;

export interface RouteConfig {
  Component: ComponentType;
  loader?: DataFn;
  action?: DataFn;
  ErrorBoundary?: ComponentType;
}

/**
 * Render `config` as the index route at `/`. Pass `extraRoutes` to provide
 * navigation targets (e.g. a redirect destination).
 */
export function renderRoute(
  config: RouteConfig,
  extraRoutes: Array<{ path: string; Component: ComponentType }> = [],
) {
  const Stub = createRoutesStub([
    // A no-op HydrateFallback keeps React Router from warning about missing
    // hydration UI while the loader's async effect settles.
    { path: "/", HydrateFallback: () => null, ...config },
    ...extraRoutes,
  ] as never);
  return render(<Stub />);
}
