import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("panel registers browser.dom and propagates its exact bound tab to host calls", async () => {
  const panel = await read("../src/panel.js");
  assert.match(panel, /createHostCalls\(port, \{ tabId \}\)/);
  assert.match(panel, /["']browser\.dom["']\s*:\s*await fetchText\(["']src\/hara\/dom\.hal["']\)/);
});

test("browser.dom remains a closed module without userscripts or content injection", async () => {
  const manifest = JSON.parse(await read("../manifest.json"));
  assert.equal(manifest.permissions.includes("debugger"), true);
  assert.equal(manifest.permissions.includes("tabs"), true);
  assert.equal(manifest.permissions.includes("userScripts"), false);
  assert.equal("content_scripts" in manifest, false);

  const source = await read("../src/hara/dom.hal");
  for (const operation of ["target", "query", "query-all", "refresh", "focus", "fill", "click", "detach"]) {
    assert.match(source, new RegExp(`\\(defn ${operation.replace("-", "\\-")}\\b`));
  }
  assert.doesNotMatch(source, /Runtime\.evaluate|eval-js|chrome\.userScripts/);
});

test("standalone sync uses only built-in File effects and deref", async () => {
  const sync = await read("../scripts/sync-runtime.hal");
  const focused = await read("./sync-runtime-test.hal");
  assert.doesNotMatch(sync, /\(:require|std\.fs|lang\.core\.eval/);
  assert.doesNotMatch(focused, /\(:require|std\.fs|lang\.core\.eval/);
  for (const operation of ["exists?", "stat", "entries", "delete", "mkdir", "copy"]) {
    assert.match(sync, new RegExp(`File/${operation.replace("?", "\\?")}`));
  }
  assert.match(sync, /\(deref pending\)/);
  assert.match(sync, /ensure-runtime-assets!/);
  assert.match(sync, /delete-node! \(str extension-root "\/vendor"\)/);
  assert.match(focused, /\(deref \(File\/exists\?/);
});
