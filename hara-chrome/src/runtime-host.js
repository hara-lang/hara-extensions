import { createBrowserBroker } from "../vendor/studio/broker.js";
import { createHostServices } from "../vendor/studio/host-services.js";
import { GraphHost } from "../vendor/studio/graph-host.js";
import { SessionRouter } from "../vendor/studio/session-router.js";
import { CapabilityRegistry } from "../vendor/studio/capability-registry.js";
import { createClockCapability } from "../vendor/studio/capabilities/clock.js";
import { createReconnectableHostCalls, mergeHostCalls, toPlain } from "./host-bridge.js";
import { connectResp as connectRespSocket, createBrowserRespHandler } from "./resp-client.js";
import { createRuntimeHostCore } from "./runtime-host-core.js";
import { HOST_CALL_PORT, RUNTIME_HOST_PORT, serializeError } from "./runtime-protocol.js";

const asset = (path) => chrome.runtime.getURL(path);
const ROOT = "ROOT";
let targetTabId = null;
let runtimePort = null;
let runtimePortGeneration = 0;
let reconnectTimer = null;
let runtimePortReady = deferred();
let nextProviderRequest = 1;
const providerPending = new Map();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fetchBytes(path) {
  return fetch(asset(path)).then((response) => {
    if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
    return response.arrayBuffer();
  }).then((buffer) => new Uint8Array(buffer));
}

async function fetchText(path) {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
  return response.text();
}

const hostCalls = createReconnectableHostCalls({
  connect: () => chrome.runtime.connect({ name: HOST_CALL_PORT }),
  target: () => ({ tabId: Number(targetTabId) || null }),
});

async function disposeBrokerEnvironment(environment) {
  const { broker, graphHost, sessionRouter } = environment;
  for (const preview of [...(broker.previews?.keys?.() ?? [])]) {
    await broker.disposePreview(preview).catch(() => {});
  }
  for (const document of [...(broker.documents?.values?.() ?? [])]) {
    broker.releaseDocument(document.kernel, document.documentId);
  }
  for (const name of [...(broker.kernels?.keys?.() ?? [])]) {
    if (name === ROOT) continue;
    await broker.close(name).catch(() => {});
  }
  const root = broker.kernels?.get?.(ROOT);
  if (root) {
    try { await broker.onKernelClosed?.(root); } catch { /* best effort */ }
    try { await root.context?.close?.(); } catch { /* best effort */ }
    try { root.worker?.terminate?.(); } catch { /* best effort */ }
    broker.kernels.delete(ROOT);
  }
  broker.pending?.clear?.();
  broker.documents?.clear?.();
  broker.previews?.clear?.();
  broker.rootStart = null;
  try { await graphHost?.close?.(); } catch { /* best effort */ }
  try { sessionRouter?.clear?.(); } catch { /* best effort */ }
}

async function loadRuntime() {
  const sessionRouter = new SessionRouter();
  const capabilityRegistry = new CapabilityRegistry({ adapters: {
    "clock/frame": createClockCapability(),
  } });
  const graphHost = new GraphHost({
    workerUrl: asset("vendor/studio/program-worker.js"),
    sessionRouter,
    capabilityRegistry,
  });
  const concreteHostCalls = createHostServices({
    graphHost,
    graphHostOptions: { sessionRouter },
  });
  const mergedHostCalls = mergeHostCalls(concreteHostCalls, hostCalls);
  const moduleBytes = await fetchBytes("vendor/hara.wasm");
  const resources = {
    "chrome.api": await fetchText("src/hara/api.hal"),
    "browser.dom": await fetchText("src/hara/dom.hal"),
    "browser.site.chatgpt": await fetchText("src/hara/chatgpt.hal"),
    "browser.site.tripo": await fetchText("src/hara/tripo.hal"),
  };
  for (const name of ["store", "boot", "node", "draw", "program", "graph", "session"]) {
    resources[`studio.${name}`] = await fetchText(`vendor/studio/hal/${name}.hal`);
  }

  const broker = createBrowserBroker({
    workerUrl: asset("vendor/hta-worker.js"),
    moduleBytes,
    hostCalls: mergedHostCalls,
    resources,
    onKernelStarting: async (kernel) => {
      const mount = await kernel.context.createFilesystem({ provider: "indexeddb", key: "hara-chrome" });
      await kernel.context.session().attachFilesystem(mount);
    },
    onKernelCreated: async (kernel) => sessionRouter.register(kernel.name, kernel.context, {
      onRelease: (sessionId) => graphHost.releaseSession(sessionId),
    }),
    onKernelClosed: (kernel) => sessionRouter.unregister(kernel.name),
  });
  const environment = { broker, graphHost, sessionRouter, capabilityRegistry };
  return {
    broker,
    dispose: () => disposeBrokerEnvironment(environment),
  };
}

