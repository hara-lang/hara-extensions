import assert from "node:assert/strict";
import { test } from "node:test";
import { createDomExistenceProbe } from "../src/dom-existence-probe.js";

function coordinator() {
  const calls = [];
  const released = [];
  return {
    calls,
    released,
    async acquire(tabId, owner) { calls.push(["acquire", tabId, owner]); return true; },
    async release(tabId, owner) { released.push([tabId, owner]); return true; },
    async send(tabId, method, params) {
      calls.push([method, tabId, params]);
      if (method === "DOM.enable") return null;
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        if (params.selector === "[") throw new Error("invalid selector");
        return { nodeId: params.selector === "#login" ? 2 : 0 };
      }
      throw new Error(`unexpected command: ${method}`);
    },
  };
}

test("existence probe returns booleans without resolving Runtime objects", async () => {
  const debug = coordinator();
  const probe = createDomExistenceProbe({ coordinator: debug, owner: "login-test" });
  assert.equal(await probe.dispatch("query-exists", ["#login"], { tabId: 7 }), true);
  assert.equal(await probe.dispatch("query-exists", [".missing"], { tabId: 7 }), false);
  assert.equal(debug.calls.some(([method]) => method === "DOM.resolveNode" || method === "Runtime.callFunctionOn"), false);
  await probe.close();
  assert.deepEqual(debug.released, [[7, "login-test:dom-existence"]]);
});

test("existence probe fails closed for invalid selectors and request shapes", async () => {
  const probe = createDomExistenceProbe({ coordinator: coordinator(), owner: "login-test" });
  await assert.rejects(
    probe.dispatch("query-exists", ["["], { tabId: 7 }),
    (error) => error.code === "dom/invalid-selector",
  );
  await assert.rejects(
    probe.dispatch("query", ["#login"], { tabId: 7 }),
    (error) => error.code === "dom/invalid-request",
  );
  await assert.rejects(
    probe.dispatch("query-exists", ["#login"], { tabId: 0 }),
    (error) => error.code === "dom/missing-target",
  );
});
