package hara.db.sqlite.jvm;

import hara.lang.data.Keyword;
import hara.lang.data.types.ILinearType;
import hara.lang.data.types.IMapType;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/** JVM implementation of the explicit db.sqlite provider boundary. */
public final class SqliteProvider {
  private static final AtomicLong NEXT_ID = new AtomicLong(1);
  private static final ConcurrentHashMap<Long, Connection> CONNECTIONS = new ConcurrentHashMap<>();

  private SqliteProvider() {}

  public static Object call(Object operationValue, Object... arguments) {
    String operation = name(operationValue);
    try {
      return switch (operation) {
        case "version" -> version();
        case "open" -> open(arguments.length == 0 ? null : arguments[0]);
        case "exec" -> exec(number(arguments[0]), String.valueOf(arguments[1]), arguments[2]);
        case "query" -> query(number(arguments[0]), String.valueOf(arguments[1]), arguments[2]);
        case "work-call" -> WorkStore.call(connection(number(arguments[0])), arguments[1], arguments[2]);
        case "close" -> close(number(arguments[0]));
        default -> throw new IllegalArgumentException("db/sqlite-operation-unknown: " + operation);
      };
    } catch (SQLException error) {
      throw new IllegalStateException("db/sqlite-jvm-error: " + error.getMessage(), error);
    }
  }

  private static Object version() throws SQLException {
    try (Connection value = DriverManager.getConnection("jdbc:sqlite::memory:");
         Statement statement = value.createStatement();
         ResultSet rows = statement.executeQuery("select sqlite_version()")) {
      rows.next();
      return map("engine", kw("sqlite"), "provider", kw("sqlite-jvm"),
                 "version", rows.getString(1));
    }
  }

  private static Object open(Object options) throws SQLException {
    String storage = name(get(options, "storage", kw("memory")));
    String filename = String.valueOf(get(options, "filename", ":memory:"));
    if ("opfs".equals(storage)) {
      throw new IllegalArgumentException("db/sqlite-storage-unsupported: opfs is browser-only");
    }
    String url;
    if ("memory".equals(storage) || "transient".equals(storage)) {
      filename = ":memory:";
      url = "jdbc:sqlite::memory:";
    } else if ("filesystem".equals(storage)) {
      url = "jdbc:sqlite:" + filename;
    } else {
      throw new IllegalArgumentException("db/sqlite-storage-unsupported: " + storage);
    }
    Connection value = DriverManager.getConnection(url);
    long id = NEXT_ID.getAndIncrement();
    CONNECTIONS.put(id, value);
    return map("id", id, "engine", kw("sqlite"), "provider", kw("sqlite-jvm"),
               "storage", kw(storage), "filename", filename);
  }

  private static Object exec(long id, String sql, Object parameters) throws SQLException {
    Connection value = connection(id);
    synchronized (value) {
      try (PreparedStatement statement = value.prepareStatement(sql)) {
        bind(statement, parameters);
        int changes = statement.executeUpdate();
        return map("changes", (long) changes);
      }
    }
  }

  private static Object query(long id, String sql, Object parameters) throws SQLException {
    Connection value = connection(id);
    synchronized (value) {
      try (PreparedStatement statement = value.prepareStatement(sql)) {
        bind(statement, parameters);
        try (ResultSet rows = statement.executeQuery()) {
          ResultSetMetaData metadata = rows.getMetaData();
          List<Object> output = new ArrayList<>();
          while (rows.next()) {
            LinkedHashMap<Object, Object> row = new LinkedHashMap<>();
            for (int index = 1; index <= metadata.getColumnCount(); index++) {
              row.put(metadata.getColumnLabel(index), sqlValue(rows.getObject(index)));
            }
            output.add(row);
          }
          return canonical(output);
        }
      }
    }
  }

  private static boolean close(long id) throws SQLException {
    Connection value = CONNECTIONS.remove(id);
    if (value == null) return false;
    synchronized (value) { value.close(); }
    return true;
  }

  static Connection connection(long id) {
    Connection value = CONNECTIONS.get(id);
    if (value == null) throw new IllegalStateException("db/sqlite-connection-closed: " + id);
    return value;
  }

  static void bind(PreparedStatement statement, Object values) throws SQLException {
    int index = 1;
    if (values instanceof Iterable<?> iterable) {
      for (Object value : iterable) statement.setObject(index++, jdbcValue(value));
    } else if (values != null) {
      throw new IllegalArgumentException("db/sqlite-parameters-invalid: expected a vector");
    }
  }

  static Object jdbcValue(Object value) {
    if (value instanceof Keyword keyword) return keyword.getName();
    if (value instanceof Boolean booleanValue) return booleanValue ? 1L : 0L;
    return value;
  }

  static Object sqlValue(Object value) {
    if (value instanceof Integer integer) return integer.longValue();
    if (value instanceof Short shortValue) return shortValue.longValue();
    if (value instanceof Byte byteValue) return byteValue.longValue();
    return value;
  }

  static long number(Object value) { return ((Number) value).longValue(); }
  static Keyword kw(String value) { return Keyword.create(value); }
  static String name(Object value) {
    return value instanceof Keyword keyword ? keyword.getName() : String.valueOf(value);
  }

  @SuppressWarnings("unchecked")
  static Object get(Object value, String key, Object fallback) {
    if (value instanceof IMapType<?, ?> map) {
      Object found = ((IMapType<Object, Object>) map).lookup(kw(key), fallback);
      return found == fallback ? ((IMapType<Object, Object>) map).lookup(key, fallback) : found;
    }
    if (value instanceof Map<?, ?> map) {
      if (map.containsKey(kw(key))) return map.get(kw(key));
      return map.containsKey(key) ? map.get(key) : fallback;
    }
    return fallback;
  }

  static Object map(Object... entries) {
    LinkedHashMap<Object, Object> output = new LinkedHashMap<>();
    for (int index = 0; index < entries.length; index += 2) {
      output.put(kw(String.valueOf(entries[index])), entries[index + 1]);
    }
    return canonical(output);
  }

  static Object canonical(Object value) {
    return hara.truffle.HtaValueCodec.decodeCanonical(hara.truffle.HtaValueCodec.encode(value));
  }
}
