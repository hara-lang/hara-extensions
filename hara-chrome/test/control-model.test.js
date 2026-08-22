import assert from "node:assert/strict";
import { test } from "node:test";
import {
  badgeForSnapshot,
  classifyTab,
  initialSession,
  normalizePreferences,
  normalizeSession,
  requireBindableTab,
  titleForSnapshot,
} from "../src/control-model.js";
import { derivePopupView } from "../src/popup-model.js";

test("tab classification is exact for ChatGPT and Tripo and rejects extension pages", () => {
  assert.deepEqual(classifyTab({ id: 7, windowId: 1, url: "https://chatgpt.com/c/1" }).adapter, "chatgpt");
  assert.deepEqual(classifyTab({ id: 8, windowId: 1, url: "https://studio.tripo3d.ai/assets" }).adapter, "tripo");
  assert.equal(classifyTab({ id: 9, windowId: 1, url: "https://example.com" }).kind, "web");
  assert.equal(classifyTab({ id: 10, windowId: 1, url: "chrome://extensions" }).bindable, false);
  assert.equal(classifyTab({ id: 11, windowId: 1, url: "chrome-extension://abc/src/panel.html" }).bindable, false);
  assert.throws(() => requireBindableTab({ id: 10, url: "chrome://extensions" }), (error) => error.code === "control/tab-not-bindable");
});

test("control session normalization preserves desired state separately from actual runtime state", () => {
  assert.deepEqual(normalizePreferences(null), { adapterDefaultEnabled: true, respUrl: "ws://127.0.0.1:7356" });
  const initial = initialSession(() => 17);
  assert.equal(initial.runtimeDesired, false);
  const restored = normalizeSession({
    controlled: true,
    bindingDesired: true,
    boundTabId: 73,
    runtimeDesired: true,
    respDesired: true,
    adapterDesired: false,
  }, () => 18);
  assert.equal(restored.boundTabId, 73);
  assert.equal(restored.runtimeDesired, true);
  assert.equal(restored.respDesired, true);
  assert.equal(restored.adapterDesired, false);
});

test("badge and popup model privilege actual error, authentication, and transition states", () => {
  const base = {
    boundTab: { id: 73, hostname: "chatgpt.com", title: "ChatGPT" },
    binding: { desired: true, state: "bound" },
    runtime: { desired: true, state: "ready", host: "offscreen", hostCount: 1 },
    resp: { desired: false, state: "off", url: "ws://127.0.0.1:7356" },
    adapter: { kind: "chatgpt", desired: true, state: "ready", authentication: "signed-in" },
    dom: { state: "ready" },
    downloads: { state: "idle" },
    activity: { lastError: null },
    capabilities: { canBind: true, canRuntime: true, canResp: true, canAdapter: true },
  };
  assert.equal(badgeForSnapshot(base), "ON");
  assert.match(titleForSnapshot(base), /READY/);
  const view = derivePopupView(base);
  assert.equal(view.globalLabel, "READY");
  assert.equal(view.rows.runtime.detail, "OFFSCREEN HOST");
  assert.equal(view.rows.adapter.stateLabel, "SIGNED IN");

  assert.equal(badgeForSnapshot({ ...base, adapter: { ...base.adapter, authentication: "authentication-required" } }), "AUTH");
  assert.equal(badgeForSnapshot({ ...base, runtime: { ...base.runtime, state: "starting" } }), "…");
  assert.equal(badgeForSnapshot({ ...base, activity: { lastError: { message: "bad" } } }), "!");
});
