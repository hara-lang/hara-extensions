import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageDbProvider } from "./package-db-provider.mjs";

const web = dirname(fileURLToPath(import.meta.url));
const repository = resolve(web, "../../..");
const source = process.env.HARA_SQLITE_SOURCE
  ? resolve(process.env.HARA_SQLITE_SOURCE)
  : resolve(repository, "hara-runtime/extensions/std-db-sqlite");
const output = process.env.HARA_SQLITE_OUTPUT
  ? resolve(process.env.HARA_SQLITE_OUTPUT)
  : resolve(source, "target/package/std/db/provider/sqlite");

const packaged = await packageDbProvider({
  source,
  output,
  nodeBuild: resolve(web, "dist-sqlite-node"),
  browserBuild: resolve(web, "dist-sqlite-browser"),
  additionalAssets: [
    {
      source: resolve(source, "node_modules/@sqlite.org/sqlite-wasm/node.mjs"),
      destination: "vendor/sqlite/node.mjs"
    },
    {
      source: resolve(source, "node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3-node.mjs"),
      destination: "vendor/sqlite/sqlite-wasm/jswasm/sqlite3-node.mjs"
    },
    {
      source: resolve(source, "node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm"),
      destination: "vendor/sqlite/sqlite-wasm/jswasm/sqlite3.wasm"
    }
  ]
});
console.log(`${packaged.output} (${packaged.assets.length} assets)`);
