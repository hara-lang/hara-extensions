import sqlite3InitModule from "../vendor/sqlite/node.mjs";
import { serveNodeProvider } from "@hara-lang/hta/provider/node";
import { createSqliteProvider } from "@hara-lang/db-sqlite";
import { nodeFileSystem } from "../packages/db-sqlite/node-filesystem.mjs";

const sqlite = createSqliteProvider(sqlite3InitModule, { fileSystem: nodeFileSystem });
serveNodeProvider(
  (operation, args) => sqlite.call("node", operation, args),
  { errorCode: "db/sqlite-error" }
);
