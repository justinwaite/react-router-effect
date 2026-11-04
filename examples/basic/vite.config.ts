import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // Tests and benchmarks run against the production build, so Vitest does not
  // load React Router's plugin.
  plugins: process.env.VITEST === undefined ? [reactRouter()] : [],
  // The server build is the Effect server, which imports the React Router build.
  environments: { ssr: { build: { rollupOptions: { input: "./server/main.ts" } } } },
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    benchmark: { include: ["bench/**/*.bench.ts"] },
  },
});
