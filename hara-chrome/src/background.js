import { CHATGPT_LOGIN_METHODS, createChatgptLoginService } from "./chatgpt-login-service.js";
import { createChatgptService } from "./chatgpt-service.js";
import { createContextProbe } from "./context-probe.js";
import { createControlSupervisor } from "./control-supervisor.js";
import { createDebuggerCoordinator, createDomService } from "./dom-service.js";
import { createDomExistenceProbe } from "./dom-existence-probe.js";
import { createDownloadBroker } from "./download-broker.js";
import {
  CONTROL_PORT,
  HOST_CALL_PORT,
  PAGE_PROVIDER_PORT,
  RUNTIME_CLIENT_PORT,
  RUNTIME_HOST_PORT,
} from "./runtime-protocol.js";
import { createRuntimeSupervisor } from "./runtime-supervisor.js";
import { TRIPO_DOWNLOAD_METHODS, createTripoDownloadService } from "./tripo-download-service.js";
import { TRIPO_LOGIN_METHODS, createTripoLoginService } from "./tripo-login-service.js";
import { createTripoService } from "./tripo-service.js";

const debuggerEvents = new Map();
const debuggerCoordinator = createDebuggerCoordinator(chrome);
const downloadBroker = createDownloadBroker({
  downloadsApi: chrome.downloads,
  coordinator: debuggerCoordinator,
});
let controlSupervisor = null;
const runtimeSupervisor = createRuntimeSupervisor({
  chromeApi: chrome,
  authorizeClientRequest: ({ tabId }) => controlSupervisor?.tabAllowed(tabId) ?? true,
});
const contextProbe = createContextProbe({ chromeApi: chrome, coordinator: debuggerCoordinator });
controlSupervisor = createControlSupervisor({
  chromeApi: chrome,
  runtimeSupervisor,
  probeContext: contextProbe.probe,
  downloadStatus: () => {
    const pending = downloadBroker._pending?.();
    if (!pending) return "idle";
    return pending.downloadId == null ? "armed" : "active";
  },
});
const controlReady = controlSupervisor.start();
controlReady.catch((error) => console.error("[hara control] startup", error));

let nextHostPort = 1;

chrome.runtime.onConnect.addListener((port) => {
  switch (port.name) {
    case CONTROL_PORT:
      void controlReady.then(() => controlSupervisor.connectPort(port));
      return;
    case RUNTIME_HOST_PORT:
      runtimeSupervisor.attachHostPort(port);
      return;
    case RUNTIME_CLIENT_PORT:
      runtimeSupervisor.attachClientPort(port);
      return;
    case PAGE_PROVIDER_PORT:
      runtimeSupervisor.attachProviderPort(port);
      return;
    case HOST_CALL_PORT:
      connectHaraHost(port);
      return;
    default:
      return;
  }
});

