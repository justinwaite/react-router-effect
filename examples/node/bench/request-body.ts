/**
 * The cost of a request body: turning Node's request stream into the body of
 * the Web `Request` React Router gets, and reading its form data. Each
 * variant is a server in its own process that does only that, so the
 * differences between them are the cost of the body path alone:
 *
 * - `node`: `node:http` with React Router's `createReadableStreamFromReadable`,
 *   as `@react-router/node` reads a body.
 * - `effect-pump`: Effect's Node HTTP server with the same function, as the
 *   adapter reads a body.
 * - `effect-iterator`: Effect's server with a Web stream over Node's async
 *   iterator.
 * - `effect-node-to-web`: Effect's server with Node's `Readable.toWeb`.
 * - `effect-to-web`: Effect's server with `HttpServerRequest.toWeb`, which
 *   reads the body through an Effect stream.
 *
 *     node bench/request-body.ts
 *
 * It measures each server's CPU time per request for sequential requests,
 * which leaves out the time a server waits, and its throughput under 50
 * connections. Each round runs every variant in turn; the result is the
 * median of `ROUNDS` (default 3).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as Http from "node:http";
import { Readable } from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { createReadableStreamFromReadable } from "@react-router/node";
import autocannon from "autocannon";
import { Effect, Layer } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

const urlOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

const nodeRequest = (
  request: HttpServerRequest.HttpServerRequest,
  body: (incoming: Http.IncomingMessage) => ReadableStream<Uint8Array>,
) =>
  Effect.sync(
    () =>
      new Request(urlOf(request), {
        method: request.method,
        headers: request.headers,
        body: body(NodeHttpServerRequest.toIncomingMessage(request) as Http.IncomingMessage),
        duplex: "half",
      } as RequestInit),
  );

const iteratorBody = (incoming: Http.IncomingMessage) => {
  const chunks = incoming[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await chunks.next();
      if (chunk.done === true) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel() {
      incoming.destroy();
    },
  });
};

const effectVariants: Record<
  string,
  (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<Request, unknown>
> = {
  "effect-pump": (request) => nodeRequest(request, createReadableStreamFromReadable),
  "effect-iterator": (request) => nodeRequest(request, iteratorBody),
  "effect-node-to-web": (request) =>
    nodeRequest(request, (incoming) => Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
  "effect-to-web": (request) => HttpServerRequest.toWeb(request),
};

/** The title the client posts. */
const titleOf = (form: FormData) => {
  const title = form.get("title");
  return typeof title === "string" ? title : "";
};

const cpu = () => JSON.stringify(process.cpuUsage());

const serve = (variant: string, port: number) => {
  if (variant === "node") {
    Http.createServer(async (req, res) => {
      if (req.method === "GET") {
        res.end(cpu());
        return;
      }
      const web = new Request(new URL(req.url ?? "/", `http://${req.headers.host}`), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: createReadableStreamFromReadable(req),
        duplex: "half",
      } as RequestInit);
      const form = await web.formData();
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(titleOf(form));
    }).listen(port);
    return;
  }
  const toRequest = effectVariants[variant];
  if (toRequest === undefined) throw new Error(`Unknown variant ${variant}`);
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "GET") return HttpServerResponse.text(cpu());
    const web = yield* toRequest(request);
    const form = yield* Effect.promise(() => web.formData());
    return HttpServerResponse.text(titleOf(form));
  });
  NodeRuntime.runMain(
    Layer.launch(
      HttpServer.serve(app).pipe(
        Layer.provide(NodeHttpServer.layer(() => Http.createServer(), { port })),
      ),
    ),
  );
};

if (process.argv[2] === "serve") {
  serve(process.argv[3] ?? "", Number(process.argv[4]));
} else {
  const variants = ["node", ...Object.keys(effectVariants)];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const children = new Map<string, { child: ChildProcess; origin: string }>();
  for (const [index, variant] of variants.entries()) {
    const port = 4500 + index;
    const child = spawn(process.execPath, [import.meta.filename, "serve", variant, String(port)], {
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "inherit",
    });
    children.set(variant, { child, origin: `http://localhost:${port}` });
  }
  await sleep(1500);

  const agent = new Http.Agent({ keepAlive: true, maxSockets: 1 });
  const post = (origin: string) =>
    new Promise<void>((resolve, reject) => {
      const request = Http.request(
        `${origin}/`,
        {
          method: "POST",
          agent,
          headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "15" },
        },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      request.on("error", reject);
      request.end("title=benchmark");
    });
  const cpuOf = async (origin: string) => {
    const usage = (await (await fetch(`${origin}/`)).json()) as { user: number; system: number };
    return usage.user + usage.system;
  };

  const sequential = Number(process.env.ITERATIONS ?? "10000");
  const results = new Map<string, { cpu: Array<number>; throughput: Array<number> }>(
    variants.map((variant) => [variant, { cpu: [], throughput: [] }]),
  );
  for (let round = 0; round < Number(process.env.ROUNDS ?? "3"); round++) {
    for (const variant of variants) {
      const { origin } = children.get(variant) ?? { origin: "" };
      for (let warm = 0; warm < 1000; warm++) await post(origin);
      const before = await cpuOf(origin);
      for (let index = 0; index < sequential; index++) await post(origin);
      results.get(variant)?.cpu.push(((await cpuOf(origin)) - before) / sequential);
      const run = await autocannon({
        url: `${origin}/`,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=benchmark",
        connections: 50,
        duration: Number(process.env.DURATION ?? "4"),
      });
      results.get(variant)?.throughput.push(run.requests.average);
    }
  }
  const median = (values: ReadonlyArray<number>) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
  for (const [variant, { cpu, throughput }] of results) {
    console.log(
      `${variant.padEnd(20)} CPU ${median(cpu).toFixed(1)} µs/request (${cpu.map((v) => v.toFixed(1)).join(", ")}), ` +
        `${Math.round(median(throughput))} req/s = ${(1e6 / median(throughput)).toFixed(1)} µs (${throughput.map(Math.round).join(", ")})`,
    );
  }
  for (const { child } of children.values()) child.kill("SIGTERM");
  process.exit(0);
}
