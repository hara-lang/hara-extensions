import { createHaraRelayHostClient } from "./remote-host-client.js";
import {
  EXECUTION_HOST_PROTOCOL,
  PURE_PROFILE,
  REMOTE_HOST_MAX_OUTPUT_BYTES,
  REMOTE_HOST_MAX_SOURCE_BYTES,
  REMOTE_HOST_MAX_WALL_MS,
  REMOTE_HOST_OPERATIONS,
  cloneJson,
  parseHostDescriptor,
  validatePairingToken,
  validateRelayBaseUrl,
} from "./remote-host-protocol.js";
import { createCanonicalRemoteSandboxExecutor } from "./remote-sandbox-executor.js";

export const REMOTE_LANGUAGE_HOST_STORAGE_KEY = "hara.language-host.local/0-alpha";
export const REMOTE_LANGUAGE_HOST_VERSION = "hara-raw-wasm/0-alpha";

const CONFIG_KEYS = new Set(["enabled", "relayUrl", "token", "hostId", "generation"]);

function hostError(code, message, data = null) {
  const error = new Error(message);
  error.name = "RemoteLanguageHostError";
  error.code = code;
  error.data = data;
  return error;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw hostError("remote/config-invalid", `${label} must be a function`);
  return value;
}

function exactObject(value, label, allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw hostError("remote/config-invalid", `${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw hostError("remote/config-invalid", `${label} contains unknown field ${key}`);
  }
  return value;
}

function checkedHostId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw hostError("remote/config-invalid", "hostId must be a stable Hara identifier");
  }
  return value;
}

function checkedGeneration(value) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw hostError("remote/config-invalid", "generation must be a non-negative integer");
  }
  return value;
}

export function parseRemoteLanguageHostConfig(value) {
  const config = exactObject(value, "remote language-host config", CONFIG_KEYS);
  if (config.enabled !== true) throw hostError("remote/config-invalid", "enabled must be true");
  for (const key of ["relayUrl", "token", "hostId", "generation"]) {
    if (!Object.hasOwn(config, key)) throw hostError("remote/config-invalid", `remote language-host config requires ${key}`);
  }
  return Object.freeze({
    enabled: true,
    relayUrl: validateRelayBaseUrl(config.relayUrl),
    token: validatePairingToken(config.token),
    hostId: checkedHostId(config.hostId),
    generation: checkedGeneration(config.generation),
  });
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw hostError("remote/runtime-invalid", "loadModuleBytes must return Uint8Array or ArrayBuffer");
}

async function sha256Bytes(value) {
  if (!globalThis.crypto?.subtle) throw hostError("remote/crypto-unavailable", "Web Crypto SHA-256 is required");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function safeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 128) : "remote/unavailable",
    message: String(error?.message ?? error ?? "remote language host failed").slice(0, 1_024),
  };
}

function configFingerprint(config) {
  return JSON.stringify([config.relayUrl, config.token, config.hostId, config.generation]);
}

export function createRemoteLanguageHostController(options = {}) {
  const storageArea = options.storageArea;
  const storageEvents = options.storageEvents;
  if (!storageArea || typeof storageArea.get !== "function") {
    throw hostError("remote/config-invalid", "storageArea.get is required");
  }
  if (!storageEvents || typeof storageEvents.addListener !== "function" || typeof storageEvents.removeListener !== "function") {
    throw hostError("remote/config-invalid", "storageEvents addListener/removeListener are required");
  }
  const loadModuleBytes = checkedFunction(options.loadModuleBytes, "loadModuleBytes");
  const createSandbox = checkedFunction(options.createSandbox, "createSandbox");
  const createExecutor = checkedFunction(
    options.createExecutor ?? createCanonicalRemoteSandboxExecutor,
    "createExecutor",
  );
  const createClient = checkedFunction(options.createClient ?? createHaraRelayHostClient, "createClient");
  const fetchImpl = checkedFunction(options.fetchImpl ?? globalThis.fetch, "fetchImpl");
  const now = checkedFunction(options.now ?? (() => new Date()), "now");
  const onStatus = checkedFunction(options.onStatus ?? (() => {}), "onStatus");
  const storageKey = options.storageKey ?? REMOTE_LANGUAGE_HOST_STORAGE_KEY;

  let client = null;
  let executor = null;
  let activeFingerprint = null;
  let modulePromise = null;
  let started = false;
  let closed = false;
  let operation = Promise.resolve();
  let state = {
    desiredState: "disabled",
    connectionState: "disabled",
    configured: false,
    hostId: null,
    generation: null,
    relayOrigin: null,
    runtimeBuild: null,
    operations: [...REMOTE_HOST_OPERATIONS],
    profile: PURE_PROFILE,
    lastError: null,
  };

  function snapshot() {
    return cloneJson(state);
  }

  function publish(patch) {
    state = { ...state, ...patch };
    try {
      onStatus(snapshot());
    } catch {
      // Diagnostics observers cannot affect execution authority.
    }
    return snapshot();
  }

  async function runtimeArtifact() {
    modulePromise ??= Promise.resolve(loadModuleBytes()).then(async (value) => {
      const moduleBytes = bytes(value).slice();
      return Object.freeze({ moduleBytes, runtimeBuild: await sha256Bytes(moduleBytes) });
    });
    return modulePromise;
  }

  async function stopCurrent() {
    const currentClient = client;
    const currentExecutor = executor;
    client = null;
    executor = null;
    activeFingerprint = null;
    if (currentClient) await currentClient.close().catch(() => {});
    else if (currentExecutor) await currentExecutor.close().catch(() => {});
  }

  async function readConfig() {
    const stored = await storageArea.get(storageKey);
    return stored?.[storageKey];
  }

  async function applyStoredConfig() {
    if (closed) return snapshot();
    const raw = await readConfig();
    if (raw === undefined || raw === null || raw?.enabled === false) {
      await stopCurrent();
      return publish({
        desiredState: "disabled",
        connectionState: "disabled",
        configured: false,
        hostId: null,
        generation: null,
        relayOrigin: null,
        runtimeBuild: null,
        lastError: null,
      });
    }

    const config = parseRemoteLanguageHostConfig(raw);
    const fingerprint = configFingerprint(config);
    if (client && activeFingerprint === fingerprint) return snapshot();

    await stopCurrent();
    publish({
      desiredState: "running",
      connectionState: "preparing",
      configured: true,
      hostId: config.hostId,
      generation: config.generation,
      relayOrigin: config.relayUrl,
      lastError: null,
    });

    const artifact = await runtimeArtifact();
    const descriptor = parseHostDescriptor({
      protocol: EXECUTION_HOST_PROTOCOL,
      hostId: config.hostId,
      generation: config.generation,
      kind: "browser-wasm",
      state: "ready",
      backend: "raw-wasm",
      runtimeBuild: artifact.runtimeBuild,
      haraVersion: REMOTE_LANGUAGE_HOST_VERSION,
      profiles: [PURE_PROFILE],
      operations: [...REMOTE_HOST_OPERATIONS],
      limits: {
        maxSourceBytes: REMOTE_HOST_MAX_SOURCE_BYTES,
        maxOutputBytes: REMOTE_HOST_MAX_OUTPUT_BYTES,
        maxWallMs: REMOTE_HOST_MAX_WALL_MS,
      },
      observedAt: now().toISOString(),
    });

    executor = createExecutor({
      createSandbox: ({ request, descriptor: selected }) => createSandbox({
        request,
        descriptor: selected,
        moduleBytes: artifact.moduleBytes.slice(),
      }),
      now,
    });
    const selectedExecutor = executor;
    client = createClient({
      relayUrl: config.relayUrl,
      pairingToken: config.token,
      descriptor,
      executor: selectedExecutor,
      fetchImpl,
      now,
      onStatus: (clientStatus) => {
        publish({
          desiredState: clientStatus.desiredState,
          connectionState: clientStatus.connectionState,
          configured: true,
          hostId: clientStatus.hostId,
          generation: clientStatus.generation,
          relayOrigin: clientStatus.relayOrigin,
          runtimeBuild: descriptor.runtimeBuild,
          lastError: clientStatus.lastError,
        });
      },
    });
    activeFingerprint = fingerprint;
    publish({ runtimeBuild: descriptor.runtimeBuild });
    await client.start();
    return snapshot();
  }

  function refresh() {
    operation = operation
      .catch(() => {})
      .then(() => applyStoredConfig())
      .catch((error) => {
        publish({
          desiredState: "stopped",
          connectionState: "faulted",
          lastError: safeError(error),
        });
        throw error;
      });
    return operation;
  }

  const onStorageChanged = (changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes ?? {}, storageKey)) return;
    void refresh().catch(() => {});
  };

  function start() {
    if (closed) return Promise.reject(hostError("remote/closed", "remote language host is closed"));
    if (!started) {
      started = true;
      storageEvents.addListener(onStorageChanged);
    }
    return refresh();
  }

  async function close() {
    if (closed) return snapshot();
    closed = true;
    if (started) storageEvents.removeListener(onStorageChanged);
    started = false;
    await operation.catch(() => {});
    await stopCurrent();
    return publish({ desiredState: "closed", connectionState: "closed" });
  }

  return Object.freeze({ start, refresh, close, status: snapshot, storageKey });
}
