import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";

const web = dirname(fileURLToPath(import.meta.url));
const pglite = resolve(
  web,
  "../node_modules/@electric-sql/pglite/dist/index.js"
);
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`)
]);

export default defineConfig({
  resolve: {
    alias: {
      "@electric-sql/pglite": pglite
    }
  },
  build: {
    target: "node18",
    outDir: "dist-pglite-node",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    lib: {
      entry: resolve(web, "entries/pglite-node.mjs"),
      formats: ["es"],
      fileName: () => "worker.mjs"
    },
    rollupOptions: {
      external: id => id === "@electric-sql/pglite" || nodeBuiltins.has(id),
      output: {
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
