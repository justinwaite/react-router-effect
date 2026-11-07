import type { Effect } from "effect";
import type { Register as RouterRegister } from "react-router";

import type { ReturnableDataError } from "./errors.ts";
import type { FactoryTypes, FailureResponse, IsAny, LibraryHandled, NameError } from "./factory.ts";
import type { RegisteredMeta, RegisteredRecover } from "./route-data.ts";

// ---------------------------------------------------------------------------
// The route check: every Effect a route module exports must be fully handled.
// ---------------------------------------------------------------------------

/** The route modules React Router's typegen registers, keyed by route ID. */
type RegisteredRouteModules = RouterRegister extends { readonly routeModules: infer Modules }
  ? Modules
  : {};

/** What an effect middleware may succeed with: React Router's response, or nothing. */
type MiddlewareResult = Response | void | undefined;

/** What a failure says to do, under its `react-router-effect` key. */
type FailureMessage =
  "This route Effect can fail with an error the route factory does not handle, or needs a service it does not provide. Catch the error in the Effect (for example with Effect.catchTag), add it to the factory's domain errors, or provide the service.";

/**
 * One export that fails the check. `unhandledErrors` lists each error the
 * effect can fail with that the factory does not handle, by its `_tag`.
 * `missingServices` lists each service that neither the runtime nor the
 * request context provides. `invalidResults` lists what a middleware succeeds
 * with that is not a `Response` or nothing.
 *
 * It is an inline object type, not an interface, so the compiler prints its
 * fields in the error rather than an alias name.
 *
 * @stability unstable
 */
export type RouteEffectFailure<Route, Export, Unhandled, Missing, Invalid> = {
  readonly "react-router-effect": FailureMessage;
  readonly route: Route;
  readonly export: Export;
  readonly unhandledErrors: Unhandled;
  readonly missingServices: Missing;
  readonly invalidResults: Invalid;
};

/**
 * The failure of one route function, or `never` when it does not return an
 * Effect or when its Effect is fully handled. An Effect whose error or
 * service type is `any` comes from a mistake TypeScript already reports, so it
 * is skipped rather than reported a second time.
 */
type FunctionFailure<Route, Export, F, Handled, Provided, Result> = F extends (
  ...args: never[]
) => Effect.Effect<infer A, infer E, infer R>
  ? true extends IsAny<E> | IsAny<R>
    ? never
    : [Exclude<E, Handled>, Exclude<R, Provided>, Exclude<A, Result>] extends [never, never, never]
      ? never
      : {
          // Inline, not `RouteEffectFailure`, so the compiler prints the fields.
          readonly "react-router-effect": FailureMessage;
          readonly route: Route;
          readonly export: Export;
          readonly unhandledErrors: NameError<Exclude<E, Handled>>;
          readonly missingServices: Exclude<R, Provided>;
          readonly invalidResults: Exclude<A, Result>;
        }
  : never;

/** The failures of one route module's loader, action and middleware. */
type ModuleFailures<Route, Module, Handled, Provided> =
  | (Module extends { readonly loader: infer F }
      ? FunctionFailure<Route, "loader", F, Handled, Provided, unknown>
      : never)
  | (Module extends { readonly action: infer F }
      ? FunctionFailure<Route, "action", F, Handled, Provided, unknown>
      : never)
  | (Module extends { readonly middleware: ReadonlyArray<infer F> }
      ? FunctionFailure<
          Route,
          "middleware",
          F,
          Handled | FailureResponse,
          Provided,
          MiddlewareResult
        >
      : never);

/** The failures of every registered route module. */
type AllFailures<Modules, Handled, Provided> = {
  [Route in keyof Modules]: ModuleFailures<Route, Modules[Route], Handled, Provided>;
}[keyof Modules];

/** The types of a route factory. */
type TypesOf<Factory> = Factory extends { readonly "~types": infer Types } ? Types : never;

/** What one error handler's return recovers into, or `never` when it throws. */
type HandlerRecovered<Return> =
  Return extends ReturnableDataError<infer Body>
    ? Body
    : Return extends Effect.Effect<infer Success, infer _E, infer _R>
      ? Success
      : never;

