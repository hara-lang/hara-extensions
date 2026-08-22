import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

test("offscreen Hara runtime survives panel closure and is closed only by explicit shutdown", async () => {
  const runtime = await launchWithExtension({ url: "about:blank" });
  try {
    const panel = await runtime.openPanel();
    const first = await panel.evaluate(async () => globalThis.hara.evalLocalSource("(do (def offscreen-sentinel 41) offscreen-sentinel)"));
    expect(first).toBe(41);

    const offscreenUrl = `chrome-extension://${runtime.extensionId}/src/runtime-host.html`;
    const contextsBefore = await runtime.serviceWorker.evaluate(
      async (documentUrl) => chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl],
      }),
      offscreenUrl,
    );
    expect(contextsBefore).toHaveLength(1);

    await panel.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const contextsAfterPanelClose = await runtime.serviceWorker.evaluate(
      async (documentUrl) => chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl],
      }),
      offscreenUrl,
    );
    expect(contextsAfterPanelClose).toHaveLength(1);

    const reopened = await runtime.openPanel();
    const second = await reopened.evaluate(async () => globalThis.hara.evalLocalSource("(+ offscreen-sentinel 1)"));
    expect(second).toBe(42);
    await reopened.close();

    await runtime.serviceWorker.evaluate(async () => {
      await globalThis.haraRuntimeSupervisor.stop({ closeDocument: true });
    });
    await expect.poll(() => runtime.serviceWorker.evaluate(
      async (documentUrl) => (await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl],
      })).length,
      offscreenUrl,
    )).toBe(0);
  } finally {
    await runtime.close();
  }
});
