import { Predicate } from "effect";
import { data, type UNSAFE_DataWithResponseInit as DataWithResponseInit } from "react-router";

// ---------------------------------------------------------------------------
// Action metadata: request-scoped facts attached to every action's data.
// ---------------------------------------------------------------------------

/** The key that holds the metadata in action data. */
export const actionMetaKey = "__meta";

/**
 * Adds optional metadata to a record. Only records get metadata, because a
 * structural type cannot tell a plain object from a class instance, and other
 * values (strings, arrays, `Response`s) have nowhere to put it.
 */
type RecordWithMeta<T, Meta> =
  T extends Record<string, unknown>
    ? Omit<T, typeof actionMetaKey> & { [actionMetaKey]?: Meta }
    : T;

/**
 * The type of action data after metadata is attached. A `data(...)` wrapper
 * gets metadata on its body. With no configured metadata (`Meta` is `never`)
 * the data is unchanged.
 */
export type WithActionMeta<T, Meta> = [Meta] extends [never]
  ? T
  : T extends DataWithResponseInit<infer Body>
    ? DataWithResponseInit<RecordWithMeta<Body, Meta>>
    : RecordWithMeta<T, Meta>;

// React Router exports the type of the `data(...)` wrapper, but not its class.
const DataWithResponseInitClass = data(undefined).constructor;

/** True for a `data(...)` wrapper, never for a business field that looks like one. */
const isDataWithResponseInit = (value: unknown): value is DataWithResponseInit<unknown> =>
  value instanceof DataWithResponseInitClass;

/** True for a plain object, which can be copied without losing behavior. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!Predicate.isObject(value) || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Attaches `meta` to the action result. A plain record gets a copy with the
 * metadata key; a `data(...)` wrapper gets it on its body and keeps its init.
 * Any other value is returned unchanged.
 */
export const attachActionMeta = <T>(value: T, meta: unknown): T => {
  if (isDataWithResponseInit(value)) {
    if (!isPlainRecord(value.data)) return value;
    // The copy has the same shape as `value` plus the metadata key.
    return data({ ...value.data, [actionMetaKey]: meta }, value.init ?? undefined) as T;
  }
  return isPlainRecord(value) ? ({ ...value, [actionMetaKey]: meta } as T) : value;
};
