import { createContext } from "react-router";

/** The Worker's env, for promise route functions. `loadContext` in `server/app.ts` sets it. */
export const workerEnvContext = createContext<Env>();
