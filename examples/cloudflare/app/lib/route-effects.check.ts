import type { RouteEffectCheck } from "react-router-effect/worker";

import type { routeFactory } from "./route-factory.server";

/**
 * Fails to compile when a route Effect can fail with an error the factory does
 * not handle, or needs a service it does not provide.
 */
export const routeEffects: RouteEffectCheck<typeof routeFactory> = {};
