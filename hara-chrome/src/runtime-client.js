import { fromPlain, toPlain } from "./host-bridge.js";
import {
  PAGE_PROVIDER_PORT,
  RUNTIME_CLIENT_PORT,
  checkedTabId,
  serializeError,
} from "./runtime-protocol.js";

function remoteMount(id) {
  return Object.freeze({ __haraRemoteMount: String(id) });
}

function remoteCandidate(value) {
  return {
    ...value,
    __haraRemoteCandidate: String(value.candidateId),
  };
}

function documentKey(kernel, documentId) {
  return `${kernel}\u0000${documentId}`;
}

export function createRemoteBroker(connection) {
  const pending = new Map();
  const documents = new Map();
  const previews = new Map();
  const contexts = new Map();
  const committing = new Map();
  let currentInstanceId = null;
  let snapshot = {
    runtimeState: "off",
    kernels: [],
    pending: [],
    documents: [],
  };

  function applySnapshot(next) {
    if (!next || typeof next !== "object") return;
    const nextInstanceId = Object.hasOwn(next, "instanceId")
      ? next.instanceId
      : snapshot.instanceId ?? null;
    if (currentInstanceId !== null && nextInstanceId !== currentInstanceId) {
      contexts.clear();
      previews.clear();
      committing.clear();
    }
    if (next.runtimeState === "off") {
      contexts.clear();
      previews.clear();
      committing.clear();
    }
    currentInstanceId = nextInstanceId;
    snapshot = { ...snapshot, ...next };
    pending.clear();
    for (const name of snapshot.pending ?? []) pending.set(name, true);
    documents.clear();
    for (const document of snapshot.documents ?? []) {
      documents.set(documentKey(document.kernel, document.documentId), document);
    }
  }

  connection.onStatus(applySnapshot);

  async function envelope(method, args = []) {
    const response = await connection.request(method, args);
    applySnapshot(response?.snapshot ?? response?.status);
    return response?.value;
  }

  function contextFor(kernelName) {
    let context = contexts.get(kernelName);
    if (context) return context;
    const sessionFor = (sessionName = "ROOT") => ({
      attachFilesystem: async (mount) => {
        const mountId = mount?.__haraRemoteMount;
        if (!mountId) throw new Error("runtime/invalid-mount: filesystem mount is not owned by the offscreen runtime");
        return envelope("context.attach-filesystem", [kernelName, sessionName, mountId]);
      },
      call: async (operation, args = []) => fromPlain(
        await envelope("context.call", [kernelName, sessionName, operation, args]),
      ),
      close: async () => true,
    });
    context = {
      createFilesystem: async (options = {}) => {
        const value = await envelope("context.create-filesystem", [kernelName, options]);
        return remoteMount(value.mountId);
      },
      session: sessionFor,
      call: async (operation, args = []) => fromPlain(
        await envelope("context.call", [kernelName, null, operation, args]),
      ),
      close: async () => true,
    };
    contexts.set(kernelName, context);
    return context;
  }

  function kernelFor(name) {
    return { name, context: contextFor(name), worker: null, sessions: new Set(["ROOT"]) };
  }

  const broker = {
    pending,
    documents,
    list() {
      const names = [...(snapshot.kernels ?? [])];
      if (snapshot.runtimeState !== "off" && !names.includes("ROOT")) names.unshift("ROOT");
      return names.length ? names : ["ROOT"];
    },
    size() { return this.list().length; },
    async require(name = "ROOT") {
      const value = await envelope("broker.require", [name]);
      return kernelFor(value?.name ?? name);
    },
    async eval(name, source) {
      return fromPlain(await envelope("broker.eval", [name, source]));
    },
    async create(name, options = {}) {
      await envelope("broker.create", [name, options]);
      return kernelFor(name);
    },
    async close(name) {
      contexts.delete(name);
      return envelope("broker.close", [name]);
    },
    async previewDocument(kernel, documentId, forms, options = {}) {
      const value = await envelope("broker.preview-document", [kernel, documentId, forms, options]);
      const traces = new Map();
      for (const [traceId, trace] of Object.entries(value?.traces ?? {})) {
        traces.set(traceId, fromPlain(trace));
      }
      previews.set(value.generationId, traces);
      const result = { ...value };
      delete result.traces;
      return result;
    },
    getPreviewTrace(generationId, traceId) {
      const trace = previews.get(generationId)?.get(traceId);
      if (!trace) throw new Error(`NO_PREVIEW_TRACE ${traceId}`);
      return trace;
    },
    async disposePreview(generationId) {
      previews.delete(generationId);
      return envelope("broker.dispose-preview", [generationId]);
    },
    hasDocument(kernel, documentId) {
      const key = documentKey(kernel, documentId);
      return documents.has(key) || committing.has(key);
    },
    async evalForm(kernel, documentId, source) {
      const key = documentKey(kernel, documentId);
      if (committing.has(key)) await committing.get(key);
      return fromPlain(await envelope("broker.eval-form", [kernel, documentId, source]));
    },
    async prepareDocument(kernel, documentId, source, options = {}) {
      const value = await envelope("broker.prepare-document", [kernel, documentId, source, options]);
      return remoteCandidate({ ...value, value: fromPlain(value.value) });
    },
    async evalPreparedDocument(candidate, source) {
      return fromPlain(await envelope("broker.eval-prepared-document", [candidate.__haraRemoteCandidate, source]));
    },
    commitDocument(candidate) {
      if (!candidate?.__haraRemoteCandidate) throw new Error("INVALID_DOCUMENT_CANDIDATE");
      const result = {
        kernel: candidate.kernel,
        documentId: candidate.documentId,
        generation: candidate.generation,
        moduleId: candidate.moduleId,
        nodeId: candidate.nodeId ?? null,
        value: candidate.value,
      };
      const key = documentKey(candidate.kernel, candidate.documentId);
      documents.set(key, result);
      const completion = envelope("broker.commit-document", [candidate.__haraRemoteCandidate]).then(
        () => result,
        (error) => {
          documents.delete(key);
          connection.reportError(error);
          throw error;
        },
      ).finally(() => committing.delete(key));
      completion.catch(() => {});
      committing.set(key, completion);
      candidate.prepared = false;
      return result;
    },
    discardDocument(candidate) {
      if (!candidate?.__haraRemoteCandidate || candidate.prepared === false) return false;
      candidate.prepared = false;
      void envelope("broker.discard-document", [candidate.__haraRemoteCandidate]).catch(connection.reportError);
      return true;
    },
    async traceEval(kernel, session, source) {
      return fromPlain(await envelope("broker.trace-eval", [kernel, session, source]));
    },
    async listSessions(kernel) {
      return envelope("broker.list-sessions", [kernel]);
    },
    async createSession(kernel, session, options = {}) {
      return envelope("broker.create-session", [kernel, session, options]);
    },
    async closeSession(kernel, session) {
      return envelope("broker.close-session", [kernel, session]);
    },
    async evalSession(kernel, session, source) {
      return fromPlain(await envelope("broker.eval-session", [kernel, session, source]));
    },
    async evalDocument(kernel, documentId, source, options = {}) {
      const value = await envelope("broker.eval-document", [kernel, documentId, source, options]);
      const result = { ...value, value: fromPlain(value?.value) };
      documents.set(documentKey(kernel, documentId), result);
      return result;
    },
    async releaseDocument(kernel, documentId) {
      const key = documentKey(kernel, documentId);
      const inFlightCommit = committing.get(key);
      if (inFlightCommit) await inFlightCommit;
      documents.delete(key);
      return envelope("broker.release-document", [kernel, documentId]);
    },
    snapshot: () => ({ ...snapshot }),
  };
  return broker;
}

