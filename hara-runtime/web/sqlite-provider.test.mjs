import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sqlite3InitModule from "../extensions/std-db-sqlite/node_modules/@sqlite.org/sqlite-wasm/node.mjs";
import { createSqliteProvider } from "./packages/db-sqlite/index.mjs";
import { nodeFileSystem } from "./packages/db-sqlite/node-filesystem.mjs";
import { HtaKeyword } from "@hara-lang/hta";

const kw = name => new HtaKeyword(name);
const map = entries => new Map(entries.map(([key, value]) => [kw(key), value]));
const value = (input, name) => {
  for (const [key, item] of input) if (key.name === name) return item;
  return undefined;
};

test("SQLite WASM executes parameterized SQL through the std.db provider core", async () => {
  const sqlite = createSqliteProvider(sqlite3InitModule);
  const version = await sqlite.call("node", "version", []);
  assert.equal(version.engine, "sqlite");
  assert.match(version.version, /^3\./);

  const opened = await sqlite.call("node", "open", [new Map()]);
  assert.equal(opened.engine, "sqlite");
  assert.equal(opened.storage, "memory");

  await sqlite.call("node", "exec", [
    opened.id,
    "create table items (id integer primary key, name text not null)",
    []
  ]);
  const inserted = await sqlite.call("node", "exec", [
    opened.id,
    "insert into items (name) values (?)",
    ["wombat"]
  ]);
  assert.equal(inserted.affected, 1);

  const result = await sqlite.call("node", "query", [
    opened.id,
    "select id, name from items where name = ?",
    ["wombat"]
  ]);
  assert.deepEqual(result.columns, ["id", "name"]);
  assert.deepEqual(result.rows, [[1, "wombat"]]);

  assert.equal(await sqlite.call("node", "close", [opened.id]), true);
  await assert.rejects(
    sqlite.call("node", "query", [opened.id, "select 1", []]),
    /db\/sqlite-connection-missing/
  );
});

test("SQLite work-call implements atomic runs, checkpoints, events, and outbox", async () => {
  const sqlite = createSqliteProvider(sqlite3InitModule);
  const opened = await sqlite.call("node", "open", [new Map()]);
  const call = (operation, ...args) =>
    sqlite.call("node", "work-call", [opened.id, kw(operation), args]);

  assert.equal(value(await call("migrate"), "schema/version"), 1);
  const run = map([
    ["run/id", "run-a"],
    ["run/work-root", kw("test/work")],
    ["run/work-version", 1],
    ["run/input", map([["value", 1]])]
  ]);
  const created = await call("create-run", run);
  assert.equal(value(created, "run/status").name, "created");
  assert.deepEqual(await call("create-run", run), created);
  await assert.rejects(
    call("create-run", map([
      ["run/id", "run-a"],
      ["run/work-root", kw("test/work")],
      ["run/work-version", 1],
      ["run/input", map([["value", 2]])]
    ])),
    /run-identity-conflict/
  );

  const checkpointKey = ["run-a", kw("step"), 1];
  const transition = map([
    ["transition/run-id", "run-a"],
    ["transition/expected-revision", 0],
    ["transition/run-updates", map([["run/status", kw("running")]])],
    ["transition/checkpoints", [map([
      ["checkpoint/key", checkpointKey],
      ["checkpoint/status", kw("completed")],
      ["checkpoint/result", 2]
    ])]],
    ["transition/events", [map([["event", kw("work/step-completed")]])]],
    ["transition/outbox", [map([
      ["outbox/key", ["run-a", kw("receipt"), kw("final")]],
      ["outbox/topic", kw("work/receipt")],
      ["outbox/payload", map([["run/id", "run-a"]])]
    ])]]
  ]);
  const committed = await call("transact", transition);
  assert.equal(value(committed, "transition/revision"), 1);
  assert.equal(value(await call("load-checkpoint", checkpointKey), "checkpoint/result"), 2);
  assert.equal((await call("list-events", "run-a")).length, 1);

  await assert.rejects(call("transact", transition), /revision-conflict/);
  assert.equal((await call("list-events", "run-a")).length, 1);
  const pending = await call("list-outbox", map([["status", kw("pending")]]));
  assert.equal(pending.length, 1);
  const claimed = await call("claim-outbox", map([["claim/id", "claim-a"], ["limit", 1]]));
  assert.equal(value(claimed[0], "outbox/status").name, "claimed");
  const acked = await call(
    "ack-outbox",
    value(claimed[0], "outbox/id"),
    map([["claim/id", "claim-a"], ["ack/data", map([["published", true]])]])
  );
  assert.equal(value(acked, "outbox/status").name, "acked");
  assert.equal((await call("list-outbox", map([["status", kw("pending")]]))).length, 0);
  await sqlite.call("node", "exec", [
    opened.id,
    "update work_runs set record = ? where id = ?",
    [new Uint8Array([0xff, 0x00]), "run-a"]
  ]);
  await assert.rejects(call("load-run", "run-a"), /work\/store-corrupt/);
  await sqlite.call("node", "close", [opened.id]);
});

