/** `react-router-effect/server`: serve React Router from the Effect HTTP server. */
import "./route-data.ts";

export * as ReactRouterHttp from "./server.ts";
export { ReactRouter } from "./server.ts";
export * as ReactRouterAssets from "./assets.ts";
export type {
  RegisterMismatch,
  RouteEffectCheck,
  RouteEffectFailure,
  RouteEffectFailures,
} from "./check.ts";
