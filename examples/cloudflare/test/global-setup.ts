import { execFileSync } from "node:child_process";

import { childEnv, root } from "./server-process";

/** Builds the app once: the production tests run against the build. */
export default function setup() {
  if (process.env.EXAMPLE_SKIP_BUILD === "1") return;
  execFileSync("node_modules/.bin/react-router", ["build"], {
    cwd: root,
    env: childEnv(),
    stdio: "ignore",
  });
}