export function createRuntimeClient({
  chromeApi,
  targetTabId,
  pageProvider = null,
  reconnectDelayMs = 100,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!chromeApi?.runtime?.connect) throw new TypeError("createRuntimeClient requires chrome.runtime.connect");
  targetTabId = checkedTabId(targetTabId, "runtime/client-invalid-tab");
  let runtimePort = null;
  let providerPort = null;
  let closed = false;
  let nextRequest = 1;
  let reconnectTimer = null;
  let latestStatus = null;
  const pending = new Map();
  const statusListeners = new Set();
  const errorListeners = new Set();

  function reportError(error) {
    for (const listener of errorListeners) {
      try { listener(error); } catch { /* observer isolation */ }
    }
  }

  function rejectPending(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      connectPorts();
    }, reconnectDelayMs);
  }

  function attachRuntimePort(port) {
    runtimePort = port;
    port.postMessage({ channel: "runtime-client-register", targetTabId });
    port.onMessage.addListener((message = {}) => {
      if (message.channel === "runtime-status") {
        latestStatus = message.value;
        for (const listener of statusListeners) listener(latestStatus);
        return;
      }
      if (message.channel === "runtime-client-registration-failed") {
        const error = new Error(message.error ?? "runtime client registration failed");
        error.code = message.code ?? "runtime/client-registration-failed";
        reportError(error);
        return;
      }
      if (message.channel !== "runtime-response") return;
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
    });
    port.onDisconnect.addListener(() => {
      if (runtimePort !== port) return;
      runtimePort = null;
      const error = Object.assign(new Error("runtime client disconnected"), { code: "runtime/client-disconnected" });
      rejectPending(error);
      reportError(error);
      scheduleReconnect();
    });
  }

  function attachProviderPort(port) {
    providerPort = port;
    port.postMessage({ channel: "provider-register", targetTabId });
    port.onMessage.addListener(async (message = {}) => {
      if (message.channel !== "provider-request") return;
      try {
        if (!pageProvider) throw Object.assign(new Error("page provider unavailable"), { code: "runtime/provider-unavailable" });
        let value;
        if (message.method === "target.list") value = await pageProvider.list();
        else if (message.method === "target.invoke") value = await pageProvider.invoke(message.args?.[0] ?? {});
        else throw Object.assign(new Error(`unsupported page provider method ${message.method}`), { code: "runtime/provider-operation-unsupported" });
        port.postMessage({ channel: "provider-response", id: message.id, ok: true, value });
      } catch (error) {
        port.postMessage({ channel: "provider-response", id: message.id, ok: false, ...serializeError(error) });
      }
    });
    port.onDisconnect.addListener(() => {
      if (providerPort !== port) return;
      providerPort = null;
      scheduleReconnect();
    });
  }

  function connectPorts() {
    if (closed) return;
    if (!runtimePort) attachRuntimePort(chromeApi.runtime.connect({ name: RUNTIME_CLIENT_PORT }));
    if (pageProvider && !providerPort) attachProviderPort(chromeApi.runtime.connect({ name: PAGE_PROVIDER_PORT }));
  }

  function request(method, args = []) {
    if (closed) return Promise.reject(Object.assign(new Error("runtime client closed"), { code: "runtime/client-closed" }));
    if (!runtimePort) connectPorts();
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        runtimePort.postMessage({ channel: "runtime-request", id, method, args: toPlain(args) });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function onStatus(listener) {
    statusListeners.add(listener);
    if (latestStatus) listener(latestStatus);
    return () => statusListeners.delete(listener);
  }

  function onError(listener) {
    errorListeners.add(listener);
    return () => errorListeners.delete(listener);
  }

  connectPorts();
  const connection = {
    request,
    onStatus,
    onError,
    reportError,
    status: () => latestStatus,
  };
  const broker = createRemoteBroker(connection);

  return {
    broker,
    request,
    onStatus,
    onError,
    reportError,
    status: () => latestStatus,
    start: (options = {}) => request("runtime.start", [{ targetTabId, ...options }]),
    bind: () => request("runtime.bind", [{ targetTabId }]),
    connectResp: (url) => request("resp.connect", [{ url }]),
    disconnectResp: () => request("resp.disconnect"),
    reconnectResp: (url) => request("resp.reconnect", [{ url }]),
    async close() {
      if (closed) return true;
      closed = true;
      if (reconnectTimer !== null) clearTimeoutImpl(reconnectTimer);
      try { runtimePort?.disconnect(); } catch { /* already closed */ }
      try { providerPort?.disconnect(); } catch { /* already closed */ }
      runtimePort = null;
      providerPort = null;
      rejectPending(Object.assign(new Error("runtime client closed"), { code: "runtime/client-closed" }));
      statusListeners.clear();
      errorListeners.clear();
      return true;
    },
  };
}
