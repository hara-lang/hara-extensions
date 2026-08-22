import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { readRespFrame, verifyHaraResp } from "../scripts/resp-client.mjs";

function readCommand(buffer) {
  if (buffer.length === 0) return null;
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return null;
  const count = Number(buffer.subarray(1, lineEnd).toString());
  const args = [];
  let cursor = lineEnd + 2;
  for (let index = 0; index < count; index += 1) {
    const sizeEnd = buffer.indexOf("\r\n", cursor);
    if (sizeEnd === -1) return null;
    const size = Number(buffer.subarray(cursor + 1, sizeEnd).toString());
    const start = sizeEnd + 2;
    const end = start + size;
    if (buffer.length < end + 2) return null;
    args.push(buffer.subarray(start, end).toString());
    cursor = end + 2;
  }
  return { args, consumed: cursor };
}

function encode(value) {
  if (Array.isArray(value)) return `*${value.length}\r\n${value.map(encode).join("")}`;
  if (Number.isSafeInteger(value)) return `:${value}\r\n`;
  if (value === null) return "$-1\r\n";
  const text = String(value);
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
}

test("readRespFrame waits for complete nested frames", () => {
  const complete = Buffer.from(encode(["RESULT", "request-1", [42, null]]));
  assert.equal(readRespFrame(complete.subarray(0, complete.length - 1)), null);
  assert.deepEqual(readRespFrame(complete), {
    value: ["RESULT", "request-1", [42, null]],
    consumed: complete.length,
  });
});

test("verifyHaraResp negotiates protocol 4 and smoke-tests browser.dom target binding", async () => {
  const observed = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const command = readCommand(buffer);
        if (!command) break;
        buffer = buffer.subarray(command.consumed);
        observed.push(command.args);
        const phase = observed.length - 1;
        if (phase === 0) {
          socket.write(encode(["SERVER", "HARA", "PROTO", 4, "SESSION", "ROOT"]));
        } else if (phase === 1) {
          socket.write(encode(["RESULT", "ready-session", "ROOT"]));
          socket.write(encode(["DONE", "ready-session", "OK"]));
        } else if (phase === 2) {
          socket.write(encode(["RESULT", "ready-eval", "42"]));
          socket.write(encode(["DONE", "ready-eval", "OK"]));
        } else if (phase === 3) {
          socket.write(encode(["RESULT", "ready-dom-target", "73"]));
          socket.write(encode(["DONE", "ready-dom-target", "OK"]));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await verifyHaraResp({ port: address.port, tabId: 73 });
    assert.equal(result.attached, "ROOT");
    assert.equal(result.value, "42");
    assert.equal(result.domTarget, "73");
    assert.deepEqual(observed, [
      ["HELLO", "4", "CLIENT", "EMACS"],
      ["SESSION", "ready-session", "ATTACH", "ROOT"],
      ["EVAL", "ready-eval", "(+ 40 2)"],
      [
        "EVAL",
        "ready-dom-target",
        "(do (require [browser.dom :as dom]) (:tab-id (dom/target)))",
      ],
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
