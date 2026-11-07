import { stats } from "../lib/services.server";

/** What the isolate saw, for the tests. */
export const loader = () => Response.json(stats);
