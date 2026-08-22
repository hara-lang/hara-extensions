import { HtaKeyword, HtaSymbol, HtaHandle } from "../vendor/hta.js";

/** HTA or structured runtime value -> JSON-safe value for Port messaging. */
const VALUE_TAG = "__haraValue";

export function toPlain(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  if (["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (value instanceof HtaKeyword) return { [VALUE_TAG]: "keyword", name: value.name };
  if (value instanceof HtaSymbol) return { [VALUE_TAG]: "symbol", name: value.name };
  if (value instanceof HtaHandle) return { [VALUE_TAG]: "handle", value: String(value) };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => toPlain(item, seen));
  if (value instanceof Set) return { [VALUE_TAG]: "set", values: [...value].map((item) => toPlain(item, seen)) };
  if (value instanceof Map) {
    return {
      [VALUE_TAG]: "map",
      entries: [...value].map(([key, item]) => [toPlain(key, seen), toPlain(item, seen)]),
    };
  }
  if (ArrayBuffer.isView(value)) return { [VALUE_TAG]: "bytes", values: [...value] };
  if (value instanceof ArrayBuffer) return { [VALUE_TAG]: "bytes", values: [...new Uint8Array(value)] };
  if (value instanceof Date) return value.toISOString();

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (["context", "worker", "spawn", "resources"].includes(key)) continue;
    output[key] = toPlain(item, seen);
  }
  return output;
}

/**
 * Port request decoder. Tagged HTA values regain their runtime classes while
 * ordinary option/configuration objects remain ordinary JavaScript objects.
 */
export function fromTransport(value) {
  if (Array.isArray(value)) return value.map(fromTransport);
  if (value !== null && typeof value === "object") {
    if (value[VALUE_TAG] === "keyword") return new HtaKeyword(String(value.name ?? ""));
    if (value[VALUE_TAG] === "symbol") return new HtaSymbol(String(value.name ?? ""));
    if (value[VALUE_TAG] === "handle") return String(value.value ?? "");
    if (value[VALUE_TAG] === "set") return new Set((value.values ?? []).map(fromTransport));
    if (value[VALUE_TAG] === "map") {
      return new Map((value.entries ?? []).map(([key, item]) => [fromTransport(key), fromTransport(item)]));
    }
    if (value[VALUE_TAG] === "bytes") return new Uint8Array(value.values ?? []);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fromTransport(item)]),
    );
  }
  return value;
}

/** JSON value -> HTA-compatible value (objects become keyword-keyed Maps). */
export function fromPlain(value) {
  if (Array.isArray(value)) return value.map(fromPlain);
  if (value !== null && typeof value === "object") {
    if (value[VALUE_TAG] === "keyword") return new HtaKeyword(String(value.name ?? ""));
    if (value[VALUE_TAG] === "symbol") return new HtaSymbol(String(value.name ?? ""));
    if (value[VALUE_TAG] === "handle") return String(value.value ?? "");
    if (value[VALUE_TAG] === "set") return new Set((value.values ?? []).map(fromPlain));
    if (value[VALUE_TAG] === "map") {
      return new Map((value.entries ?? []).map(([key, item]) => [fromPlain(key), fromPlain(item)]));
    }
    if (value[VALUE_TAG] === "bytes") return new Uint8Array(value.values ?? []);
    return new Map(
      Object.entries(value).map(([key, item]) => [new HtaKeyword(key), fromPlain(item)]),
    );
  }
  return value;
}

function splitHostKey(key) {
  const text = String(key);
  const split = text.lastIndexOf("/");
  if (split <= 0 || split === text.length - 1) throw new Error(`invalid host call key: ${text}`);
  return { service: text.slice(0, split), method: text.slice(split + 1) };
}

/**
 * Dynamic hostCalls map: any "service/method" key becomes a function that
 * forwards the call over the extension Port and resolves with the reply.
 */
export function createHostCalls(port, { tabId = null, target = null } = {}) {
  const pending = new Map();
  let next = 1;
  const targetForCall = typeof target === "function"
    ? target
    : () => ({ tabId: Number(tabId) });
  port.onMessage.addListener(({ id, ok, value, error, code, data }) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) {
      entry.resolve(fromPlain(value));
    } else {
      const cause = new Error(error ?? "host call failed");
      if (code) cause.code = code;
      if (data !== undefined) cause.data = data;
      entry.reject(cause);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const entry of pending.values()) entry.reject(new Error("hara host disconnected"));
    pending.clear();
  });
  return new Proxy({}, {
    get: (_target, key) => {
      const { service, method } = splitHostKey(key);
      return (...args) => new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        port.postMessage({
          id,
          service,
          method,
          args: args.map((item) => toPlain(item)),
          target: targetForCall(),
        });
      });
    },
  });
}

/**
 * Reconnecting variant for an offscreen document. The runtime and its workers
 * survive service-worker suspension; each host call waits for a fresh
 * `hara-host` Port instead of permanently capturing the original worker port.
 */
export function createReconnectableHostCalls({
  connect,
  target = () => ({ tabId: null }),
  reconnectDelayMs = 50,
  setTimeoutImpl = setTimeout,
} = {}) {
  if (typeof connect !== "function") throw new TypeError("createReconnectableHostCalls requires connect");
  if (typeof target !== "function") throw new TypeError("host-call target must be a function");

  let port = null;
  let connecting = null;
  let closed = false;
  let next = 1;
  const pending = new Map();

  function rejectGeneration(error) {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function attach(nextPort) {
    port = nextPort;
    const current = nextPort;
    const onMessage = ({ id, ok, value, error, code, data }) => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      if (ok) entry.resolve(fromPlain(value));
      else {
        const cause = new Error(error ?? "host call failed");
        if (code) cause.code = code;
        if (data !== undefined) cause.data = data;
        entry.reject(cause);
      }
    };
    const onDisconnect = () => {
      if (port !== current) return;
      port = null;
      rejectGeneration(Object.assign(new Error("hara host disconnected"), { code: "runtime/host-call-disconnected" }));
      if (!closed) setTimeoutImpl(() => { void ensurePort(); }, reconnectDelayMs);
    };
    current.onMessage.addListener(onMessage);
    current.onDisconnect.addListener(onDisconnect);
    return current;
  }

  async function ensurePort() {
    if (closed) throw Object.assign(new Error("host-call client closed"), { code: "runtime/host-call-closed" });
    if (port) return port;
    connecting ??= Promise.resolve(connect()).then(attach).finally(() => { connecting = null; });
    return connecting;
  }

  const proxy = new Proxy({}, {
    get: (_target, key) => {
      if (key === "close") return () => {
        closed = true;
        try { port?.disconnect(); } catch { /* already closed */ }
        port = null;
        rejectGeneration(Object.assign(new Error("host-call client closed"), { code: "runtime/host-call-closed" }));
      };
      const { service, method } = splitHostKey(key);
      return (...args) => new Promise((resolve, reject) => {
        void ensurePort().then((activePort) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          try {
            activePort.postMessage({
              id,
              service,
              method,
              args: args.map((item) => toPlain(item)),
              target: target(),
            });
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        }, reject);
      });
    },
  });
  void ensurePort();
  return proxy;
}

/** Merge a concrete hostCalls map with a dynamic fallback proxy. */
export function mergeHostCalls(primary, fallback) {
  return new Proxy(primary, {
    get: (target, key) => (key in target ? target[key] : fallback[key]),
  });
}
