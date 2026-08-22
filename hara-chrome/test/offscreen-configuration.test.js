import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("manifest exposes toolbar control and a minimum-version offscreen runtime boundary", async () => {
  const manifest = JSON.parse(await read("../manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.equal(manifest.action.default_popup, "src/popup.html");
  assert.equal(manifest.permissions.includes("offscreen"), true);
  assert.equal(manifest.permissions.includes("storage"), true);
  assert.equal("content_scripts" in manifest, false);
  assert.equal("side_panel" in manifest, false);
});

test("offscreen document owns broker, workers, filesystem, and RESP while using only chrome.runtime", async () => {
  const [html, source] = await Promise.all([
    read("../src/runtime-host.html"),
    read("../src/runtime-host.js"),
  ]);
  assert.match(html, /runtime-host\.js/);
  assert.match(source, /createBrowserBroker/);
  assert.match(source, /createFilesystem\(\{ provider: "indexeddb", key: "hara-chrome" \}\)/);
  assert.match(source, /workerUrl: asset\("vendor\/hta-worker\.js"\)/);
  assert.match(source, /GraphHost/);
  assert.match(source, /connectResp/);
  assert.match(source, /chrome\.runtime\.connect/);
  assert.match(source, /Object\.hasOwn\(value, "targetTabId"\)/);
  assert.doesNotMatch(source, /targetTabId = value\.targetTabId \?\? targetTabId/);
  assert.doesNotMatch(source, /chrome\.(?:debugger|downloads|tabs|storage|offscreen|scripting)/);
  assert.doesNotMatch(source, /document\.(?:body|querySelector|getElementById)/);
});

test("panel is a remote runtime client and no longer owns WASM, workers, IndexedDB, or WebSocket", async () => {
  const source = await read("../src/panel.js");
  assert.match(source, /createRuntimeClient/);
  assert.match(source, /mountStudio/);
  assert.match(source, /runtime\.start\(\)/);
  assert.doesNotMatch(source, /createBrowserBroker|GraphHost|SessionRouter|CapabilityRegistry/);
  assert.doesNotMatch(source, /vendor\/hara\.wasm|vendor\/hta-worker|new Worker|createFilesystem/);
  assert.doesNotMatch(source, /new WebSocket|from ["\']\.\/resp-client\.js["\']/);
  assert.match(source, /beforeunload[\s\S]*runtime\.close/);
  assert.doesNotMatch(source, /beforeunload[\s\S]*runtime\.stop/);
});

test("background supervises offscreen, popup, runtime clients, page providers, and closed host calls", async () => {
  const source = await read("../src/background.js");
  for (const symbol of [
    "createRuntimeSupervisor",
    "createControlSupervisor",
    "RUNTIME_HOST_PORT",
    "RUNTIME_CLIENT_PORT",
    "PAGE_PROVIDER_PORT",
    "CONTROL_PORT",
    "HOST_CALL_PORT",
  ]) assert.match(source, new RegExp(symbol));
  assert.match(source, /authorizeClientRequest/);
  assert.match(source, /controlSupervisor\.tabAllowed/);
  assert.match(source, /controlSupervisor\.adapterAllowed/);
  assert.match(source, /control\/tab-disabled/);
  assert.match(source, /control\/adapter-disabled/);
});

test("popup remains a compact switch panel and never becomes page-injected UI", async () => {
  const [html, css, source] = await Promise.all([
    read("../src/popup.html"),
    read("../src/popup.css"),
    read("../src/popup.js"),
  ]);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 4);
  for (const label of ["Current tab", "Hara runtime", "RESP", "DOM service", "Downloads", "OPEN REPL", "DISCONNECT ALL"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(css, /width:\s*360px/);
  assert.match(source, /CONTROL_PORT/);
  assert.doesNotMatch(html, /iframe|hero|marketing/i);
  assert.doesNotMatch(source, /innerHTML|Runtime\.evaluate|contentScript/i);
});
