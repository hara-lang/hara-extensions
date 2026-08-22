import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

function fixtureHtml(pathname) {
  const assetsOpen = pathname.startsWith("/assets");
  return `<!doctype html>
  <meta charset="utf-8">
  <title>Tripo Studio fixture</title>
  <nav aria-label="Tripo Studio" data-hara-tripo-navigation="true">
    <a href="/assets" aria-label="Assets" data-hara-tripo-action="assets">Assets</a>
    <button data-hara-tripo-workspace-current="true"
            data-workspace-id="personal"
            data-workspace-mode="personal">Personal Workspace</button>
    <button aria-label="Account" data-hara-tripo-signed-in="true">Account</button>
  </nav>
  ${assetsOpen ? `<main aria-label="Assets" data-hara-tripo-surface="assets">
    <a href="/assets/wooden-chair"
       data-hara-tripo-kind="asset"
       data-asset-id="asset-chair"
       data-status="complete"
       data-visibility="private"
       data-workspace-id="personal">Wooden chair</a>
  </main>` : "<main></main>"}`;
}

async function evalHara(panel, source) {
  return panel.evaluate(async (text) => {
    const value = await globalThis.hara.evalLocalSource(text);
    const plain = (input) => {
      if (input?.constructor?.name === "HtaKeyword") return input.name;
      if (input instanceof Map) return Object.fromEntries([...input].map(([key, item]) => [key?.name ?? String(key), plain(item)]));
      if (Array.isArray(input)) return input.map(plain);
      if (input instanceof Set) return [...input].map(plain);
      return input;
    };
    return plain(value);
  }, source);
}

test("browser.site.tripo inventories the current workspace and opens an exact asset", async () => {
  const runtime = await launchWithExtension();
  await runtime.context.route("https://studio.tripo3d.ai/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureHtml(url.pathname) });
  });
  await runtime.targetPage.goto("https://studio.tripo3d.ai/assets?hara-fixture=1", { waitUntil: "domcontentloaded" });
  const panel = await runtime.openPanel();
  try {
    await evalHara(panel, "(require [browser.site.tripo :as tripo])");
    const status = await evalHara(panel, "(tripo/login-status)");
    expect(status).toMatchObject({ state: "signed-in", "signed-in?": true, origin: "https://studio.tripo3d.ai" });
    const workspace = await evalHara(panel, "(tripo/workspace)");
    expect(workspace).toMatchObject({ kind: "workspace", id: "personal", mode: "personal" });
    const assets = await evalHara(panel, "(tripo/assets)");
    expect(assets.map((asset) => ({ kind: asset.kind, id: asset.id, title: asset.title }))).toEqual([
      { kind: "asset", id: "asset-chair", title: "Wooden chair" },
    ]);
    await evalHara(panel, "(tripo/open-asset (first (tripo/assets)))");
    await expect.poll(() => runtime.targetPage.url()).toContain("/assets/wooden-chair");
  } finally {
    await runtime.close();
  }
});
