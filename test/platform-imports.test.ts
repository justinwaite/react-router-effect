/**
 * The entries that every platform imports stay free of Node. Only
 * `react-router-effect/vite` may import `node:` modules and
 * `@effect/platform-node`.
 */
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, it } from "vite-plus/test";

/** The packages that an entry for every platform may import. */
const isAllowed = (id: string) =>
  id === "effect" || id.startsWith("effect/") || id === "react-router";

/**
 * The bare imports of an entry and of every module it imports, as Vite's
 * bundler resolves them. The bundler keeps each bare import external.
 */
const bareImportsOf = async (entry: string): Promise<ReadonlyArray<string>> => {
  const imports = new Set<string>();
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: ["es"] },
      rolldownOptions: {
        external: (id) => {
          const bare = !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("\0");
          if (bare) imports.add(id);
          return bare;
        },
      },
    },
  });
  return [...imports].sort();
};

describe("the imports of the platform-neutral entries", () => {
  it.each([
    ["react-router-effect", "../src/index.ts"],
    ["react-router-effect/server", "../src/server-entry.ts"],
  ])("%s imports only effect and react-router", async (_name, entry) => {
    const imports = await bareImportsOf(entry);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((id) => !isAllowed(id))).toEqual([]);
  });

  it("react-router-effect/vite is the entry that imports Node", async () => {
    const imports = await bareImportsOf("../src/vite-entry.ts");
    expect(imports).toContain("@effect/platform-node/NodeHttpServerRequest");
  });
});
