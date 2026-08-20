package hara.db.sqlite.jvm;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/** Operational-store dispatch kept behind the same provider call used by SQLite-WASM. */
final class WorkStore {
  private WorkStore() {}

  static Object call(Connection connection, Object operationValue, Object arguments)
      throws SQLException {
    String operation = SqliteProvider.name(operationValue);
    synchronized (connection) {
      if ("migrate".equals(operation)) return migrate(connection);
      throw new UnsupportedOperationException(
          "work/store-operation-unavailable: db.sqlite.jvm/" + operation);
    }
  }

  private static Object migrate(Connection connection) throws SQLException {
    try (Statement statement = connection.createStatement()) {
      statement.execute("PRAGMA foreign_keys = ON");
      statement.execute("PRAGMA busy_timeout = 5000");
      statement.execute("CREATE TABLE IF NOT EXISTS work_schema_versions "
          + "(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      statement.execute("INSERT OR IGNORE INTO work_schema_versions(version, applied_at) "
          + "VALUES (1, unixepoch('now') * 1000)");
      try (ResultSet rows = statement.executeQuery(
          "SELECT COALESCE(MAX(version), 0) FROM work_schema_versions")) {
        rows.next();
        long version = rows.getLong(1);
        if (version > 1) throw new IllegalStateException("work/store-schema-future: " + version);
      }
    }
    return SqliteProvider.map("schema/version", 1L);
  }
}
