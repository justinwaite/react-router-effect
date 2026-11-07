/** `react-router-effect/worker`: serve React Router from a Cloudflare Worker. */
import "./route-data.ts";

export * as ReactRouterWorker from "./worker.ts";
export { WorkerContext } from "./worker.ts";
export type {
  RegisterMismatch,
  RouteEffectCheck,
  RouteEffectFailure,
  RouteEffectFailures,
} from "./check.ts";
