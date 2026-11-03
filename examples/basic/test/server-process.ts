import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

/** The example's directory. */
export const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The environment of a child process, without Vitest's variables: the Vite
 * config leaves React Router's plugin out under Vitest.
 */
export const childEnv = (env: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))),
  ...env,
});

/** A port nothing listens on. */
export const freePort = () =>
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
  /** Sends SIGTERM and resolves with the exit code once the server exits. */
  readonly stop: () => Promise<number | null>;
}

/** Starts `node server.js` and waits until it answers. */
export const startServer = async (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<ServerProcess> => {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["server.js", ...args], {
    cwd: root,
    env: childEnv({ ...env, PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const origin = `http://localhost:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch(`${origin}/events/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) break;
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`The server did not start:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    origin,
    output: () => output,
    stop: () => {
      child.kill("SIGTERM");
      return exited;
    },
  };
};

/** Reads a streamed body chunk by chunk, with the time each chunk arrived. */
export const readChunks = async (response: Response) => {
  const started = performance.now();
  const chunks: Array<{ readonly text: string; readonly at: number }> = [];
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (reader === undefined) return chunks;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push({
      text: decoder.decode(chunk.value, { stream: true }),
      at: performance.now() - started,
    });
  }
  return chunks;
};
