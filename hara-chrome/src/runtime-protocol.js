export const RUNTIME_PROTOCOL = "greenways.hara-runtime/0-alpha";
export const RUNTIME_HOST_PORT = "hara-runtime-host";
export const RUNTIME_CLIENT_PORT = "hara-runtime-client";
export const PAGE_PROVIDER_PORT = "hara-page-provider";
export const HOST_CALL_PORT = "hara-host";
export const CONTROL_PORT = "hara-control";
export const OFFSCREEN_PATH = "src/runtime-host.html";

export class RuntimeProtocolError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "RuntimeProtocolError";
    this.code = code;
    this.data = data;
  }
}

export function fail(code, message, data = {}) {
  throw new RuntimeProtocolError(code, message, data);
}

export function checkedTabId(value, code = "runtime/invalid-tab") {
  const tabId = Number(value);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    fail(code, "tab ID must be a positive integer", { tabId: value ?? null });
  }
  return tabId;
}

export function serializeError(error) {
  return {
    error: String(error?.message ?? error ?? "runtime request failed"),
    code: error?.code ?? "runtime/request-failed",
    data: error?.data ?? null,
  };
}

export function runtimeStatus(overrides = {}) {
  return {
    protocol: RUNTIME_PROTOCOL,
    runtimeState: "off",
    respState: "off",
    targetTabId: null,
    kernel: null,
    respUrl: "ws://127.0.0.1:7356",
    kernels: [],
    pending: [],
    documents: [],
    generation: 0,
    instanceId: null,
    error: null,
    ...overrides,
  };
}
