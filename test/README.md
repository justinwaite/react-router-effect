# Test suite

Two Vitest projects, configured in `vite.config.ts` under `test.projects`:

| Project   | Files                                       | Environment                      | What it covers                                                                          |
| --------- | ------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `unit`    | `test/**/*.test.ts` + `test/**/*.test-d.ts` | Node (+ `tsc` for `*.test-d.ts`) | The wrapper's runtime behavior, and the loader/action **return-type** assertions.       |
| `browser` | `test/**/*.spec.tsx`                        | Chromium (Playwright via Vitest) | A `makeLoader`/`makeAction` driven through a **real** React Router runtime, end-to-end. |

## Running

```bash
vp test run                    # both projects
vp test run --project unit     # runtime + type tests
vp test run --project browser  # integration tests
vp test watch                  # watch mode

# one-time local setup for the browser project:
vp exec playwright install chromium   # or: pnpm test:browser:install
```

## How the integration tests work

`integration.spec.tsx` uses React Router's `createRoutesStub` (see
`app/render-route.tsx`) to mount a **real** React Router runtime: the loader/action
effect actually runs, `Effect.runPromise` settles, and the router routes the result to
`useLoaderData` / `useActionData`, the `ErrorBoundary`, or a redirect. That exercises the
full **recover / throw / redirect / auto-respond / 500** lifecycle the library provides —
deliberately stronger than mocking `react-router`.

Nothing under `test/` is published (the package `files` field ships only `dist` and `src`).