test("filesystem work store persists receipt acknowledgement across provider replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hara-sqlite-work-"));
  const path = join(directory, "work.db");
  try {
    const first = createSqliteProvider(sqlite3InitModule, { fileSystem: nodeFileSystem });
    const opened = await first.call("node", "open", [map([["storage", kw("filesystem")], ["path", path]])]);
    const call = (operation, ...args) => first.call("node", "work-call", [opened.id, kw(operation), args]);
    await call("migrate");
    await call("create-run", map([
      ["run/id", "restart-run"],
      ["run/work-root", kw("test/restart")],
      ["run/work-version", 1],
      ["run/input", 42]
    ]));
    await call("transact", map([
      ["transition/run-id", "restart-run"],
      ["transition/expected-revision", 0],
      ["transition/run-updates", map([["run/status", kw("running")]])],
      ["transition/checkpoints", [map([
        ["checkpoint/key", ["restart-run", kw("step"), 1]],
        ["checkpoint/status", kw("completed")],
        ["checkpoint/result", 42]
      ])]],
      ["transition/events", [map([["event", kw("work/resumed")]])]],
      ["transition/outbox", [map([
        ["outbox/key", ["restart-run", kw("receipt"), kw("final")]],
        ["outbox/topic", kw("work/receipt")],
        ["outbox/payload", map([["run/id", "restart-run"]])]
      ])]]
    ]));
    await first.call("node", "close", [opened.id]);

    const second = createSqliteProvider(sqlite3InitModule, { fileSystem: nodeFileSystem });
    const reopened = await second.call("node", "open", [map([["storage", kw("filesystem")], ["path", path]])]);
    const loaded = await second.call("node", "work-call", [reopened.id, kw("load-run"), ["restart-run"]]);
    assert.equal(value(loaded, "run/input"), 42);
    const checkpoint = await second.call("node", "work-call", [
      reopened.id,
      kw("load-checkpoint"),
      [["restart-run", kw("step"), 1]]
    ]);
    assert.equal(value(checkpoint, "checkpoint/result"), 42);
    const claimed = await second.call("node", "work-call", [
      reopened.id,
      kw("claim-outbox"),
      [map([["claim/id", "restart-publisher"], ["limit", 1]])]
    ]);
    assert.equal(claimed.length, 1);
    await second.call("node", "work-call", [
      reopened.id,
      kw("ack-outbox"),
      [
        value(claimed[0], "outbox/id"),
        map([["claim/id", "restart-publisher"], ["ack/data", map([["published", true]])]])
      ]
    ]);
    await second.call("node", "close", [reopened.id]);

    const third = createSqliteProvider(sqlite3InitModule, { fileSystem: nodeFileSystem });
    const verified = await third.call("node", "open", [map([["storage", kw("filesystem")], ["path", path]])]);
    const redelivery = await third.call("node", "work-call", [
      verified.id,
      kw("claim-outbox"),
      [map([["claim/id", "second-publisher"], ["limit", 1]])]
    ]);
    const acknowledged = await third.call("node", "work-call", [
      verified.id,
      kw("list-outbox"),
      [map([["status", kw("acked")]])]
    ]);
    assert.equal(redelivery.length, 0);
    assert.equal(acknowledged.length, 1);
    await third.call("node", "close", [verified.id]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
