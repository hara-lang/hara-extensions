import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REMOTE_LANGUAGE_HOST_STORAGE_KEY,
  createRemoteLanguageHostController,
  parseRemoteLanguageHostConfig,
} from "../src/remote-language-host-core.js";
import { TEST_TOKEN, eventually } from "./remote-host-fixtures.js";

function storageHarness(initial = undefined) {
  let value = initial;
  const listeners = new Set();
  return {
    area: {
      get: async (key) => ({ [key]: value }),
    },
    events: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    set(next) {
      const oldValue = value;
      value = next;
      const changes = { [REMOTE_LANGUAGE_HOST_STORAGE_KEY]: { oldValue, newValue: next } };
      for (const listener of listeners) listener(changes, "local");
    },
    listenerCount: () => listeners.size,
  };
}

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    relayUrl: "http://127.0.0.1:8765",
    token: TEST_TOKEN,
    hostId: "hara.chrome.local",
    generation: 1,
    ...overrides,
  };
}

test("remote language-host configuration is explicit and closed", () => {
  assert.deepEqual(parseRemoteLanguageHostConfig(enabledConfig()), enabledConfig());
  assert.throws(() => parseRemoteLanguageHostConfig({ ...enabledConfig(), browser: true }));
  assert.throws(() => parseRemoteLanguageHostConfig({ ...enabledConfig(), enabled: false }));
  assert.throws(() => parseRemoteLanguageHostConfig({ ...enabledConfig(), relayUrl: "http://localhost:8765" }));
});

test("controller remains dormant without explicit storage configuration", async () => {
  const storage = storageHarness();
  let clients = 0;
  const controller = createRemoteLanguageHostController({
    storageArea: storage.area,
    storageEvents: storage.events,
    loadModuleBytes: async () => new Uint8Array([0, 97, 115, 109]),
    createSandbox: () => ({ run() {}, close() {} }),
    createExecutor: () => ({ execute() {}, close: async () => {} }),
    createClient: () => {
      clients += 1;
      throw new Error("client must not be created while disabled");
    },
    fetchImpl: async () => { throw new Error("fetch must not run"); },
  });
  try {
    const status = await controller.start();
    assert.equal(status.connectionState, "disabled");
    assert.equal(status.configured, false);
    assert.equal(clients, 0);
    assert.equal(storage.listenerCount(), 1);
  } finally {
    await controller.close();
  }
  assert.equal(storage.listenerCount(), 0);
});

test("controller publishes an eval-only descriptor and never projects the transport token", async () => {
  const storage = storageHarness(enabledConfig());
  const created = [];
  const closed = [];
  const controller = createRemoteLanguageHostController({
    storageArea: storage.area,
    storageEvents: storage.events,
    loadModuleBytes: async () => new Uint8Array([0, 97, 115, 109, 1, 2, 3]),
    createSandbox: () => ({ run() {}, close() {} }),
    createExecutor: () => ({ execute() {}, close: async () => {} }),
    createClient: (options) => {
      const record = { options, closed: false };
      created.push(record);
      return {
        start: async () => {
          options.onStatus({
            desiredState: "running",
            connectionState: "ready",
            hostId: options.descriptor.hostId,
            generation: options.descriptor.generation,
            relayOrigin: options.relayUrl,
            lastError: null,
          });
        },
        close: async () => {
          record.closed = true;
          closed.push(record);
        },
      };
    },
    fetchImpl: async () => { throw new Error("not used by fake client"); },
  });
  try {
    const status = await controller.start();
    assert.equal(created.length, 1);
    const options = created[0].options;
    assert.deepEqual(options.descriptor.operations, ["runtime.get", "sandbox.eval"]);
    assert.deepEqual(options.descriptor.profiles, ["hara.mcp-pure/0-alpha"]);
    assert.equal(options.descriptor.backend, "raw-wasm");
    assert.match(options.descriptor.runtimeBuild, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(options.pairingToken, TEST_TOKEN);
    assert.equal(status.connectionState, "ready");
    assert.equal(JSON.stringify(status).includes(TEST_TOKEN), false);

    storage.set(enabledConfig({ generation: 2 }));
    await eventually(() => created.length === 2);
    assert.equal(created[0].closed, true);
    assert.equal(created[1].options.descriptor.generation, 2);

    storage.set({ enabled: false });
    await eventually(() => controller.status().connectionState === "disabled");
    assert.equal(created[1].closed, true);
    assert.equal(controller.status().configured, false);
  } finally {
    await controller.close();
  }
  assert.equal(closed.length, 2);
});

test("controller recovers after an invalid configuration is replaced", async () => {
  const storage = storageHarness({ ...enabledConfig(), relayUrl: "http://localhost:8765" });
  let clients = 0;
  const controller = createRemoteLanguageHostController({
    storageArea: storage.area,
    storageEvents: storage.events,
    loadModuleBytes: async () => new Uint8Array([0, 97, 115, 109]),
    createSandbox: () => ({ run() {}, close() {} }),
    createExecutor: () => ({ execute() {}, close: async () => {} }),
    createClient: (options) => {
      clients += 1;
      return {
        start: async () => options.onStatus({
          desiredState: "running",
          connectionState: "ready",
          hostId: options.descriptor.hostId,
          generation: options.descriptor.generation,
          relayOrigin: options.relayUrl,
          lastError: null,
        }),
        close: async () => {},
      };
    },
    fetchImpl: async () => { throw new Error("not used by fake client"); },
  });
  try {
    await assert.rejects(controller.start());
    assert.equal(controller.status().connectionState, "faulted");
    storage.set(enabledConfig());
    await eventually(() => controller.status().connectionState === "ready");
    assert.equal(clients, 1);
  } finally {
    await controller.close();
  }
});