function postRuntime(value) {
  try { runtimePort?.postMessage(value); } catch { /* service worker suspended */ }
}

async function waitForRuntimePort(timeoutMs = 10000) {
  if (runtimePort) return runtimePort;
  let timer;
  try {
    return await Promise.race([
      runtimePortReady.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("runtime/background-timeout: service worker did not accept the offscreen host");
          error.code = "runtime/background-timeout";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestProvider(method, args, requestedTabId) {
  const tabId = Number(requestedTabId ?? targetTabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    const error = new Error("runtime/provider-invalid-tab: page provider requires a bound tab");
    error.code = "runtime/provider-invalid-tab";
    throw error;
  }
  const activePort = await waitForRuntimePort();
  const id = nextProviderRequest++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      providerPending.delete(id);
      const error = new Error("runtime/provider-timeout: page target provider did not reply");
      error.code = "runtime/provider-timeout";
      reject(error);
    }, 15000);
    providerPending.set(id, { resolve, reject, timer });
    try {
      activePort.postMessage({
        channel: "provider-request",
        id,
        targetTabId: tabId,
        method,
        args,
      });
    } catch (error) {
      clearTimeout(timer);
      providerPending.delete(id);
      reject(error);
    }
  });
}

const core = createRuntimeHostCore({
  loadRuntime,
  connectResp: connectRespSocket,
  createRespHandler: createBrowserRespHandler,
  requestProvider,
  onStatus: (value) => {
    if (Object.hasOwn(value, "targetTabId")) targetTabId = value.targetTabId;
    postRuntime({ channel: "runtime-status", value });
  },
});

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBackground();
  }, 100);
}

function connectBackground() {
  if (runtimePort) return runtimePort;
  const port = chrome.runtime.connect({ name: RUNTIME_HOST_PORT });
  runtimePort = port;
  runtimePortReady.resolve(port);
  const generation = ++runtimePortGeneration;

  port.onMessage.addListener(async (message = {}) => {
    if (generation !== runtimePortGeneration) return;
    if (message.channel === "runtime-request") {
      try {
        const value = await core.dispatch(message.method, message.args ?? []);
        postRuntime({ channel: "runtime-response", id: message.id, ok: true, value: toPlain(value) });
      } catch (error) {
        postRuntime({ channel: "runtime-response", id: message.id, ok: false, ...serializeError(error) });
      }
      return;
    }
    if (message.channel === "provider-response") {
      const entry = providerPending.get(message.id);
      if (!entry) return;
      providerPending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else {
        const error = new Error(message.error ?? "page provider request failed");
        error.code = message.code ?? "runtime/provider-failed";
        error.data = message.data ?? null;
        entry.reject(error);
      }
      return;
    }
    if (message.channel === "runtime-supervisor-ready") {
      postRuntime({ channel: "runtime-status", value: core.snapshot() });
    }
  });

  port.onDisconnect.addListener(() => {
    if (generation !== runtimePortGeneration) return;
    runtimePort = null;
    runtimePortReady = deferred();
    for (const entry of providerPending.values()) {
      const error = new Error("runtime/provider-disconnected: service worker disconnected");
      error.code = "runtime/provider-disconnected";
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    providerPending.clear();
    scheduleReconnect();
  });

  postRuntime({ channel: "runtime-status", value: core.snapshot() });
}

connectBackground();
addEventListener("pagehide", () => {
  hostCalls.close?.();
  for (const entry of providerPending.values()) {
    clearTimeout(entry.timer);
    entry.reject(Object.assign(new Error("runtime host closed"), { code: "runtime/host-closed" }));
  }
  providerPending.clear();
}, { once: true });
setInterval(() => postRuntime({ channel: "runtime-status", value: core.snapshot(), heartbeat: true }), 20000);

globalThis.haraRuntimeHost = {
  protocol: "greenways.hara-runtime/0-alpha",
  dispatch: core.dispatch,
  status: core.snapshot,
};
