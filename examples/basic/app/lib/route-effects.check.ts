import type { RouteEffectCheck } from "react-router-effect/server";

import type { routeFactory } from "./route-factory.server";

/**
 * Fails to compile when a route's Effect loader, action or middleware can fail
 * with an error the route factory does not handle, needs a service the factory
 * does not provide, or when the `Register` disagrees with the factory. Each
 * error lists the route, the export, and what to handle.
 */
export const routeEffects: RouteEffectCheck<typeof routeFactory> = {};
