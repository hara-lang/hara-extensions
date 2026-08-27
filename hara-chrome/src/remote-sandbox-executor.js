import {
  EXECUTION_RESULT_PROTOCOL,
  PURE_PROFILE,
  assertResultBound,
  cloneJson,
  parseExecutionRequest,
  parseHostDescriptor,
} from "./remote-host-protocol.js";

function executorError(code, message, data = null) {
  const error = new Error(message);
  error.name = "RemoteSandboxExecutorError";
  error.code = code;
  error.data = data;
  return error;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw executorError("remote/config-invalid", `${label} must be a function`);
  return value;
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw executorError("remote/clock-invalid", "executor clock returned an invalid date");
  return date.toISOString();
}

async function sha256Text(value) {
  if (!globalThis.crypto?.subtle) {
    throw executorError("remote/crypto-unavailable", "Web Crypto SHA-256 is required");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function errorCode(error, fallback) {
  return typeof error?.code === "string" ? error.code.slice(0, 128) : fallback;
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "remote Hara execution failed").slice(0, 8_192);
}

function terminalStatus(error, signal) {
  if (error?.code === "sandbox/timed-out" || error?.code === "remote/timed-out") return "timed-out";
  if (
    signal?.aborted ||
    error?.name === "AbortError" ||
    error?.code === "sandbox/cancelled" ||
    error?.code === "remote/cancelled"
  ) {
    return signal?.reason === "deadline-exceeded" ? "timed-out" : "cancelled";
  }
  return "failed";
}

function cleanupState(sandbox, result = null) {
  if (result?.cleanup === "completed") return "completed";
  try {
    return sandbox?.snapshot?.().state === "closed" ? "completed" : "uncertain";
  } catch {
    return "uncertain";
  }
}

function makeResult({ request, descriptor, status, value, diagnostic, startedAt, completedAt, cleanup }) {
  const result = {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: request.requestId,
    runId: `wasm:${request.requestId}`,
    status,
    value,
    stdout: "",
    stderr: status === "failed" && diagnostic ? diagnostic.message : "",
    diagnostics: diagnostic ? [diagnostic] : [],
    runtime: {
      hostId: descriptor.hostId,
      hostGeneration: descriptor.generation,
      backend: descriptor.backend,
      runtimeBuild: descriptor.runtimeBuild,
      haraVersion: descriptor.haraVersion,
    },
    evidence: {
      profile: PURE_PROFILE,
      sourceDigest: request.sourceDigest,
      startedAt,
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      cleanup,
    },
  };
  return assertResultBound(result, request, descriptor);
}

export function createCanonicalRemoteSandboxExecutor(options = {}) {
  const createSandbox = checkedFunction(options.createSandbox, "createSandbox");
  const digestSource = checkedFunction(options.digestSource ?? sha256Text, "digestSource");
  const now = checkedFunction(options.now ?? (() => new Date()), "now");
  const active = new Map();
  let closed = false;

  async function execute(input, { signal = null, descriptor } = {}) {
    if (closed) throw executorError("remote/executor-closed", "remote sandbox executor is closed");
    const request = cloneJson(parseExecutionRequest(input));
    const host = cloneJson(parseHostDescriptor(descriptor));
    if (host.state !== "ready" && host.state !== "degraded") {
      throw executorError("remote/host-incompatible", `host state ${host.state} cannot execute requests`);
    }
    if (request.limits.wallMs > host.limits.maxWallMs || request.limits.outputBytes > host.limits.maxOutputBytes) {
      throw executorError("remote/limit-exceeded", "request limits exceed the selected host descriptor");
    }
    if (active.has(request.requestId)) {
      throw executorError("remote/request-busy", `request ${request.requestId} is already active`);
    }

    const startedAt = nowIso(now);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason ?? "client-cancelled");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });

    let sandbox = null;
    const entry = { requestId: request.requestId, controller, sandbox: null };
    active.set(request.requestId, entry);
    try {
      const actualDigest = await digestSource(request.source);
      if (actualDigest !== request.sourceDigest) {
        throw executorError("remote/source-digest-mismatch", "request source does not match its SHA-256 digest");
      }
      if (controller.signal.aborted) {
        throw executorError("remote/cancelled", "remote Hara execution was cancelled before sandbox creation");
      }
      sandbox = await createSandbox({ request: cloneJson(request), descriptor: cloneJson(host) });
      entry.sandbox = sandbox;
      if (!sandbox || typeof sandbox.run !== "function" || typeof sandbox.close !== "function") {
        throw executorError("remote/sandbox-invalid", "createSandbox must return a BrowserWasmSandbox-compatible object");
      }
      const outcome = await sandbox.run(
        {
          operation: "sandbox.eval",
          source: request.source,
          limits: {
            sourceBytes: host.limits.maxSourceBytes,
            outputBytes: request.limits.outputBytes,
            wallMs: request.limits.wallMs,
          },
        },
        { signal: controller.signal },
      );
      if (outcome?.status !== "completed" || !outcome.value) {
        throw executorError("remote/result-invalid", "canonical browser sandbox returned an invalid terminal result");
      }
      const completedAt = nowIso(now);
      return makeResult({
        request,
        descriptor: host,
        status: "completed",
        value: cloneJson(outcome.value),
        diagnostic: null,
        startedAt,
        completedAt,
        cleanup: cleanupState(sandbox, outcome),
      });
    } catch (error) {
      const completedAt = nowIso(now);
      const status = terminalStatus(error, controller.signal);
      const diagnostic = {
        code: errorCode(
          error,
          status === "timed-out"
            ? "remote/timed-out"
            : status === "cancelled"
              ? "remote/cancelled"
              : "remote/execution-failed",
        ),
        severity: status === "failed" ? "error" : "warning",
        message: errorMessage(error),
      };
      return makeResult({
        request,
        descriptor: host,
        status,
        value: null,
        diagnostic,
        startedAt,
        completedAt,
        cleanup: cleanupState(sandbox),
      });
    } finally {
      signal?.removeEventListener?.("abort", onAbort);
      active.delete(request.requestId);
      try {
        sandbox?.close?.();
      } catch {
        // The result already reports cleanup truthfully.
      }
    }
  }

  function cancel(requestId, reason = "client-cancelled") {
    const entry = active.get(requestId);
    if (!entry) return false;
    entry.controller.abort(reason);
    try {
      entry.sandbox?.cancel?.();
    } catch {
      // Abort remains authoritative even if the adapter-specific hint fails.
    }
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const entry of active.values()) {
      entry.controller.abort("relay-closing");
      try {
        entry.sandbox?.close?.();
      } catch {
        // Best effort during host shutdown.
      }
    }
    active.clear();
  }

  return Object.freeze({ execute, cancel, close, active: () => active.size });
}

export async function sha256Source(source) {
  return sha256Text(source);
}
