import assert from "node:assert/strict";
import { test } from "node:test";
import { createDownloadBroker } from "../src/download-broker.js";

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function fixture() {
  const items = new Map();
  const onCreated = event();
  const onChanged = event();
  const onDeterminingFilename = event();
  const downloadsApi = {
    onCreated,
    onChanged,
    onDeterminingFilename,
    async search({ id }) { return items.has(id) ? [items.get(id)] : []; },
  };
  const debuggerEvents = event();
  const calls = [];
  const coordinator = {
    async acquire(tabId, owner) { calls.push(["acquire", tabId, owner]); return true; },
    async release(tabId, owner) { calls.push(["release", tabId, owner]); return true; },
    async send(tabId, method, params) { calls.push(["send", tabId, method, params]); return null; },
    onEvent(listener) { debuggerEvents.addListener(listener); return () => debuggerEvents.removeListener(listener); },
  };
  return { downloadsApi, coordinator, debuggerEvents, calls, items };
}

test("captures one page-bound download, assigns a relative path, and returns a safe receipt", async () => {
  const env = fixture();
  const broker = createDownloadBroker({ downloadsApi: env.downloadsApi, coordinator: env.coordinator });
  let suggestion = null;
  const completed = {
    id: 7,
    state: "complete",
    filename: "/Users/test/Downloads/Greenways/Tripo/Wooden-chair.glb",
    finalUrl: "https://cdn.tripo3d.ai/file.glb?signature=secret",
    url: "https://cdn.tripo3d.ai/file.glb?signature=secret",
    referrer: "https://studio.tripo3d.ai/assets/wooden-chair",
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    danger: "safe",
    exists: true,
    fileSize: 1234,
    totalBytes: 1234,
    mime: "model/gltf-binary",
  };
  env.items.set(7, completed);

  const receipt = await broker.capture({
    owner: "test",
    tabId: 41,
    origin: "https://studio.tripo3d.ai",
    directory: "Greenways/Tripo",
    name: "Wooden chair",
    format: "glb",
    timeoutMs: 5000,
  }, async () => {
    env.debuggerEvents.emit(
      { tabId: 41 },
      "Page.downloadWillBegin",
      { guid: "guid-7", url: completed.url, suggestedFilename: "asset.glb" },
    );
    env.downloadsApi.onCreated.emit({ ...completed, state: "in_progress", endTime: undefined });
    env.downloadsApi.onDeterminingFilename.emit(
      { ...completed, state: "in_progress", filename: "asset.glb" },
      (value) => { suggestion = value; },
    );
    env.downloadsApi.onChanged.emit({ id: 7, state: { current: "complete" } });
    return true;
  });

  assert.deepEqual(suggestion, {
    filename: "Greenways/Tripo/Wooden-chair.glb",
    conflictAction: "uniquify",
  });
  assert.deepEqual(receipt, {
    protocol: "greenways.browser-download/0-alpha",
    id: 7,
    state: "complete",
    path: "/Users/test/Downloads/Greenways/Tripo/Wooden-chair.glb",
    "relative-path": "Greenways/Tripo/Wooden-chair.glb",
    mime: "model/gltf-binary",
    bytes: 1234,
    danger: "safe",
    "exists?": true,
    "started-at": completed.startTime,
    "ended-at": completed.endTime,
    source: { origin: "https://cdn.tripo3d.ai", pathname: "/file.glb" },
  });
  assert.deepEqual(env.calls[0].slice(0, 2), ["acquire", 41]);
  assert.deepEqual(env.calls[1], ["send", 41, "Page.enable", {}]);
  assert.deepEqual(env.calls.at(-1).slice(0, 2), ["release", 41]);
  await broker.close();
});

test("rejects absolute and parent-traversing download destinations before triggering", async () => {
  for (const directory of ["/tmp/out", "../out", "C:/out"]) {
    const env = fixture();
    const broker = createDownloadBroker({ downloadsApi: env.downloadsApi, coordinator: env.coordinator });
    let triggered = false;
    await assert.rejects(
      broker.capture({
        owner: "test",
        tabId: 41,
        origin: "https://studio.tripo3d.ai",
        directory,
        timeoutMs: 1000,
      }, async () => { triggered = true; return true; }),
      (error) => error.code === "download/invalid-destination",
    );
    assert.equal(triggered, false);
    await broker.close();
  }
});

test("does not accept a completed download Chrome classifies as dangerous", async () => {
  const env = fixture();
  const broker = createDownloadBroker({ downloadsApi: env.downloadsApi, coordinator: env.coordinator });
  const item = {
    id: 8,
    state: "complete",
    filename: "/Downloads/asset.glb",
    finalUrl: "https://cdn.tripo3d.ai/asset.glb",
    url: "https://cdn.tripo3d.ai/asset.glb",
    referrer: "https://studio.tripo3d.ai/assets/a",
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    danger: "uncommon",
    exists: true,
    fileSize: 12,
    totalBytes: 12,
    mime: "model/gltf-binary",
  };
  env.items.set(8, item);
  await assert.rejects(
    broker.capture({
      owner: "test",
      tabId: 41,
      origin: "https://studio.tripo3d.ai",
      timeoutMs: 5000,
    }, async () => {
      env.downloadsApi.onCreated.emit({ ...item, state: "in_progress" });
      env.downloadsApi.onChanged.emit({ id: 8, state: { current: "complete" } });
      return true;
    }),
    (error) => error.code === "download/dangerous" && error.data.danger === "uncommon",
  );
  await broker.close();
});
