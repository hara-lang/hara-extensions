import assert from "node:assert/strict";
import { test } from "node:test";
import { booleanSetting, startDevelopmentRuntime } from "../scripts/dev-runtime.mjs";

test("booleanSetting accepts explicit headed and headless values", () => {
  assert.equal(booleanSetting("true"), true);
  assert.equal(booleanSetting("1"), true);
  assert.equal(booleanSetting("false"), false);
  assert.equal(booleanSetting("0"), false);
  assert.throws(() => booleanSetting("sometimes"), /invalid boolean setting/);
});

test("development runtime propagates headed persistent-profile login settings", async () => {
  let received = null;
  const runtime = await startDevelopmentRuntime({
    respPort: 10011,
    wsPort: 10012,
    profileDir: "/tmp/chatgpt-profile",
    url: "https://chatgpt.com",
    headless: false,
    token: "login-token",
    log: () => {},
    startBridgeImpl: async () => ({
      respPort: 10011,
      wsPort: 10012,
      close: async () => {},
    }),
    launchExtensionImpl: async (options) => {
      received = options;
      return {
        tabId: 91,
        targetUrl: "https://chatgpt.com/",
        closed: new Promise(() => {}),
        openPanel: async () => ({}),
        close: async () => {},
      };
    },
    verifyRespImpl: async () => ({ value: "42" }),
  });
  try {
    assert.deepEqual(received, {
      profileDir: "/tmp/chatgpt-profile",
      url: "https://chatgpt.com",
      headless: false,
    });
  } finally {
    await runtime.close();
  }
});
