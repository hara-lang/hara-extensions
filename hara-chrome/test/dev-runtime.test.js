import assert from "node:assert/strict";
import { test } from "node:test";
import { startDevelopmentRuntime } from "../scripts/dev-runtime.mjs";

test("development runtime binds URL and exact tab before readiness and closes once", async () => {
  let bridgeCloses = 0;
  let browserCloses = 0;
  let panelOpens = 0;
  let verifications = 0;
  const lines = [];
  const runtime = await startDevelopmentRuntime({
    respPort: 10001,
    wsPort: 10002,
    url: "https://example.test/editor",
    token: "test-token",
    log: (line) => lines.push(line),
    startBridgeImpl: async () => ({
      respPort: 10001,
      wsPort: 10002,
      close: async () => { bridgeCloses += 1; },
    }),
    launchExtensionImpl: async ({ url }) => {
      assert.equal(url, "https://example.test/editor");
      return {
        tabId: 73,
        targetUrl: "https://example.test/editor",
        closed: new Promise(() => {}),
        openPanel: async ({ tabId, respUrl }) => {
          panelOpens += 1;
          assert.equal(tabId, 73);
          assert.equal(respUrl, "ws://127.0.0.1:10002/?token=test-token");
          return { kind: "panel" };
        },
        close: async () => { browserCloses += 1; },
      };
    },
    verifyRespImpl: async ({ port, tabId }) => {
      verifications += 1;
      assert.equal(port, 10001);
      assert.equal(tabId, 73);
      return { value: "42", domTarget: "73" };
    },
  });

  assert.deepEqual(lines, [
    "HARA TARGET https://example.test/editor TAB 73",
    "HARA RESP 127.0.0.1:10001",
  ]);
  assert.deepEqual(runtime.target, {
    tabId: 73,
    url: "https://example.test/editor",
  });
  assert.equal(panelOpens, 1);
  assert.equal(verifications, 1);
  await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
  assert.equal(browserCloses, 1);
  assert.equal(bridgeCloses, 1);
});

test("startup failure closes an already-open bridge", async () => {
  let bridgeCloses = 0;
  await assert.rejects(
    startDevelopmentRuntime({
      respPort: 10003,
      wsPort: 10004,
      log: () => {},
      startBridgeImpl: async () => ({
        respPort: 10003,
        wsPort: 10004,
        close: async () => { bridgeCloses += 1; },
      }),
      launchExtensionImpl: async () => { throw new Error("Chromium failed"); },
    }),
    /Chromium failed/,
  );
  assert.equal(bridgeCloses, 1);
});
