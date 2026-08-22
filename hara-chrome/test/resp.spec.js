import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { startBridge } from "../bridge/resp-bridge.mjs";
import { launchExtensionRuntime } from "../scripts/browser-runtime.mjs";
import { verifyHaraResp } from "../scripts/resp-client.mjs";

test("real headless extension evaluates through protocol 4", async () => {
  const token = randomBytes(24).toString("base64url");
  const bridge = await startBridge({ respPort: 0, wsPort: 0, token });
  const browser = await launchExtensionRuntime();
  try {
    const respUrl = `ws://127.0.0.1:${bridge.wsPort}/?token=${encodeURIComponent(token)}`;
    const panel = await browser.openPanel({ tabId: 0, respUrl });
    expect(await panel.evaluate(() => globalThis.hara?.ready)).toMatchObject({
      kernel: true,
      resp: "connected",
      error: null,
    });
    const result = await verifyHaraResp({ port: bridge.respPort });
    expect(result.attached).toBe("ROOT");
    expect(result.value).toBe("42");
  } finally {
    await browser.close();
    await bridge.close();
  }
});
