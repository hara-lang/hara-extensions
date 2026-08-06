import { test } from "node:test";
import assert from "node:assert/strict";
import { createProtocolSession, encodeResp, readCommand } from "../bridge/protocol.mjs";

const bulk = (text) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
const command = (...args) => Buffer.from(`*${args.length}\r\n${args.map(bulk).join("")}`);

test("readCommand parses one RESP array and validates framing", () => {
  assert.deepEqual(readCommand(command("EVAL", "ROOT", "(+ 1 2)")).args, ["EVAL", "ROOT", "(+ 1 2)"]);
  assert.throws(() => readCommand(Buffer.from("*1\r\n$3\r\nabcxx")), /missing bulk CRLF/);
});

test("encodeResp preserves nested protocol-4 frames", () => {
  assert.equal(encodeResp(["DONE", "E-1", "OK"]), "*3\r\n$4\r\nDONE\r\n$3\r\nE-1\r\n$2\r\nOK\r\n");
});

test("protocol 4 lists, attaches and evaluates browser sessions", async () => {
  const calls = [];
  const session = createProtocolSession({
    connectionId: "test-1",
    request: async (op, payload) => {
      calls.push([op, payload]);
      if (op === "info") return { sessions: ["ROOT", "game"], target: "page:main" };
      if (op === "session.list") return ["ROOT", "game"];
      if (op === "eval") return `result:${payload.session}:${payload.source}`;
      throw new Error(`unexpected ${op}`);
    },
  });
  const hello = await session.handle(["HELLO", "4", "CLIENT", "EMACS"]);
  assert.equal(hello.frames[0][0], "SERVER");
  const attach = await session.handle(["SESSION", "A-1", "ATTACH", "game"]);
  assert.deepEqual(attach.frames, [["RESULT", "A-1", "game"], ["DONE", "A-1", "OK"]]);
  const evalReply = await session.handle(["EVAL", "E-1", "(+ 1 2)", "FILE", "/tmp/demo.hal"]);
  assert.deepEqual(evalReply.frames, [["RESULT", "E-1", "result:game:(+ 1 2)"], ["DONE", "E-1", "OK"]]);
  assert.equal(calls.at(-1)[1].options.file, "/tmp/demo.hal");
});

test("legacy VS Code EVAL session source remains supported", async () => {
  const session = createProtocolSession({
    request: async (op, payload) => op === "eval" ? `${payload.session}:${payload.source}` : [],
  });
  const reply = await session.handle(["EVAL", "scratch", "42"]);
  assert.deepEqual(reply.frames, ["scratch:42"]);
});
