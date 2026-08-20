import { PGlite } from "@electric-sql/pglite";
import { serveBrowserProvider } from "@hara-lang/hta/provider/browser";
import { createPgliteProvider } from "../packages/db-pglite/index.mjs";

const postgres = createPgliteProvider(PGlite);
serveBrowserProvider(
  (operation, args) => postgres.call("browser", operation, args),
  { errorCode: "db/postgres-error" }
);
