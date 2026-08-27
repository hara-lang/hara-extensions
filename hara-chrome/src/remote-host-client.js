import {
  LOOPBACK_RELAY_PROTOCOL,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_POLL_MS,
  RemoteHostProtocolError,
  assertResultBound,
  canonicalJson,
  cloneJson,
  parseAcceptedResponse,
  parseHostDescriptor,
  parseRegisterResponse,
  parseRelayCommand,
  parseRelayError,
  validatePairingToken,
  validateRelayBaseUrl,
} from "./remote-host-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_HISTORY_LIMIT = 64;

class RelayHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RelayHttpError";
    this.status = status;
    this.code = code;
  }
}

function clientError(code, message, data = null) {
  const error = new Error(message);
  error.name = "HaraRelayHostClientError";
  error.code = code;
  error.data = data;
  return error;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw clientError("remote/config-invalid", `${label} must be a function`);
  return value;
}

function checkedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw clientError("remote/config-invalid", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function redactMessage(error, token) {
  const raw = String(error?.message ?? error ?? "remote host operation failed");
  return (token && raw.includes(token) ? raw.split(token).join("[redacted]") : raw).slice(0, 1_024);
}

function projectedError(error, token) {
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 128) : "remote/unavailable",
    message: redactMessage(error, token),
  };
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "remote/stopped";
}

function retryable(error) {
  if (error instanceof RemoteHostProtocolError) return false;
  if (error instanceof RelayHttpError) return error.status >= 500 || [408, 425, 429].includes(error.status);
  return !isAbort(error);
}

