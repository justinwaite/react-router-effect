import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The tests start Vite as a child process, so Vitest does not load the app's plugins.
  plugins:
    process.env.VITEST === undefined
      ? [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter()]
      : [],
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
