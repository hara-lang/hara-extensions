import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlSupervisor } from "../src/control-supervisor.js";
import { CONTROL_SESSION_KEY } from "../src/control-model.js";
import { createStorageArea, FakeEvent } from "./helpers.js";

function runtimeFixture() {
  let status = {
    runtimeState: "off",
    respState: "off",
    targetTabId: null,
    kernel: null,
    kernels: [],
    instanceId: null,
    error: null,
  };
  const calls = [];
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(status); };
  return {
    calls,
    status: () => status,
    onStatus(listener) { listeners.add(listener); listener(status); return () => listeners.delete(listener); },
    async start(tabId) {
      calls.push(["start", tabId]);
      status = { ...status, runtimeState: "ready", targetTabId: tabId, kernel: "ROOT", kernels: ["ROOT"], instanceId: "runtime-1" };
      emit();
      return { status };
    },
    async bindTarget(tabId) { calls.push(["bind", tabId]); status = { ...status, targetTabId: tabId }; emit(); return { status }; },
    async connectResp(url) { calls.push(["resp.connect", url]); status = { ...status, respState: "connected", respUrl: url }; emit(); return { status }; },
    async disconnectResp() { calls.push(["resp.disconnect"]); status = { ...status, respState: "off" }; emit(); return { status }; },
    async stop() { calls.push(["stop"]); status = { runtimeState: "off", respState: "off", targetTabId: null, kernel: null, kernels: [], instanceId: null, error: null }; emit(); return { status }; },
  };
}

