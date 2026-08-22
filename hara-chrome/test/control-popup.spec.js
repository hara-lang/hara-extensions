import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

test("toolbar popup controls the exact bound tab and the shared offscreen runtime", async () => {
  const runtime = await launchWithExtension({ url: "about:blank" });
  try {
    await runtime.context.route("https://example.test/**", (route) => route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Diagnostics target</title><main>target</main>",
    }));
    await runtime.targetPage.goto("https://example.test/control");
    await runtime.serviceWorker.evaluate(async () => {
      await globalThis.haraControlSupervisor.dispatch("set-binding", [true]);
    });

    const popupUrl = `chrome-extension://${runtime.extensionId}/src/popup.html`;
    const popup = await runtime.context.newPage();
    await popup.goto(popupUrl);
    await popup.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(popup.locator("#target-label")).toContainText(`TAB ${runtime.tabId}`);
    await expect(popup.locator("#binding-state")).toHaveText("BOUND");
    await expect(popup.locator("#runtime-state")).toHaveText("OFF");

    await popup.locator("#runtime-toggle").check();
    await expect(popup.locator("#runtime-state")).toHaveText("READY", { timeout: 30000 });
    await popup.close();

    const reopened = await runtime.context.newPage();
    await reopened.goto(popupUrl);
    await reopened.waitForFunction(() => document.body.dataset.ready === "true");
    await expect(reopened.locator("#binding-state")).toHaveText("BOUND");
    await expect(reopened.locator("#runtime-state")).toHaveText("READY");
    await reopened.locator("#disconnect-all").click();
    await expect(reopened.locator("#binding-state")).toHaveText("OFF");
    await expect(reopened.locator("#runtime-state")).toHaveText("OFF");
    await reopened.close();
  } finally {
    await runtime.close();
  }
});
