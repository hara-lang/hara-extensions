import {
  OFFSCREEN_PATH,
  PAGE_PROVIDER_PORT,
  RUNTIME_CLIENT_PORT,
  RUNTIME_HOST_PORT,
  checkedTabId,
  fail,
  runtimeStatus,
  serializeError,
} from "./runtime-protocol.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function createRuntimeSupervisor({
  chromeApi,
  now = () => Date.now(),
  hostTimeoutMs = 15000,
  providerTimeoutMs = 15000,
  authorizeClientRequest = async () => true,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!chromeApi?.runtime || !chromeApi?.offscreen) {
    throw new TypeError("createRuntimeSupervisor requires chrome.runtime and chrome.offscreen");
  }
  if (typeof authorizeClientRequest !== "function") {
    throw new TypeError("runtime client authorizer must be a function");
  }

  const offscreenUrl = chromeApi.runtime.getURL(OFFSCREEN_PATH);
  let creating = null;
  let hostPort = null;
  let hostEpoch = 0;
  let hostReady = deferred();
  let nextRequest = 1;
  let nextProviderRequest = 1;
  let status = runtimeStatus();
  let closed = false;
  const pending = new Map();
  const clients = new Set();
  const statusListeners = new Set();
  const providers = new Map();
  const providerPending = new Map();

  async function hasDocument() {
    if (typeof chromeApi.runtime.getContexts === "function") {
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      });
      return contexts.length > 0;
    }
    if (typeof chromeApi.offscreen.hasDocument === "function") {
      return chromeApi.offscreen.hasDocument();
    }
    return false;
  }

  function resetHostReady() {
    hostReady = deferred();
  }

  function post(port, value) {
    try { port.postMessage(value); } catch { /* context already closed */ }
  }

  function publish(next) {
    status = runtimeStatus({ ...status, ...next, generation: (status.generation ?? 0) + 1 });
    for (const client of clients) post(client, { channel: "runtime-status", value: status });
    for (const listener of statusListeners) {
      try { listener(status); } catch { /* observer isolation */ }
    }
    return status;
  }

  async function ensureDocument() {
    if (closed) fail("runtime/supervisor-closed", "runtime supervisor has been closed");
    if (hostPort) return hostPort;
    if (!(await hasDocument())) {
      creating ??= chromeApi.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Run the Hara WASM broker, evaluator workers, filesystem sessions, and RESP client independently of popup and DevTools UI lifetimes.",
      }).finally(() => { creating = null; });
      await creating;
    }
    if (hostPort) return hostPort;

    let timer;
    try {
      return await Promise.race([
        hostReady.promise,
        new Promise((_, reject) => {
          timer = setTimeoutImpl(() => {
            const error = new Error("runtime/offscreen-timeout: offscreen runtime did not register");
            error.code = "runtime/offscreen-timeout";
            reject(error);
          }, hostTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeoutImpl(timer);
    }
  }

  function rejectPending(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function attachHostPort(port) {
    if (closed) {
      try { port.disconnect(); } catch { /* already closed */ }
      return;
    }
    if (hostPort && hostPort !== port) {
      try { hostPort.disconnect(); } catch { /* stale */ }
    }
    hostPort = port;
    hostEpoch += 1;
    const epoch = hostEpoch;
    hostReady.resolve(port);

    const onMessage = (message = {}) => {
      if (epoch !== hostEpoch) return;
      if (message.channel === "runtime-response") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.value);
        else {
          const error = new Error(message.error ?? "runtime request failed");
          error.code = message.code ?? "runtime/request-failed";
          error.data = message.data ?? null;
          entry.reject(error);
        }
        return;
      }
      if (message.channel === "runtime-status") {
        publish(message.value ?? {});
        return;
      }
      if (message.channel === "provider-request") {
        void forwardProviderRequest(message);
      }
    };

    const onDisconnect = () => {
      if (epoch !== hostEpoch) return;
      hostPort = null;
      resetHostReady();
      const error = new Error("runtime/host-disconnected: offscreen runtime host disconnected");
      error.code = "runtime/host-disconnected";
      rejectPending(error);
      for (const [id, entry] of providerPending) {
        providerPending.delete(id);
        clearTimeoutImpl(entry.timer);
        try {
          entry.port.postMessage({
            channel: "provider-cancel",
            id,
            code: "runtime/host-disconnected",
          });
        } catch { /* provider already closed */ }
      }
      publish({ runtimeState: "off", respState: "off", kernel: null, instanceId: null });
    };

    port.onMessage?.addListener?.(onMessage);
    port.onDisconnect?.addListener?.(onDisconnect);
    post(port, { channel: "runtime-supervisor-ready", epoch, now: now() });
    return port;
  }

  async function request(method, args = [], { ensure = true } = {}) {
    if (closed) fail("runtime/supervisor-closed", "runtime supervisor has been closed");
    const port = ensure ? await ensureDocument() : hostPort;
    if (!port) fail("runtime/host-unavailable", "offscreen runtime host is not connected");
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
      try {
        port.postMessage({ channel: "runtime-request", id, method, args });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function attachClientPort(port) {
    if (closed) {
      try { port.disconnect(); } catch { /* already closed */ }
      return;
    }
    let registeredTabId = null;
    clients.add(port);
    post(port, { channel: "runtime-status", value: status });
    const onMessage = async (message = {}) => {
      if (message.channel === "runtime-client-register") {
        try {
          registeredTabId = checkedTabId(message.targetTabId, "runtime/client-invalid-tab");
          post(port, { channel: "runtime-client-registered", targetTabId: registeredTabId });
        } catch (error) {
          post(port, { channel: "runtime-client-registration-failed", ...serializeError(error) });
        }
        return;
      }
      if (message.channel !== "runtime-request") return;
      try {
        if (!registeredTabId) fail("runtime/client-unregistered", "runtime client must register its exact target tab before sending requests");
        const requestedTabId = Number(message.args?.[0]?.targetTabId);
        if (["runtime.start", "runtime.bind"].includes(message.method) && requestedTabId !== registeredTabId) {
          fail("runtime/client-target-mismatch", "runtime client cannot bind a target other than its registered tab", {
            registeredTabId,
            requestedTabId: Number.isFinite(requestedTabId) ? requestedTabId : null,
          });
        }
        const allowed = await authorizeClientRequest({
          tabId: registeredTabId,
          method: message.method,
          args: message.args ?? [],
          port,
        });
        if (!allowed) fail("control/tab-disabled", "runtime client is not authorized for the controlled tab", { tabId: registeredTabId });
        const value = await request(message.method, message.args ?? []);
        post(port, { channel: "runtime-response", id: message.id, ok: true, value });
      } catch (error) {
        post(port, { channel: "runtime-response", id: message.id, ok: false, ...serializeError(error) });
      }
    };
    const onDisconnect = () => {
      clients.delete(port);
      port.onMessage?.removeListener?.(onMessage);
    };
    port.onMessage?.addListener?.(onMessage);
    port.onDisconnect?.addListener?.(onDisconnect);
  }

  function providerSet(tabId) {
    let set = providers.get(tabId);
    if (!set) providers.set(tabId, set = new Set());
    return set;
  }

  function attachProviderPort(port) {
    let registeredTabId = null;
    const onMessage = (message = {}) => {
      if (message.channel === "provider-register") {
        const tabId = checkedTabId(message.targetTabId, "runtime/provider-invalid-tab");
        if (registeredTabId && providers.has(registeredTabId)) providers.get(registeredTabId).delete(port);
        registeredTabId = tabId;
        providerSet(tabId).add(port);
        post(port, { channel: "provider-registered", targetTabId: tabId });
        return;
      }
      if (message.channel === "provider-response") {
        const entry = providerPending.get(message.id);
        if (!entry) return;
        providerPending.delete(message.id);
        clearTimeoutImpl(entry.timer);
        if (message.ok) {
          post(hostPort, { channel: "provider-response", id: entry.hostId, ok: true, value: message.value });
        } else {
          post(hostPort, {
            channel: "provider-response",
            id: entry.hostId,
            ok: false,
            error: message.error ?? "page provider request failed",
            code: message.code ?? "runtime/provider-failed",
            data: message.data ?? null,
          });
        }
      }
    };
    const onDisconnect = () => {
      if (registeredTabId && providers.has(registeredTabId)) {
        const set = providers.get(registeredTabId);
        set.delete(port);
        if (set.size === 0) providers.delete(registeredTabId);
      }
      for (const [id, entry] of providerPending) {
        if (entry.port !== port) continue;
        providerPending.delete(id);
        clearTimeoutImpl(entry.timer);
        post(hostPort, {
          channel: "provider-response",
          id: entry.hostId,
          ok: false,
          error: "page target provider disconnected",
          code: "runtime/provider-disconnected",
        });
      }
    };
    port.onMessage?.addListener?.(onMessage);
    port.onDisconnect?.addListener?.(onDisconnect);
  }

  async function forwardProviderRequest(message) {
    const tabId = Number(message.targetTabId);
    const set = providers.get(tabId);
    const port = set ? [...set][0] : null;
    if (!port) {
      post(hostPort, {
        channel: "provider-response",
        id: message.id,
        ok: false,
        error: `no page target provider is connected for tab ${tabId}`,
        code: "runtime/provider-unavailable",
      });
      return;
    }
    const id = nextProviderRequest++;
    const timer = setTimeoutImpl(() => {
      const entry = providerPending.get(id);
      if (!entry) return;
      providerPending.delete(id);
      post(hostPort, {
        channel: "provider-response",
        id: entry.hostId,
        ok: false,
        error: "page target provider did not reply before the timeout",
        code: "runtime/provider-timeout",
      });
    }, providerTimeoutMs);
    providerPending.set(id, { hostId: message.id, port, timer });
    post(port, {
      channel: "provider-request",
      id,
      method: message.method,
      args: message.args ?? [],
      targetTabId: tabId,
    });
  }

  async function start(targetTabId) {
    const tabId = checkedTabId(targetTabId);
    const value = await request("runtime.start", [{ targetTabId: tabId }]);
    publish(value?.status ?? {});
    return value;
  }

  async function bindTarget(targetTabId) {
    const tabId = checkedTabId(targetTabId);
    const value = await request("runtime.bind", [{ targetTabId: tabId }]);
    publish(value?.status ?? {});
    return value;
  }

  async function connectResp(url) {
    const value = await request("resp.connect", [{ url }]);
    publish(value?.status ?? {});
    return value;
  }

  async function disconnectResp() {
    if (!hostPort && !(await hasDocument())) return { status };
    try {
      const value = await request("resp.disconnect", [], { ensure: true });
      publish(value?.status ?? {});
      return value;
    } catch (error) {
      if (["runtime/host-unavailable", "runtime/offscreen-timeout"].includes(error?.code)) {
        publish({ respState: "off" });
        return { status };
      }
      throw error;
    }
  }

  async function stop({ closeDocument = true } = {}) {
    let value = { status: runtimeStatus() };
    if (hostPort || await hasDocument()) {
      try {
        value = await request("runtime.stop", [], { ensure: true });
      } catch (error) {
        if (!["runtime/host-unavailable", "runtime/offscreen-timeout"].includes(error?.code)) throw error;
      }
    }
    if (closeDocument && await hasDocument()) {
      try { await chromeApi.offscreen.closeDocument(); } catch { /* already closed */ }
      hostPort = null;
      resetHostReady();
    }
    publish({ runtimeState: "off", respState: "off", kernel: null, kernels: [], pending: [], documents: [], instanceId: null });
    return value;
  }

  function onStatus(listener) {
    statusListeners.add(listener);
    listener(status);
    return () => statusListeners.delete(listener);
  }

  async function close() {
    if (closed) return true;
    await stop({ closeDocument: true }).catch(() => {});
    closed = true;
    rejectPending(new Error("runtime supervisor closed"));
    for (const client of clients) {
      try { client.disconnect(); } catch { /* already closed */ }
    }
    clients.clear();
    providers.clear();
    for (const entry of providerPending.values()) clearTimeoutImpl(entry.timer);
    providerPending.clear();
    statusListeners.clear();
    return true;
  }

  return {
    ensureDocument,
    hasDocument,
    attachHostPort,
    attachClientPort,
    attachProviderPort,
    request,
    start,
    bindTarget,
    connectResp,
    disconnectResp,
    stop,
    onStatus,
    status: () => status,
    close,
    portNames: { host: RUNTIME_HOST_PORT, client: RUNTIME_CLIENT_PORT, provider: PAGE_PROVIDER_PORT },
    _state: () => ({ hostPort, clients: new Set(clients), providers, pending }),
  };
}
