import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

/** The example's directory. */
// `.href`: the Worker types replace the global `URL`, which Node's `fileURLToPath` does not take.
export const root = fileURLToPath(new URL("..", import.meta.url).href);

/**
 * The environment of a child process, without Vitest's variables and without
 * the `NODE_ENV` that Vitest sets: the Vite config leaves the app's plugins
 * out under Vitest, and each tool sets `NODE_ENV` itself. Node leaves out a
 * variable whose value is `undefined`.
 */
export const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  ...Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("VITEST"))
      .map((key) => [key, undefined]),
  ),
  NODE_ENV: undefined,
});

/** A port nothing listens on. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(),
      );
    });
  });

export interface ServerProcess {
  readonly origin: string;
  readonly output: () => string;
  /** Stops the server, and kills it if it is still running after 15 seconds. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts the Worker in workerd with `bin` (`vp preview` for the production
 * build, `react-router dev` for development) and waits until it answers.
 */
export const startServer = async (
  bin: string,
  args: ReadonlyArray<string>,
): Promise<ServerProcess> => {
  const port = await freePort();
  const child: ChildProcess = spawn(
    `node_modules/.bin/${bin}`,
    [...args, "--port", String(port), "--strictPort"],
    { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const group = child.pid;
  if (group === undefined) throw new Error(`Could not start ${bin}`);
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // Vite listens on `localhost`, which can resolve to IPv6 only.
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(`${origin}/stats`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (child.exitCode !== null || Date.now() > deadline) {
      process.kill(-group, "SIGKILL");
      throw new Error(`The server did not start:\n${output}`);
    }
    await delay(200);
  }
  return {
    origin,
    output: () => output,
    stop: async () => {
      // The whole process group: Vite starts workerd as a child process.
      process.kill(-group, "SIGTERM");
      const wait = new AbortController();
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(15_000, false, { signal: wait.signal }).catch(() => false),
      ]);
      wait.abort();
      if (!stopped) process.kill(-group, "SIGKILL");
    },
  };
};

/** What the Worker's isolate saw, from `/stats`. */
const Stats = Schema.Struct({
  opened: Schema.Finite,
  closed: Schema.Finite,
  background: Schema.Finite,
});

export type Stats = typeof Stats.Type;

/** Reads `/stats` until `done` holds, or 5 seconds pass. */
export const statsUntil = async (
  origin: string,
  done: (stats: Stats) => boolean,
): Promise<Stats> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const stats = await Schema.decodeUnknownPromise(Stats)(
      await (await fetch(`${origin}/stats`)).json(),
    );
    if (done(stats) || Date.now() > deadline) return stats;
    await delay(50);
  }
};

/** A browser's user agent: React Router's default entry streams to it. */
export const browser =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
