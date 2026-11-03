/**
 * Type-checks the built package as a consumer imports it, through its
 * `exports`, with `skipLibCheck: false`. Run it after `vp pack` with
 * `vp run check:consumer`.
 *
 * It fails when the published types do not compile in a consumer's project:
 * for example when the brand on `Effect` fails Effect's variance annotations,
 * which shows as TS2636 in Effect's own declarations (see `BrandData`).
 */
import { Data, Effect } from "effect";
import type { RouteData } from "react-router-effect";
import type { ReactRouterHttp, RouteEffectCheck } from "react-router-effect/server";
import type { ReactRouterVite } from "react-router-effect/vite";
import type { useLoaderData } from "react-router";

type LoaderData<F extends (...args: never[]) => unknown> = ReturnType<typeof useLoaderData<F>>;

class Other extends Data.TaggedError("Other") {}

// A plain `Effect.fn` loader types its data through the brand.
const loader = Effect.fn("loader")(function* (n: number) {
  if (n > 2) return yield* new Other();
  return { a: 1, list: [1, 2] };
});
export const data: LoaderData<typeof loader> = { a: 1, list: [1] };
export const same: RouteData<typeof loader> = data;
// @ts-expect-error not part of the loader's data
export const wrong: LoaderData<typeof loader> = { b: 2 };

// A `Response` adds no data.
const responseLoader = () => Effect.succeed(new Response("ok"));
export const noData: [LoaderData<typeof responseLoader>] extends [never] ? true : false = true;

// `Effect` stays covariant in its success and error, and not contravariant.
declare const narrow: Effect.Effect<{ a: 1 }, Other>;
export const wide: Effect.Effect<{ a: number } | string, Other | Error> = narrow;
// @ts-expect-error a wider success is not assignable to a narrower one
export const back: Effect.Effect<{ a: 1 }, Other> = wide;

// A yieldable error is still an `Effect`.
export const yielded: Effect.Effect<never, Other> = new Other();

// Loads the declarations of every entry point.
export type EntryPoints = [
  RouteEffectCheck<unknown>,
  typeof ReactRouterHttp.make,
  typeof ReactRouterVite.devMiddleware,
];
