// Starts the server: through Vite in development (`--dev`), from the build otherwise.
import process from "node:process";

const port = Number(process.env.PORT ?? "3000");

if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true } });
  const { main } = await vite.ssrLoadModule("./server/main.ts");
  main({ port, vite });
} else {
  const { main } = await import("./build/server/index.js");
  main({ port });
}
