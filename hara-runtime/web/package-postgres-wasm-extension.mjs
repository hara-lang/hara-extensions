import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDbProvider } from "./package-db-provider.mjs";

const web = dirname(fileURLToPath(import.meta.url));
const repository = resolve(web, "../..");
const source = process.env.HARA_PGLITE_SOURCE
  ? resolve(process.env.HARA_PGLITE_SOURCE)
  : resolve(repository, "hara-runtime/extensions/db-postgres-wasm");
const output = process.env.HARA_PGLITE_OUTPUT
  ? resolve(process.env.HARA_PGLITE_OUTPUT)
  : resolve(source, "target/package/db/postgres/wasm/hta");

const packaged = await packageDbProvider({
  source,
  output,
  nodeBuild: resolve(web, "dist-pglite-node"),
  browserBuild: resolve(web, "dist-pglite-browser"),
  additionalAssets: [
    {
      source: resolve(source, "src/db/node/driver/postgres_wasm.hal"),
      destination: "src/db/node/driver/postgres_wasm.hal"
    },
    {
      source: resolve(web, "../node_modules/@electric-sql/pglite"),
      destination: "node_modules/@electric-sql/pglite"
    }
  ]
});
console.log(`${packaged.output} (${packaged.assets.length} assets)`);
