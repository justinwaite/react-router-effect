import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { childEnv } from "./server-process";

/** Builds the app once: the tests and benchmarks run against the production build. */
export default function setup() {
  if (process.env.EXAMPLE_SKIP_BUILD === "1") return;
  execFileSync("node_modules/.bin/react-router", ["build"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: childEnv({ NODE_ENV: "production" }),
    stdio: "ignore",
  });
}