/** The factory's recover map: each error tag whose handler recovers, and its data. */
type FactoryRecover<Returns> = {
  [
    Tag in keyof Returns as [HandlerRecovered<Returns[Tag]>] extends [never] ? never : Tag
  ]: HandlerRecovered<Returns[Tag]>;
};

/** True when each type is assignable to the other. */
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * A disagreement between the `Register` of `react-router-effect` and the
 * factory, which would type plain Effect routes' data wrongly.
 *
 * @stability unstable
 */
export interface RegisterMismatch<Key, Factory, Registered> {
  readonly register: Key;
  readonly factory: Factory;
  readonly registered: Registered;
}

/** The registration mismatches of a factory's types. */
type RegisterMismatches<Returns, Meta> =
  | (SameType<FactoryRecover<Returns>, RegisteredRecover> extends true
      ? never
      : RegisterMismatch<"recover", FactoryRecover<Returns>, RegisteredRecover>)
  | (SameType<Meta, RegisteredMeta> extends true
      ? never
      : RegisterMismatch<"actionMeta", Meta, RegisteredMeta>);

/** Every failure: the routes', then the registration's. */
type Failures<Modules, Types> =
  Types extends FactoryTypes<infer DomainError, infer Returns, infer Services, infer Meta>
    ?
        | AllFailures<Modules, LibraryHandled<DomainError>, Services>
        | RegisterMismatches<Returns, Meta>
    : never;

/**
 * The failures of every Effect route function across the route modules React
 * Router's typegen registers, and the registration mismatches, as objects.
 * `never` when everything is handled. `RouteEffectCheck` reports them.
 *
 * @stability unstable
 */
export type RouteEffectFailures<Factory, Modules = RegisteredRouteModules> = Failures<
  Modules,
  TypesOf<Factory>
>;

/** A printable name for an error tag or another unhandled error type. */
type ErrorName<Name> = Name extends string ? Name : "an untagged error";

/** A printable name for a service: its key, such as `"app/Database"`. */
type ServiceName<Service> = Service extends { readonly key: infer Key extends string }
  ? Key
  : "a service without a string key";

/** The diagnostic lines of one failure, one per error, service or result. */
type FailureLines<Failure> = Failure extends {
  readonly route: infer Route extends string | number | symbol;
  readonly export: infer Export extends string;
  readonly unhandledErrors: infer Unhandled;
  readonly missingServices: infer Missing;
  readonly invalidResults: infer Invalid;
}
  ?
      | (Unhandled extends unknown
          ? `${Route & string}#${Export} must handle ${ErrorName<Unhandled>}`
          : never)
      | (Missing extends unknown
          ? `${Route & string}#${Export} needs a provider for ${ServiceName<Missing>}`
          : never)
      | ([Invalid] extends [never]
          ? never
          : `${Route & string}#${Export} must succeed with a Response or nothing`)
  : Failure extends { readonly register: infer Key extends string }
    ? `the Register of react-router-effect: ${Key} does not match the route factory`
    : never;

/**
 * Checks every loader, action and middleware that returns an Effect, across
 * the route modules React Router's typegen registers. Each failure is a
 * required property whose name says what to fix, so assigning `{}` fails to
 * compile with a list such as:
 *
 * ```text
 * Type '{}' is missing the following properties from type ...:
 *   "routes/billing#loader must handle PlaidApiError",
 *   "routes/admin#middleware needs a provider for app/Session"
 * ```
 *
 * ```ts
 * import type { RouteEffectCheck } from "react-router-effect/server";
 *
 * export const routeEffects: RouteEffectCheck<typeof routeFactory> = {};
 * ```
 *
 * An Effect may fail with the factory's domain errors, the library's `Respond`
 * errors, and `HttpServerRespondable` errors, and require the services of the
 * factory's runtime and request context. A middleware may also fail with what
 * its `next()` fails with. The check also fails when the `Register` of
 * `react-router-effect` disagrees with the factory.
 *
 * @stability unstable
 */
export type RouteEffectCheck<Factory, Modules = RegisteredRouteModules> = {
  readonly [Line in FailureLines<RouteEffectFailures<Factory, Modules>>]: Line;
};
