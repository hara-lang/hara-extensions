import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlain, fromPlain, createHostCalls } from "../src/host-bridge.js";
import { HtaKeyword, HtaSymbol } from "../vendor/hta.js";

test("toPlain converts HTA values to JSON-safe values", () => {
  const input = new Map([
    [new HtaKeyword("url"), "https://example.com"],
    [new HtaKeyword("nested"), new Map([[new HtaKeyword("n"), 42]])],
    [new HtaKeyword("list"), [1, new HtaKeyword("two")]],
    [new HtaKeyword("sym"), new HtaSymbol("foo")],
  ]);
  assert.deepEqual(toPlain(input), {
    url: "https://example.com",
    nested: { n: 42 },
    list: [1, ":two"],
    sym: "foo",
  });
});

test("fromPlain converts JSON objects to keyword-keyed maps", () => {
  const out = fromPlain({ result: { value: 42 }, ok: true, nothing: null });
  assert.ok(out instanceof Map);
  const result = [...out].find(([k]) => k.name === "result")[1];
  assert.equal([...result][0][0].name, "value");
  assert.equal([...result][0][1], 42);
});

test("createHostCalls carries exact panel target metadata on every call", async () => {
  const listeners = [];
  const sent = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => {
      sent.push(msg);
      queueMicrotask(() =>
        listeners.forEach((fn) => fn({ id: msg.id, ok: true, value: { echoed: msg.args } })),
      );
    },
  };
  const hostCalls = createHostCalls(port, { tabId: 73 });
  const value = await hostCalls["chrome.debugger/sendCommand"](1, "Page.navigate", { url: "x" });
  assert.equal(sent[0].service, "chrome.debugger");
  assert.equal(sent[0].method, "sendCommand");
  assert.deepEqual(sent[0].target, { tabId: 73 });
  assert.ok(value instanceof Map);
  assert.equal([...value][0][0].name, "echoed");
});

test("host error codes survive port rejection", async () => {
  const listeners = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => queueMicrotask(() =>
      listeners.forEach((fn) => fn({
        id: msg.id,
        ok: false,
        error: "dom/invalid-selector: bad selector",
        code: "dom/invalid-selector",
      })),
    ),
  };
  const hostCalls = createHostCalls(port, { tabId: 73 });
  await assert.rejects(
    hostCalls["hara.dom/query"]("["),
    (error) => error.code === "dom/invalid-selector" && /bad selector/.test(error.message),
  );
});

test("pending host calls reject when the port disconnects", async () => {
  const disconnectListeners = [];
  const port = {
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage: () => {},
  };
  const hostCalls = createHostCalls(port, { tabId: 73 });
  const call = hostCalls["chrome.debugger/sendCommand"](1, "Page.navigate");
  disconnectListeners.forEach((fn) => fn());
  await assert.rejects(call, /hara host disconnected/);
});