function boundedSet(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function delay(milliseconds, signal, setTimer, clearTimer) {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(clientError("remote/stopped", "remote host client stopped"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimer(timer);
      signal.removeEventListener("abort", onAbort);
      reject(clientError("remote/stopped", "remote host client stopped"));
    };
    const timer = setTimer(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > RELAY_MAX_BODY_BYTES) {
    throw clientError("remote/body-too-large", `relay response exceeds ${RELAY_MAX_BODY_BYTES} bytes`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > RELAY_MAX_BODY_BYTES) {
    throw clientError("remote/body-too-large", `relay response exceeds ${RELAY_MAX_BODY_BYTES} bytes`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw clientError("remote/response-invalid", "relay returned invalid UTF-8 or JSON");
  }
}

export function createHaraRelayHostClient(options = {}) {
  const relayOrigin = validateRelayBaseUrl(options.relayUrl);
  const pairingToken = validatePairingToken(options.pairingToken);
  const descriptorTemplate = cloneJson(parseHostDescriptor(options.descriptor));
  const executor = options.executor;
  if (!executor || typeof executor !== "object") throw clientError("remote/config-invalid", "executor is required");
  checkedFunction(executor.execute, "executor.execute");

  const fetchImpl = checkedFunction(options.fetchImpl ?? globalThis.fetch, "fetchImpl");
  const now = checkedFunction(options.now ?? (() => new Date()), "now");
  const random = checkedFunction(options.random ?? Math.random, "random");
  const setTimer = checkedFunction(options.setTimeoutImpl ?? setTimeout, "setTimeoutImpl");
  const clearTimer = checkedFunction(options.clearTimeoutImpl ?? clearTimeout, "clearTimeoutImpl");
  const onStatus = checkedFunction(options.onStatus ?? (() => {}), "onStatus");
  const requestTimeoutMs = checkedInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs", 50, 60_000);
  const minBackoffMs = checkedInteger(options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS, "minBackoffMs", 1, 10_000);
  const maxBackoffMs = checkedInteger(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs", minBackoffMs, 60_000);
  const historyLimit = checkedInteger(options.historyLimit ?? DEFAULT_HISTORY_LIMIT, "historyLimit", 1, 256);
  const maxPollWaitMs = checkedInteger(options.maxPollWaitMs ?? RELAY_MAX_POLL_MS, "maxPollWaitMs", 0, RELAY_MAX_POLL_MS);

  let desired = false;
  let closed = false;
  let loop = null;
  let lifecycle = null;
  let registrationReady = null;
  let acknowledgement = null;
  let active = null;
  let pendingTerminal = null;
  let reconnectAttempt = 0;
  const commands = new Map();
  const requests = new Map();
  const terminals = new Map();

  let state = {
    desiredState: "stopped",
    connectionState: "stopped",
    hostId: descriptorTemplate.hostId,
    generation: descriptorTemplate.generation,
    relayOrigin,
    activeRequestId: null,
    activeCommandId: null,
    pendingTerminal: false,
    reconnectAttempt: 0,
    lastRegisteredAt: null,
    lastPollAt: null,
    lastResultAt: null,
    lastError: null,
  };

  function snapshot() {
    return cloneJson(state);
  }

  function publish(patch) {
    state = { ...state, ...patch };
    try { onStatus(snapshot()); } catch { /* observer isolation */ }
    return snapshot();
  }

  function currentDescriptor() {
    return parseHostDescriptor({ ...cloneJson(descriptorTemplate), observedAt: now().toISOString() });
  }

  async function post(path, payload, signal, parser) {
    const body = JSON.stringify(payload);
    if (new TextEncoder().encode(body).byteLength > RELAY_MAX_BODY_BYTES) {
      throw clientError("remote/body-too-large", `relay request exceeds ${RELAY_MAX_BODY_BYTES} bytes`);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimer(() => controller.abort("request-timeout"), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(`${relayOrigin}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${pairingToken}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (signal?.aborted) throw clientError("remote/stopped", "remote host client stopped");
      if (controller.signal.aborted) throw clientError("remote/request-timeout", "relay request timed out");
      throw clientError("remote/unavailable", "loopback relay is unavailable", { cause: redactMessage(error, pairingToken) });
    } finally {
      clearTimer(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw clientError("remote/response-invalid", "relay response must use application/json");
    }
    const value = await boundedJson(response);
    if (!response.ok) {
      let parsed;
      try { parsed = parseRelayError(value); }
      catch { throw new RelayHttpError(response.status, "remote/http-error", `relay returned HTTP ${response.status}`); }
      throw new RelayHttpError(response.status, parsed.error.code, parsed.error.message);
    }
    return parser(value);
  }

  async function register(signal) {
    const descriptor = currentDescriptor();
    const response = await post(
      "/v0/host/register",
      { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor },
      signal,
      parseRegisterResponse,
    );
    if (response.hostId !== descriptor.hostId || response.generation !== descriptor.generation) {
      throw new RemoteHostProtocolError("remote/registration-unbound", "relay changed host identity or generation");
    }
    publish({
      connectionState: descriptor.state,
      reconnectAttempt: 0,
      lastRegisteredAt: now().toISOString(),
      lastError: null,
    });
    registrationReady?.resolve(snapshot());
    return { descriptor, response };
  }

  async function poll(registration, signal) {
    const sentAcknowledgement = acknowledgement;
    const command = await post(
      "/v0/host/poll",
      {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        hostId: registration.descriptor.hostId,
        generation: registration.descriptor.generation,
        waitMs: Math.min(maxPollWaitMs, registration.response.pollAfterMs),
        ...(sentAcknowledgement ? { acknowledgedCommandId: sentAcknowledgement } : {}),
      },
      signal,
      parseRelayCommand,
    );
    if (acknowledgement === sentAcknowledgement) acknowledgement = null;
    publish({ lastPollAt: now().toISOString(), lastError: null });
    return command;
  }

  function remember(map, id, value, label) {
    const fingerprint = canonicalJson(value);
    const previous = map.get(id);
    if (previous !== undefined && previous !== fingerprint) {
      throw new RemoteHostProtocolError(`remote/${label}-collision`, `relay changed ${label} ${id}`);
    }
    if (previous === undefined) boundedSet(map, id, fingerprint, historyLimit);
    return previous !== undefined;
  }

  function handleExecute(command, registration) {
    const duplicateCommand = remember(commands, command.commandId, command, "command");
    const duplicateRequest = remember(requests, command.request.requestId, command.request, "request");
    acknowledgement = command.commandId;
    if (duplicateCommand || duplicateRequest) {
      if (active?.request.requestId === command.request.requestId) return;
      const retained = terminals.get(command.request.requestId);
      if (retained) {
        pendingTerminal = retained;
        publish({ pendingTerminal: true });
        return;
      }
      throw new RemoteHostProtocolError("remote/duplicate-unresolved", `duplicate request ${command.request.requestId} has no retained result`);
    }
    if (active) throw new RemoteHostProtocolError("remote/request-busy", `request ${active.request.requestId} is already active`);

    const controller = new AbortController();
    const entry = {
      commandId: command.commandId,
      request: cloneJson(command.request),
      descriptor: cloneJson(registration.descriptor),
      controller,
      cancelReason: null,
      task: null,
    };
    active = entry;
    publish({ activeRequestId: entry.request.requestId, activeCommandId: entry.commandId, pendingTerminal: false });
    entry.task = Promise.resolve(executor.execute(entry.request, {
      signal: controller.signal,
      descriptor: entry.descriptor,
    })).then((value) => {
      if (active !== entry) return;
      const result = assertResultBound(value, entry.request, entry.descriptor);
      if (["client-cancelled", "relay-closing"].includes(entry.cancelReason) && result.status !== "cancelled") {
        throw new RemoteHostProtocolError("remote/cancellation-result-invalid", "cancelled execution returned a non-cancelled result");
      }
      if (entry.cancelReason === "deadline-exceeded" && result.status !== "timed-out") {
        throw new RemoteHostProtocolError("remote/cancellation-result-invalid", "timed-out execution returned a non-timeout result");
      }
      const terminal = { result: cloneJson(result), fingerprint: canonicalJson(result) };
      const previous = terminals.get(result.requestId);
      if (previous && previous.fingerprint !== terminal.fingerprint) {
        throw new RemoteHostProtocolError("remote/terminal-collision", `executor changed terminal result ${result.requestId}`);
      }
      boundedSet(terminals, result.requestId, terminal, historyLimit);
      pendingTerminal = terminal;
      publish({ pendingTerminal: true });
    }).catch((error) => {
      if (active !== entry) return;
      desired = false;
      publish({ desiredState: "stopped", connectionState: "faulted", lastError: projectedError(error, pairingToken) });
      lifecycle?.abort(error);
    });
  }

  function handleCancel(command) {
    remember(commands, command.commandId, command, "command");
    acknowledgement = command.commandId;
    if (!active || active.request.requestId !== command.requestId) {
      throw new RemoteHostProtocolError("remote/cancel-unbound", `cancel does not match active request ${command.requestId}`);
    }
    if (active.cancelReason) return;
    active.cancelReason = command.reason;
    active.controller.abort(command.reason);
    publish({ activeCommandId: command.commandId });
    if (typeof executor.cancel === "function") {
      Promise.resolve(executor.cancel(command.requestId, command.reason)).catch((error) => {
        publish({ lastError: projectedError(error, pairingToken) });
      });
    }
  }

  async function submit(registration, signal) {
    if (!pendingTerminal) return;
    const terminal = pendingTerminal;
    await post(
      "/v0/host/result",
      {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        hostId: registration.descriptor.hostId,
        generation: registration.descriptor.generation,
        result: terminal.result,
      },
      signal,
      parseAcceptedResponse,
    );
    if (pendingTerminal !== terminal) throw new RemoteHostProtocolError("remote/terminal-collision", "pending terminal changed during submission");
    pendingTerminal = null;
    active = null;
    publish({
      activeRequestId: null,
      activeCommandId: null,
      pendingTerminal: false,
      lastResultAt: now().toISOString(),
      lastError: null,
    });
  }

  function backoff(attempt) {
    const exponential = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(attempt, 16));
    return Math.max(minBackoffMs, Math.min(maxBackoffMs, Math.round(exponential * (0.75 + Math.max(0, Math.min(1, random())) * 0.5))));
  }

  async function run(signal) {
    while (desired && !signal.aborted) {
      try {
        publish({ connectionState: "connecting", lastError: null });
        const registration = await register(signal);
        reconnectAttempt = 0;
        while (desired && !signal.aborted) {
          if (pendingTerminal) await submit(registration, signal);
          const command = await poll(registration, signal);
          if (command.kind === "idle") await delay(command.retryAfterMs, signal, setTimer, clearTimer);
          else if (command.kind === "execute") handleExecute(command, registration);
          else if (command.kind === "cancel") handleCancel(command);
        }
      } catch (error) {
        if (!desired || signal.aborted || isAbort(error)) break;
        if (!retryable(error)) {
          desired = false;
          publish({ desiredState: "stopped", connectionState: "faulted", lastError: projectedError(error, pairingToken) });
          registrationReady?.reject(error);
          break;
        }
        reconnectAttempt += 1;
        publish({ connectionState: "offline", reconnectAttempt, lastError: projectedError(error, pairingToken) });
        await delay(backoff(reconnectAttempt - 1), signal, setTimer, clearTimer);
      }
    }
  }

  function start() {
    if (closed) return Promise.reject(clientError("remote/closed", "remote host client is closed"));
    if (desired) return registrationReady.promise;
    if (loop) return Promise.reject(clientError("remote/restart-requires-stop", "stop the client before restarting"));
    desired = true;
    lifecycle = new AbortController();
    registrationReady = Promise.withResolvers ? Promise.withResolvers() : (() => {
      let resolve; let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    })();
    publish({ desiredState: "running", connectionState: "connecting", reconnectAttempt: 0, lastError: null });
    loop = run(lifecycle.signal).finally(() => {
      if (!desired && state.connectionState !== "faulted") publish({ connectionState: "stopped" });
    });
    return registrationReady.promise;
  }

  async function stop(reason = "relay-closing") {
    desired = false;
    publish({ desiredState: "stopped", connectionState: "stopping" });
    if (active && !active.cancelReason) {
      active.cancelReason = reason;
      active.controller.abort(reason);
      if (typeof executor.cancel === "function") Promise.resolve(executor.cancel(active.request.requestId, reason)).catch(() => {});
    }
    lifecycle?.abort(reason);
    await Promise.resolve(loop).catch(() => {});
    await Promise.resolve(active?.task).catch(() => {});
    acknowledgement = null;
    active = null;
    pendingTerminal = null;
    commands.clear();
    requests.clear();
    terminals.clear();
    lifecycle = null;
    loop = null;
    reconnectAttempt = 0;
    return publish({
      connectionState: "stopped",
      activeRequestId: null,
      activeCommandId: null,
      pendingTerminal: false,
      reconnectAttempt: 0,
    });
  }

  async function close() {
    if (closed) return snapshot();
    await stop();
    closed = true;
    if (typeof executor.close === "function") await Promise.resolve(executor.close()).catch(() => {});
    return publish({ desiredState: "closed", connectionState: "closed" });
  }

  return Object.freeze({ start, stop, close, status: snapshot });
}
