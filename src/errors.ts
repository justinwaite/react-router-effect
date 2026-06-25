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
 * Standardized helpers for raising the library's route errors. Consumers extend it
 * by spreading into their own object — opinionated helpers (e.g. a form-library
 * `formError`) live in the consumer, not here:
 *
 * ```ts
 * export const Respond = {
 *   ...baseRespond,
 *   formError: (reply) => baseRespond.early({ reply }, 400),
 * };
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
