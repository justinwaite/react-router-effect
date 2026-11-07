import { stats } from "../lib/services.server";

/** What the Worker's isolate saw, for the tests. */
export const loader = () => Response.json(stats);
