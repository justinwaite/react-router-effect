import { createContext } from "react-router";
import type { ReactRouterWorker } from "react-router-effect/worker";

/** The Worker's env and execution context, for promise route functions. */
export const cloudflareContext = createContext<{
  readonly env: Env;
  readonly ctx: ReactRouterWorker.ExecutionContextLike;
}>();