function chromeFixture(storage = null) {
  const tabs = new Map([
    [73, { id: 73, windowId: 1, active: true, title: "ChatGPT", url: "https://chatgpt.com/c/one" }],
    [74, { id: 74, windowId: 1, active: false, title: "Tripo", url: "https://studio.tripo3d.ai/assets" }],
  ]);
  let nextTab = 100;
  const removed = [];
  const action = { badges: [], titles: [] };
  const events = { onActivated: new FakeEvent(), onUpdated: new FakeEvent(), onRemoved: new FakeEvent() };
  const chromeApi = {
    runtime: { getURL: (path) => `chrome-extension://test/${String(path).replace(/^\//, "")}` },
    storage: storage ?? { local: createStorageArea(), session: createStorageArea() },
    action: {
      async setBadgeText(value) { action.badges.push(value.text); },
      async setTitle(value) { action.titles.push(value.title); },
    },
    tabs: {
      ...events,
      async query(query) {
        const values = [...tabs.values()];
        if (query.active && query.currentWindow) return values.filter((tab) => tab.active);
        if (query.url) {
          const prefix = String(query.url).replace(/\*$/, "");
          return values.filter((tab) => tab.url.startsWith(prefix));
        }
        return values;
      },
      async get(tabId) { const value = tabs.get(Number(tabId)); if (!value) throw new Error("No tab"); return { ...value }; },
      async update(tabId, change) {
        const tab = tabs.get(Number(tabId));
        if (!tab) throw new Error("No tab");
        if (change.active) for (const item of tabs.values()) item.active = false;
        Object.assign(tab, change);
        return { ...tab };
      },
      async create(value) {
        const tab = { id: nextTab++, windowId: 1, active: value.active === true, title: "Hara", url: value.url };
        if (tab.active) for (const item of tabs.values()) item.active = false;
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async remove(tabId) { removed.push(Number(tabId)); tabs.delete(Number(tabId)); events.onRemoved.emit(Number(tabId)); },
    },
    windows: { async update() {} },
  };
  return { chromeApi, tabs, action, removed, storage: chromeApi.storage };
}

test("control supervisor binds exact tabs and keeps desired state distinct from runtime state", async () => {
  const runtime = runtimeFixture();
  const env = chromeFixture();
  const supervisor = createControlSupervisor({
    chromeApi: env.chromeApi,
    runtimeSupervisor: runtime,
    probeContext: async (tab) => ({ adapterState: "ready", authentication: tab.adapter === "chatgpt" ? "signed-in" : null }),
    now: (() => { let value = 100; return () => ++value; })(),
  });
  await supervisor.start();

  const bound = await supervisor.dispatch("set-binding", [true]);
  assert.equal(bound.boundTab.id, 73);
  assert.equal(bound.binding.state, "bound");
  assert.equal(bound.adapter.kind, "chatgpt");
  assert.equal(bound.runtime.state, "off");

  const ready = await supervisor.dispatch("set-runtime", [true]);
  assert.equal(ready.runtime.desired, true);
  assert.equal(ready.runtime.state, "ready");
  assert.equal(ready.runtime.host, "offscreen");
  assert.equal(await supervisor.tabAllowed(73), true);
  assert.equal(await supervisor.tabAllowed(74), false);
  assert.equal(await supervisor.adapterAllowed(73, "chatgpt"), true);
  assert.equal(await supervisor.adapterAllowed(73, "tripo"), false);

  await env.chromeApi.tabs.update(74, { active: true });
  const afterActivation = await supervisor.dispatch("status");
  assert.equal(afterActivation.activeTab.id, 74);
  assert.equal(afterActivation.boundTab.id, 73, "authority does not follow the newly active tab");

  const connected = await supervisor.dispatch("set-resp", [true]);
  assert.equal(connected.resp.desired, true);
  assert.equal(connected.resp.state, "connected");
  assert.ok(env.action.badges.includes("ON"));
  assert.ok(runtime.calls.some(([operation]) => operation === "resp.connect"));

  const stopped = await supervisor.dispatch("set-runtime", [false]);
  assert.equal(stopped.runtime.state, "off");
  assert.equal(stopped.adapter.desired, true, "adapter preference remains requested");
  assert.equal(stopped.adapter.state, "unavailable", "actual adapter state follows runtime availability");

  await supervisor.close();
});

test("control state survives service-worker recreation and disconnect-all closes only popup-owned REPL tabs", async () => {
  const runtime = runtimeFixture();
  const env = chromeFixture();
  let supervisor = createControlSupervisor({ chromeApi: env.chromeApi, runtimeSupervisor: runtime });
  await supervisor.start();
  await supervisor.dispatch("set-binding", [true]);
  await supervisor.dispatch("set-runtime", [true]);
  const opened = await supervisor.dispatch("open-repl");
  const replTabId = env.storage.session.values[CONTROL_SESSION_KEY].replTabId;
  assert.ok(replTabId > 0);
  assert.equal(opened.runtime.state, "ready");
  await supervisor.close();

  supervisor = createControlSupervisor({ chromeApi: env.chromeApi, runtimeSupervisor: runtime });
  const restored = await supervisor.start();
  assert.equal(restored.binding.state, "bound");
  assert.equal(restored.runtime.desired, true);
  assert.equal(restored.boundTab.id, 73);

  const disconnected = await supervisor.dispatch("disconnect-all");
  assert.equal(disconnected.binding.state, "off");
  assert.equal(disconnected.runtime.desired, false);
  assert.ok(env.removed.includes(replTabId));
  assert.equal(env.storage.session.values[CONTROL_SESSION_KEY].boundTabId, null);
  await supervisor.close();
});


test("closing the exact bound tab shuts down the shared runtime and clears authority", async () => {
  const runtime = runtimeFixture();
  const env = chromeFixture();
  const supervisor = createControlSupervisor({ chromeApi: env.chromeApi, runtimeSupervisor: runtime });
  await supervisor.start();
  await supervisor.dispatch("set-binding", [true]);
  await supervisor.dispatch("set-runtime", [true]);
  assert.equal(runtime.status().runtimeState, "ready");

  env.tabs.delete(73);
  const snapshot = await supervisor.dispatch("status");
  assert.equal(snapshot.binding.state, "off");
  assert.equal(snapshot.boundTab, null);
  assert.equal(snapshot.runtime.state, "off");
  assert.equal(snapshot.runtime.desired, false);
  assert.equal(snapshot.adapter.desired, false);
  assert.ok(runtime.calls.some(([operation]) => operation === "stop"));
  assert.equal(env.storage.session.values[CONTROL_SESSION_KEY].boundTabId, null);
  await supervisor.close();
});
