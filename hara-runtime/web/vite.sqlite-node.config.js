import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = dirname(fileURLToPath(import.meta.url));
const sqlite = resolve(
  web,
  "../extensions/std-db-sqlite/node_modules/@sqlite.org/sqlite-wasm/node.mjs"
);

export default defineConfig({
  resolve: {
    alias: {
      "@sqlite.org/sqlite-wasm": sqlite,
      "@hara-lang/db-sqlite": resolve(web, "packages/db-sqlite/index.mjs")
    }
  },
  build: {
    target: "node18",
    outDir: "dist-sqlite-node",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(web, "entries/sqlite-node.mjs"),
      formats: ["es"],
      fileName: () => "worker.mjs"
    },
    rollupOptions: {
      external: ["module", "node:fs/promises", "node:path", "../vendor/sqlite/node.mjs"],
      output: {
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
