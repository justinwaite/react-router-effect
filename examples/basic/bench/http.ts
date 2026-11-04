/**
 * Load-tests the example over HTTP, against the same build and the same
 * route code on several servers. Each server runs in its own process and the
 * load comes from this one. See `serve.ts` for the servers.
 *
 *     vp run build
 *     node bench/http.ts          # the adapter against Express and @react-router/node
 *     node bench/http.ts --gaps   # where Express's and the adapter's time per request goes
 *
 * `BENCH_DURATION` (seconds per case, default 5), `BENCH_ROUNDS` (default
 * 3), `BENCH_CONNECTIONS` (default 50) and `BENCH_SERVERS` (a comma-separated
 * list) tune the run.
 *
 * The servers are single processes that the load saturates, so the time per
 * request is the inverse of the throughput, and differences in it add up.
 * Each round runs every server in turn, and the tables show the median of the
 * rounds, so a slower stretch of the machine does not land on one server.
 */
import { type ChildProcess, spawn } from "node:child_process";

import autocannon from "autocannon";

import { type BenchCase, cases, root } from "./servers.ts";

const gaps = process.argv.includes("--gaps");
const duration = Number(process.env.BENCH_DURATION ?? "5");
const rounds = Number(process.env.BENCH_ROUNDS ?? "3");
const connections = Number(process.env.BENCH_CONNECTIONS ?? "50");
const port = Number(process.env.BENCH_PORT ?? "4410");
const origin = `http://localhost:${port}`;

const servers = (
  process.env.BENCH_SERVERS ??
  (gaps
    ? "node-floor,effect-floor,express-floor,node,express,effect-minimal,adapter"
    : "node,express,adapter")
).split(",");

/** The servers that serve the client build. */
const servesClientFiles = new Set([
  "express",
  "adapter",
  "node-floor",
  "effect-floor",
  "express-floor",
]);

interface Result {
  readonly requests: number;
  readonly p99: number;
  readonly failed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a server process and waits until it answers. */
const start = async (kind: string): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ["bench/serve.ts", kind, String(port)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    const up = await fetch(`${origin}/events/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return child;
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`The ${kind} server did not start`);
};

const stop = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });

const load = (testCase: BenchCase, seconds: number) =>
  autocannon({
    url: `${origin}${testCase.path}`,
    method: (testCase.method ?? "GET") as "GET" | "POST",
    headers: testCase.headers,
    body: testCase.body,
    connections,
    duration: seconds,
  });

/** The cases, and a client file, which the `node` and `effect-minimal` servers do not serve. */
const httpCases: ReadonlyArray<BenchCase & { readonly clientFile?: boolean }> = [
  ...cases(origin),
  { name: "client file (favicon.svg)", path: "/favicon.svg", clientFile: true },
];

/** Every round's result, by case, then by server. */
const runs = new Map<string, Map<string, Array<Result>>>();

for (let round = 1; round <= rounds; round++) {
  for (const kind of servers) {
    const child = await start(kind);
    for (const testCase of httpCases) {
      if (testCase.clientFile === true && !servesClientFiles.has(kind)) continue;
      // A short warm-up lets the JIT settle before the measured run.
      await load(testCase, 1);
      const run = await load(testCase, duration);
      const byServer = runs.get(testCase.name) ?? new Map<string, Array<Result>>();
      byServer.set(kind, [
        ...(byServer.get(kind) ?? []),
        {
          requests: run.requests.average,
          p99: run.latency.p99,
          failed: run.errors + run.timeouts + run.non2xx,
        },
      ]);
      runs.set(testCase.name, byServer);
      console.error(
        `round ${round}: ${kind}: ${testCase.name}: ${Math.round(run.requests.average)} req/s`,
      );
    }
    await stop(child);
  }
}

/** The median of the rounds: by throughput, with that round's p99 and the failures of all. */
const median = (results: ReadonlyArray<Result> | undefined): Result | undefined => {
  if (results === undefined || results.length === 0) return undefined;
  const sorted = [...results].sort((a, b) => a.requests - b.requests);
  const middle = sorted[Math.floor(sorted.length / 2)] as Result;
  return { ...middle, failed: results.reduce((sum, result) => sum + result.failed, 0) };
};

const results = new Map(
  [...runs].map(([name, byServer]) => [
    name,
    new Map([...byServer].map(([kind, list]) => [kind, median(list)])),
  ]),
);

/** Microseconds of server time per request. */
const micros = (result: Result | undefined) =>
  result === undefined || result.requests === 0 ? Number.NaN : 1e6 / result.requests;

const cell = (result: Result | undefined) =>
  result === undefined
    ? "–"
    : `${Math.round(result.requests)} req/s, ${Math.round(micros(result))} µs, p99 ${result.p99} ms${
        result.failed > 0 ? `, ${result.failed} failed` : ""
      }`;

console.log(
  `\n${connections} connections, ${duration}s per case, median of ${rounds} rounds, Node ${process.version}\n`,
);
console.log(
  [
    `| Case | ${servers.join(" | ")} |`,
    `| --- |${servers.map(() => " --- |").join("")}`,
    ...[...results].map(
      ([name, byServer]) =>
        `| ${name} | ${servers.map((kind) => cell(byServer.get(kind))).join(" | ")} |`,
    ),
  ].join("\n"),
);

if (gaps) {
  const signed = (value: number) =>
    Number.isNaN(value) ? "–" : `${value >= 0 ? "+" : ""}${Math.round(value)}`;
  const pair = (express: number, adapter: number) => `${signed(express)} / ${signed(adapter)} µs`;
  console.log(
    "\nTime per request against @react-router/node, Express / the adapter. The floors answer\n" +
      "every case alike, so their difference to `node-floor` is the server's own cost. The\n" +
      "conversion is the rest of the difference to `@react-router/node` for Express, and to\n" +
      "`effect-minimal` for the adapter, whose own work is the difference between the two.\n\n" +
      "| Case | Total | The server | Its request and response against Web ones | The adapter's own work |\n" +
      "| --- | --- | --- | --- | --- |\n" +
      [...results]
        .filter(([name]) => !name.startsWith("client file"))
        .map(([name, byServer]) => {
          const at = (kind: string) => micros(byServer.get(kind));
          const expressServer = at("express-floor") - at("node-floor");
          const effectServer = at("effect-floor") - at("node-floor");
          const expressTotal = at("express") - at("node");
          const adapterTotal = at("adapter") - at("node");
          const expressConversion = expressTotal - expressServer;
          const effectConversion = at("effect-minimal") - at("node") - effectServer;
          const adapter = at("adapter") - at("effect-minimal");
          return `| ${name} | ${pair(expressTotal, adapterTotal)} | ${pair(expressServer, effectServer)} | ${pair(expressConversion, effectConversion)} | ${signed(adapter)} µs |`;
        })
        .join("\n"),
  );
}
