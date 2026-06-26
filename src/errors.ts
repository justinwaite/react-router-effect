import { Data } from "effect";

// ---------------------------------------------------------------------------
// Standardized errors — the library translates these out of the box.
// ---------------------------------------------------------------------------

/** Recoverable: short-circuits the loader but returns `data(...)` the component reads. */
export class ReturnableDataError<D> extends Data.TaggedError("ReturnableRouteError")<{
  data: D;
  init?: number | ResponseInit;
}> {}

/** Throwable: rejects with `data(...)` → boundary as an `ErrorResponse`. */
export class ThrowableDataError<D> extends Data.TaggedError("ThrowableRouteError")<{
  data: D;
  init?: number | ResponseInit;
}> {}

/** Throwable: rejects with a redirect `Response`. */
export class ThrowableRedirectError extends Data.TaggedError("ThrowableRedirectError")<{
  url: string;
  init?: number | ResponseInit;
}> {}

/** Every library route error, as a single union. */
export type AnyRouteError =
  | ReturnableDataError<unknown>
  | ThrowableDataError<unknown>
  | ThrowableRedirectError;

/**
 * The library's base helpers for raising route errors (`early` / `throw` /
 * `redirect`). This is internal: it isn't exported from the package. The factory
 * hands it to your config builder and returns it (merged with any `respond`
 * extensions) so your app imports a single `Respond`:
 *
 * ```ts
 * export const { makeLoader, Respond } = makeLoaderOrActionFactory<DomainErrors>()(
 *   (Respond) => ({
 *     respond: { formError: (reply) => new FormError({ reply }) },
 *     errorHandlers: { FormError: (e) => Respond.early({ reply: e.reply }) },
 *   }),
 * );
 * ```
 */
export const Respond = {
  /** Recover: short-circuit and hand `value` to the component as loader/action data. */
  early: <D>(value: D, init?: number | ResponseInit) =>
    new ReturnableDataError({ data: value, init }),
  /** Throw: short-circuit to the error boundary with `data(value, init)`. */
  throw: <D>(value: D, init?: number | ResponseInit) =>
    new ThrowableDataError({ data: value, init }),
  /** Throw: short-circuit with a redirect `Response`. */
  redirect: (url: string, init?: number | ResponseInit) =>
    new ThrowableRedirectError({ url, init }),
};

/** Narrows an unknown value to one of the library's route errors. */
export const isRouteError = (value: unknown): value is AnyRouteError =>
  value instanceof ReturnableDataError ||
  value instanceof ThrowableDataError ||
  value instanceof ThrowableRedirectError;
