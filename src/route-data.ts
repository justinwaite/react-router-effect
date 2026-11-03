import type { Effect } from "effect";
import type { UNSAFE_DataWithResponseInit, useLoaderData } from "react-router";

import type { WithActionMeta } from "./action-meta.ts";
import type { ReturnableDataError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Route data of plain Effect loaders and actions.
// ---------------------------------------------------------------------------

/**
 * Registers what the app's route factory turns failures into, so that a
 * loader or action written as a plain `Effect.fn` types its data the way a
 * `makeLoader` call would.
 *
 * A `makeLoader` call sees the factory's handlers as type arguments. A plain
 * Effect loader does not, so without this an error that a handler recovers
 * into data, such as a form error that becomes `{ reply }`, would be missing
 * from `useLoaderData`, `useFetcher` and `Route.ComponentProps`.
 *
 * Declare the types directly rather than reading them from the factory's
 * value: the factory's type depends on every Effect in the app, and so on
 * this registration. The server adapter's `RouteEffectCheck` fails when the
 * registration and the factory disagree.
 *
 * ```ts
 * declare module "react-router-effect" {
 *   interface Register {
 *     // Each error tag a handler recovers, and the data it recovers into.
 *     recover: { FormValidationError: { reply: SubmissionResponse } };
 *     // What `actionMeta` returns.
 *     actionMeta: { realtimeEventIds: ReadonlyArray<string> };
 *   }
 * }
 * ```
 */
export interface Register {}

/** The registered recover map: error tag to recovered data. */
export type RegisteredRecover = Register extends { readonly recover: infer Recover } ? Recover : {};

/** The registered action metadata, or `never` when there is none. */
export type RegisteredMeta = Register extends { readonly actionMeta: infer Meta } ? Meta : never;

/** What a failure of type `E` recovers into: `Respond.early` bodies and registered handlers. */
type Recovered<E> =
  | (E extends ReturnableDataError<infer Body> ? Body : never)
  | (E extends { readonly _tag: infer Tag extends keyof RegisteredRecover }
      ? RegisteredRecover[Tag]
      : never);

/**
 * React Router's own serialization of loader data. React Router does not
 * export it, but a zero-argument function is a server loader to its public
 * `useLoaderData` type, so this gives the same type.
 */
export type Serialize<T> = ReturnType<typeof useLoaderData<() => Promise<T>>>;

/**
 * The data an Effect that succeeds with `A` and fails with `E` gives the
 * component: its success and what its failures recover into, serialized as
 * React Router serializes them, with the registered action metadata.
 */
export type EffectData<A, E> = WithActionMeta<Serialize<A | Recovered<E>>, RegisteredMeta>;

/**
 * The route data of a loader or action, for React Router's hooks:
 * `useFetcher<RouteData<typeof action>>()`. A function that returns an Effect
 * gives its `EffectData`. Any other function passes through, so the hook
 * reads it as it always has.
 */
export type RouteData<F> = F extends (...args: never[]) => Effect.Effect<infer A, infer E, infer _R>
  ? EffectData<A, E>
  : F;

/**
 * Loader data as React Router reads it before serializing: a `Response` adds
 * nothing, and a `data(...)` wrapper gives its body.
 */
type Unwrapped<A> = A extends Response
  ? never
  : A extends UNSAFE_DataWithResponseInit<infer Body>
    ? Body
    : A;

/**
 * The data React Router reads from an Effect through `unstable_SerializesTo`.
 *
 * TypeScript compares this brand whenever it relates two Effects
 * structurally, so it must keep the subtype order of `A` and `E`: when
 * `Effect<A1, E1>` is assignable to `Effect<A2, E2>`, `BrandData<A1, E1>` must
 * be assignable to `BrandData<A2, E2>`. React Router's `Serialize` does not
 * (it turns `unknown` into `undefined`), so the brand holds the data before
 * serialization; `RouteData` applies the actual serialization.
 *
 * - A `void` or `any` success gives `unknown`, which accepts every other brand.
 * - A `never` success gives only what the failures recover into.
 *
 * `Effect` declares its parameters `out`, and TypeScript verifies that
 * annotation against this member, and against it again in every Effect type
 * that declares variance (`Exit`, `Config`, ...). It relates two conditional
 * types branch by branch when their check types are related and their
 * `extends` types are identical. So every conditional here, and in the types
 * it uses, checks `A` or `E` (or a tuple of one) against a type that does not
 * depend on them. A conditional with `A` or `E` on its `extends` side, such as
 * `0 extends 1 & A` to detect `any`, fails the verification: a consumer that
 * checks library types (`skipLibCheck: false`) then gets TS2636 in Effect's own
 * declarations. `test/consumer` checks the built package for that.
 */
export type BrandData<A, E> = [A] extends [never]
  ? WithActionMeta<Recovered<E>, RegisteredMeta>
  : [A] extends [void]
    ? unknown
    : WithActionMeta<Unwrapped<A> | Recovered<E>, RegisteredMeta>;

declare module "effect/Effect" {
  // React Router reads loader and action data through this brand, so an
  // Effect-returning loader types `Route.ComponentProps` like a promise one.
  interface Effect<out A, out E, out R> {
    readonly unstable__ReactRouter_SerializesTo: [BrandData<A, E>];
  }
}

declare module "effect/Cause" {
  // A yieldable error is structurally an Effect that never succeeds, so it
  // needs the brand too, or it stops being assignable to `Effect`.
  interface YieldableError {
    readonly unstable__ReactRouter_SerializesTo: [never];
  }
}

/**
 * Route args for a loader or action written as a plain `Effect.fn`, such as
 * `EffectRouteArgs<Route.ActionArgs>`. It keeps hooks that take `typeof loader`
 * or `typeof action` typed, such as `useFetcher<typeof action>()`.
 *
 * Those hooks read a function's data through React Router's `SerializeFrom`.
 * It treats a function whose argument extends `ClientDataFunctionArgs` as a
 * client function, and gives its raw return value without serialization.
 * Typegen's `Route.LoaderArgs` and `Route.ActionArgs` have the same members as
 * `ClientDataFunctionArgs`, so a server function typed with them matches too.
 * For an Effect, the raw return value is the Effect itself: only serialization
 * reads the `unstable_SerializesTo` brand.
 *
 * `pattern` is optional here, so the argument no longer matches and the hooks
 * read the brand. `Route.ComponentProps` and `RouteData` don't go through
 * `SerializeFrom`, so they are correct without it.
 */
export type EffectRouteArgs<Args extends { readonly pattern: string }> = Omit<Args, "pattern"> & {
  readonly pattern?: string;
};
