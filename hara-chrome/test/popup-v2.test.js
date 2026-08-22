import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { derivePopupView } from "../src/popup-model.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const VISUAL_LANGUAGE_REF = "ee0d92dadd0786bf52a0d79e7feabbd5be9105cc";

test("hara-chrome pins the accepted visual-language v2 revision", async () => {
  const [gitmodules, ref] = await Promise.all([
    read("../../.gitmodules"),
    read("../ui/visual-language.ref"),
  ]);

  assert.match(gitmodules, /hara-chrome\/ui\/visual-language/);
  assert.match(gitmodules, /https:\/\/github\.com\/hara-lang\/visual-language\.git/);
  assert.match(ref, new RegExp(`commit=${VISUAL_LANGUAGE_REF}`));
  assert.match(ref, /contract=V2-RUNTIME\.md/);
  assert.match(ref, /visual-language\/v2\/tool\/hara-chrome\//);
});

test("runtime staging preserves the framework-free v2 import graph", async () => {
  const [sync, syncTest, popup] = await Promise.all([
    read("../scripts/sync-runtime.hal"),
    read("./sync-runtime-test.hal"),
    read("../src/popup.html"),
  ]);

  for (const asset of ["tokens.css", "theme.css", "v2.css", "v2-tool.css"]) {
    assert.match(sync, new RegExp(`ui/visual-language/src/${asset.replace(".", "\\.")}`));
    assert.match(sync, new RegExp(`vendor/visual-language/${asset.replace(".", "\\.")}`));
  }
  assert.match(sync, /ui\/visual-language\/src\/v2/);
  assert.match(sync, /vendor\/visual-language\/v2/);
  assert.match(syncTest, /vendor\/visual-language\/v2-tool\.css/);
  assert.match(syncTest, /vendor\/visual-language\/v2\/tool-runtime\.css/);

  const sharedIndex = popup.indexOf("../vendor/visual-language/v2-tool.css");
  const localIndex = popup.indexOf("./popup.css");
  assert.ok(sharedIndex >= 0 && localIndex > sharedIndex, "shared v2 CSS must load before the product adapter");
});

test("the toolbar popup uses v2 runtime semantics while preserving control IDs", async () => {
  const popup = await read("../src/popup.html");

  for (const className of [
    "hara-v2 hara-v2-tool",
    "hara-runtime-compact",
    "hara-runtime-compact-header",
    "hara-runtime-compact-target",
    "hara-runtime-connection-list",
    "hara-runtime-connection",
    "hara-runtime-status-lamp",
    "hara-runtime-switch-input",
    "hara-runtime-actions",
    "hara-tool-button",
  ]) assert.match(popup, new RegExp(className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const id of [
    "binding-toggle",
    "runtime-toggle",
    "resp-toggle",
    "adapter-toggle",
    "open-repl",
    "reconnect",
    "disconnect-all",
    "clear-error",
  ]) assert.match(popup, new RegExp(`id="${id}"`));

  assert.equal((popup.match(/type="checkbox" role="switch"/g) ?? []).length, 4);
  assert.match(popup, /<output id="runtime-state"/);
  assert.match(popup, /data-desired="off"/);
  assert.match(popup, /aria-live="assertive"/);
});

test("requested state remains distinct from actual state", () => {
  const view = derivePopupView({
    binding: { desired: true, state: "bound" },
    runtime: { desired: true, state: "starting", host: "offscreen" },
    resp: { desired: true, state: "connecting", url: "ws://127.0.0.1:7356" },
    adapter: { desired: true, state: "ready", kind: "chatgpt", authentication: "authentication-required" },
    dom: { state: "ready" },
    downloads: { state: "idle" },
    capabilities: { canBind: true, canRuntime: true, canResp: true, canAdapter: true },
  });

  assert.equal(view.rows.runtime.desired, true);
  assert.equal(view.rows.runtime.stateLabel, "STARTING");
  assert.equal(view.rows.resp.desired, true);
  assert.equal(view.rows.resp.stateLabel, "CONNECTING");
  assert.equal(view.rows.adapter.desired, true);
  assert.equal(view.rows.adapter.stateLabel, "LOGIN REQUIRED");
  assert.equal(view.globalLabel, "ATTENTION");
});

test("the local popup stylesheet is an adapter, not a forked theme", async () => {
  const css = await read("../src/popup.css");

  assert.doesNotMatch(css, /--hara-[A-Za-z0-9_-]+\s*:/, "popup.css must not redefine shared Hara tokens");
  for (const token of [
    "--hara-tool-bg",
    "--hara-tool-ink",
    "--hara-tool-muted",
    "--hara-tool-success",
    "--hara-tool-signal",
    "--hara-tool-warning",
    "--hara-tool-danger",
  ]) assert.match(css, new RegExp(`var\\(${token.replace("-", "\\-")}`));

  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /max-width:\s*360px/);
});

test("the popup controller adapts visual state without changing authority commands", async () => {
  const source = await read("../src/popup.js");

  assert.match(source, /function actualVisualState/);
  assert.match(source, /dataset\.desired = value\.desired \? "on" : "off"/);
  assert.match(source, /aria-description/);

  for (const [id, method] of [
    ["binding-toggle", "set-binding"],
    ["runtime-toggle", "set-runtime"],
    ["resp-toggle", "set-resp"],
    ["adapter-toggle", "set-adapter"],
  ]) assert.match(source, new RegExp(`bindToggle\\("${id}", "${method}"\\)`));

  for (const method of ["open-repl", "reconnect", "disconnect-all", "clear-error"])
    assert.match(source, new RegExp(`request\\("${method}"\\)`));

  assert.doesNotMatch(source, /Runtime\.evaluate|chrome\.debugger|chrome\.tabs\.update/);
});
