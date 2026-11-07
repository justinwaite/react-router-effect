/**
 * The Worker. Effect's `HttpRouter.toWebHandler` serves `App`, as
 * `HttpRouter.serve` serves it on Node. The handler builds once, at module
 * scope, and in production the layer loads the build then.
 */
import { Context } from "effect";
import { HttpRouter } from "effect/http";

import { WorkerExecutionContext } from "../app/lib/services.server";
import { App } from "../server/app";

// Without `disableLogger`, Effect logs every request to the Worker's console.
const app = HttpRouter.toWebHandler(App, { disableLogger: true });

export default {
  // Route Effects read the execution context as a service of the request.
  fetch: (request, _env, ctx) => app.handler(request, Context.make(WorkerExecutionContext, ctx)),
} satisfies ExportedHandler<Env>;
