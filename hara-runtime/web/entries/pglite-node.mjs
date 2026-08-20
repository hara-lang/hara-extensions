import { PGlite } from "@electric-sql/pglite";
import { serveNodeProvider } from "@hara-lang/hta/provider/node";
import { createPgliteProvider } from "../packages/db-pglite/index.mjs";

const postgres = createPgliteProvider(PGlite);
serveNodeProvider(
  (operation, args) => postgres.call("node", operation, args),
  { errorCode: "db/postgres-error" }
);