function connectHaraHost(port) {
  const portOwner = `hara-host-${nextHostPort++}`;
  const chromeDebuggerOwner = `${portOwner}:chrome-debugger`;
  const domService = createDomService({
    chromeApi: chrome,
    coordinator: debuggerCoordinator,
    owner: portOwner,
  });
  const chatgptService = createChatgptService({ domService });
  const domExistenceProbe = createDomExistenceProbe({
    coordinator: debuggerCoordinator,
    owner: portOwner,
  });
  const loginDomService = {
    dispatch: (method, args, target) => method === "query-exists"
      ? domExistenceProbe.dispatch(method, args, target)
      : domService.dispatch(method, args, target),
  };
  const chatgptLoginService = createChatgptLoginService({
    domService: loginDomService,
    chatgptService,
  });
  const tripoService = createTripoService({ domService });
  const tripoLoginService = createTripoLoginService({
    domService: loginDomService,
    tripoService,
  });
  const tripoDownloadService = createTripoDownloadService({
    domService,
    tripoService,
    downloadBroker,
    owner: portOwner,
  });

  const onMessage = async ({ id, service, method, args, target } = {}) => {
    try {
      const value = await dispatchHost(service, method, args ?? [], target, {
        chromeDebuggerOwner,
        domService,
        chatgptService,
        chatgptLoginService,
        tripoService,
        tripoLoginService,
        tripoDownloadService,
      });
      port.postMessage({ id, ok: true, value: sanitize(value) });
    } catch (error) {
      port.postMessage({
        id,
        ok: false,
        error: String(error?.message ?? error),
        code: error?.code ?? null,
        data: error?.data ?? null,
      });
    }
  };
  port.onMessage.addListener(onMessage);

  port.onDisconnect.addListener(() => {
    for (const entry of debuggerEvents.values()) {
      for (const waiter of entry.waiters) waiter.reject(new Error("hara host disconnected"));
      entry.waiters = [];
    }
    void Promise.allSettled([
      tripoDownloadService.close(),
      tripoLoginService.close(),
      tripoService.close(),
      chatgptLoginService.close(),
      chatgptService.close(),
      domExistenceProbe.close(),
      domService.close(),
      debuggerCoordinator.releaseOwner(chromeDebuggerOwner),
    ]);
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const entry = debuggerEvents.get(source.tabId) ?? { queue: [], waiters: [] };
  const waiter = entry.waiters.shift();
  if (waiter) waiter.resolve({ method, params });
  else entry.queue.push({ method, params });
  debuggerEvents.set(source.tabId, entry);
});

chrome.debugger.onDetach.addListener((source) => {
  const entry = debuggerEvents.get(source.tabId);
  if (!entry) return;
  debuggerEvents.delete(source.tabId);
  for (const waiter of entry.waiters) waiter.reject(new Error("debugger detached"));
});

function targetTabId(target) {
  const value = Number(target?.tabId ?? target?.["tab-id"]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function requireTabAuthority(target) {
  const tabId = targetTabId(target);
  if (tabId && await controlSupervisor.tabAllowed(tabId)) return tabId;
  const error = new Error("control/tab-disabled: browser control is disabled for this tab");
  error.code = "control/tab-disabled";
  error.data = { tabId };
  throw error;
}

async function requireAdapterAuthority(target, kind) {
  const tabId = targetTabId(target);
  if (tabId && await controlSupervisor.adapterAllowed(tabId, kind)) return tabId;
  const error = new Error(`control/adapter-disabled: ${kind} adapter is disabled for this tab`);
  error.code = "control/adapter-disabled";
  error.data = { tabId, adapter: kind };
  throw error;
}

async function dispatchHost(service, method, args, target, context) {
  if (service === "hara" && method === "echo") return args[0] ?? null;
  if (service === "hara.dom") {
    await requireTabAuthority(target);
    return context.domService.dispatch(method, args, target);
  }
  if (service === "hara.chatgpt") {
    await requireAdapterAuthority(target, "chatgpt");
    const owner = CHATGPT_LOGIN_METHODS.has(method)
      ? context.chatgptLoginService
      : context.chatgptService;
    return owner.dispatch(method, args, target);
  }
  if (service === "hara.tripo") {
    await requireAdapterAuthority(target, "tripo");
    if (TRIPO_DOWNLOAD_METHODS.has(method)) {
      return context.tripoDownloadService.dispatch(method, args, target);
    }
    const owner = TRIPO_LOGIN_METHODS.has(method)
      ? context.tripoLoginService
      : context.tripoService;
    return owner.dispatch(method, args, target);
  }
  if (service === "chrome.debugger") {
    return debuggerCall(method, args, context.chromeDebuggerOwner);
  }
  if (!String(service ?? "").startsWith("chrome.")) {
    throw new Error(`host-call-denied: ${service}`);
  }
  const owner = service
    .slice("chrome.".length)
    .split(".")
    .reduce((value, key) => value?.[key], chrome);
  const fn = owner?.[method];
  if (typeof fn !== "function") {
    throw new Error(`unknown chrome api: ${service}/${method}`);
  }
  return (await fn.apply(owner, args)) ?? null;
}

/** HTA0 has no float tag; coerce non-safe-integer numbers so results survive encoding. */
function sanitize(value) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

async function debuggerCall(method, args, owner) {
  const [tabId, ...rest] = args;
  switch (method) {
    case "attach":
      await debuggerCoordinator.acquire(tabId, owner);
      return null;
    case "detach":
      await debuggerCoordinator.release(tabId, owner);
      return null;
    case "sendCommand": {
      const [command, params] = rest;
      return (await debuggerCoordinator.send(tabId, command, params ?? {})) ?? null;
    }
    case "next-event": {
      const entry = debuggerEvents.get(tabId) ?? { queue: [], waiters: [] };
      const queued = entry.queue.shift();
      if (queued) return queued;
      return new Promise((resolve, reject) => {
        entry.waiters.push({ resolve, reject });
        debuggerEvents.set(tabId, entry);
      });
    }
    default:
      throw new Error(`unknown chrome.debugger method: ${method}`);
  }
}

// Test and diagnostics hooks. These are extension-only objects, not page globals.
globalThis.haraRuntimeSupervisor = runtimeSupervisor;
globalThis.haraControlSupervisor = controlSupervisor;
