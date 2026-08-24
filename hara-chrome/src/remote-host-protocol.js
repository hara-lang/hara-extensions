export const EXECUTION_HOST_PROTOCOL = "hara.execution-host/0-alpha";
export const EXECUTION_RESULT_PROTOCOL = "hara.execution-result/0-alpha";
export const LOOPBACK_RELAY_PROTOCOL = "hara.loopback-relay/0-alpha";
export const PURE_PROFILE = "hara.mcp-pure/0-alpha";

export const REMOTE_HOST_OPERATIONS = Object.freeze(["runtime.get", "sandbox.eval"]);
export const REMOTE_HOST_MAX_SOURCE_BYTES = 65_536;
export const REMOTE_HOST_MAX_OUTPUT_BYTES = 1_048_576;
export const REMOTE_HOST_MAX_WALL_MS = 30_000;
export const RELAY_MAX_BODY_BYTES = 1_310_720;
export const RELAY_MAX_POLL_MS = 5_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled", "timed-out"]);
const HOST_STATES = new Set(["ready", "degraded", "offline", "revoked"]);
const CANCEL_REASONS = new Set(["client-cancelled", "deadline-exceeded", "relay-closing"]);
const textEncoder = new TextEncoder();

export class RemoteHostProtocolError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = "RemoteHostProtocolError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = null) {
  throw new RemoteHostProtocolError(code, message, data);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closedObject(value, label, allowed, required = allowed) {
  if (!isObject(value)) fail("remote/protocol-invalid", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("remote/protocol-unknown-field", `${label} contains unknown field ${key}`, { label, key });
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("remote/protocol-missing-field", `${label} requires field ${key}`, { label, key });
    }
  }
  return value;
}

function stringValue(value, label, { min = 1, max = 4_096, pattern = null } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail("remote/protocol-invalid", `${label} must be a string between ${min} and ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail("remote/protocol-invalid", `${label} has an invalid format`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("remote/protocol-invalid", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function finiteNumber(value, label, { min = 0, max = Number.MAX_VALUE } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("remote/protocol-invalid", `${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) fail("remote/protocol-version", `${label} must be ${expected}`);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail("remote/protocol-invalid", `${label} is unsupported: ${String(value)}`);
  return value;
}

function identifier(value, label) {
  return stringValue(value, label, { max: 128, pattern: IDENTIFIER });
}

function digest(value, label) {
  return stringValue(value, label, { min: 71, max: 71, pattern: DIGEST });
}

function requestId(value, label) {
  return stringValue(value, label, { min: 36, max: 36, pattern: UUID });
}

function timestamp(value, label) {
  stringValue(value, label, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("remote/protocol-invalid", `${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function uniqueStrings(value, label, { min = 1, max = 16 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("remote/protocol-invalid", `${label} must contain between ${min} and ${max} entries`);
  }
  const entries = value.map((entry, index) => stringValue(entry, `${label}[${index}]`, { max: 128 }));
  if (new Set(entries).size !== entries.length) fail("remote/protocol-invalid", `${label} contains duplicates`);
  return entries;
}

function jsonValue(value, label, depth = 0, state = { items: 0 }) {
  if (depth > 32) fail("remote/protocol-invalid", `${label} exceeds the maximum nesting depth`);
  state.items += 1;
  if (state.items > 65_536) fail("remote/protocol-invalid", `${label} contains too many values`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("remote/protocol-invalid", `${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      jsonValue(value[index], `${label}[${index}]`, depth + 1, state);
    }
    return value;
  }
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      stringValue(key, `${label} key`, { max: 256 });
      jsonValue(value[key], `${label}.${key}`, depth + 1, state);
    }
    return value;
  }
  fail("remote/protocol-invalid", `${label} must be transfer-safe JSON data`);
}

function parseLimits(value, label) {
  closedObject(value, label, ["wallMs", "outputBytes"]);
  integer(value.wallMs, `${label}.wallMs`, { min: 1, max: REMOTE_HOST_MAX_WALL_MS });
  integer(value.outputBytes, `${label}.outputBytes`, { min: 1, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  return value;
}

function parseHostLimits(value) {
  closedObject(value, "descriptor.limits", ["maxSourceBytes", "maxOutputBytes", "maxWallMs"]);
  integer(value.maxSourceBytes, "descriptor.limits.maxSourceBytes", { min: 1, max: REMOTE_HOST_MAX_SOURCE_BYTES });
  integer(value.maxOutputBytes, "descriptor.limits.maxOutputBytes", { min: 1, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  integer(value.maxWallMs, "descriptor.limits.maxWallMs", { min: 1, max: REMOTE_HOST_MAX_WALL_MS });
  return value;
}

function utf8Bytes(value) {
  return textEncoder.encode(value).byteLength;
}

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function parseHostDescriptor(value) {
  closedObject(value, "host descriptor", [
    "protocol",
    "hostId",
    "generation",
    "kind",
    "state",
    "backend",
    "runtimeBuild",
    "haraVersion",
    "profiles",
    "operations",
    "limits",
    "observedAt",
  ]);
  literal(value.protocol, EXECUTION_HOST_PROTOCOL, "descriptor.protocol");
  identifier(value.hostId, "descriptor.hostId");
  integer(value.generation, "descriptor.generation");
  oneOf(value.kind, ["browser-wasm"], "descriptor.kind");
  if (!HOST_STATES.has(value.state)) fail("remote/protocol-invalid", `descriptor.state is unsupported: ${String(value.state)}`);
  stringValue(value.backend, "descriptor.backend", { max: 128 });
  digest(value.runtimeBuild, "descriptor.runtimeBuild");
  stringValue(value.haraVersion, "descriptor.haraVersion", { max: 128 });
  const profiles = uniqueStrings(value.profiles, "descriptor.profiles");
  const operations = uniqueStrings(value.operations, "descriptor.operations");
  if (profiles.length !== 1 || profiles[0] !== PURE_PROFILE) {
    fail("remote/host-incompatible", `descriptor must advertise only ${PURE_PROFILE}`);
  }
  if (canonicalJson(operations) !== canonicalJson(REMOTE_HOST_OPERATIONS)) {
    fail("remote/host-incompatible", `descriptor must advertise exactly ${REMOTE_HOST_OPERATIONS.join(", ")}`);
  }
  parseHostLimits(value.limits);
  timestamp(value.observedAt, "descriptor.observedAt");
  return value;
}

export function parseExecutionRequest(value) {
  closedObject(value, "eval request", [
    "protocol",
    "requestId",
    "operation",
    "profile",
    "source",
    "sourceDigest",
    "limits",
  ]);
  literal(value.protocol, EXECUTION_HOST_PROTOCOL, "request.protocol");
  requestId(value.requestId, "request.requestId");
  literal(value.operation, "sandbox.eval", "request.operation");
  literal(value.profile, PURE_PROFILE, "request.profile");
  const source = stringValue(value.source, "request.source", { max: REMOTE_HOST_MAX_SOURCE_BYTES });
  if (utf8Bytes(source) > REMOTE_HOST_MAX_SOURCE_BYTES) {
    fail("remote/limit-exceeded", `request.source exceeds ${REMOTE_HOST_MAX_SOURCE_BYTES} UTF-8 bytes`);
  }
  digest(value.sourceDigest, "request.sourceDigest");
  parseLimits(value.limits, "request.limits");
  return value;
}

function parseDiagnostic(value, index) {
  const label = `result.diagnostics[${index}]`;
  closedObject(value, label, ["code", "severity", "message", "path", "line", "column"], [
    "code",
    "severity",
    "message",
  ]);
  stringValue(value.code, `${label}.code`, { max: 128 });
  oneOf(value.severity, ["info", "warning", "error"], `${label}.severity`);
  stringValue(value.message, `${label}.message`, { max: 8_192 });
  if (value.path !== undefined) stringValue(value.path, `${label}.path`, { max: 1_024 });
  if (value.line !== undefined) integer(value.line, `${label}.line`, { min: 1 });
  if (value.column !== undefined) integer(value.column, `${label}.column`, { min: 1 });
}

export function parseExecutionResult(value) {
  closedObject(value, "execution result", [
    "protocol",
    "requestId",
    "runId",
    "status",
    "value",
    "stdout",
    "stderr",
    "diagnostics",
    "runtime",
    "evidence",
  ]);
  literal(value.protocol, EXECUTION_RESULT_PROTOCOL, "result.protocol");
  requestId(value.requestId, "result.requestId");
  identifier(value.runId, "result.runId");
  if (!EXECUTION_STATUSES.has(value.status)) fail("remote/protocol-invalid", `unsupported result status ${String(value.status)}`);
  if (value.value !== null) {
    closedObject(value.value, "result.value", ["text", "json"], ["text"]);
    stringValue(value.value.text, "result.value.text", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
    if (value.value.json !== undefined) jsonValue(value.value.json, "result.value.json");
  }
  stringValue(value.stdout, "result.stdout", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  stringValue(value.stderr, "result.stderr", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 256) {
    fail("remote/protocol-invalid", "result.diagnostics must contain at most 256 entries");
  }
  value.diagnostics.forEach(parseDiagnostic);
  closedObject(value.runtime, "result.runtime", ["hostId", "hostGeneration", "backend", "runtimeBuild", "haraVersion"]);
  identifier(value.runtime.hostId, "result.runtime.hostId");
  integer(value.runtime.hostGeneration, "result.runtime.hostGeneration");
  stringValue(value.runtime.backend, "result.runtime.backend", { max: 128 });
  digest(value.runtime.runtimeBuild, "result.runtime.runtimeBuild");
  stringValue(value.runtime.haraVersion, "result.runtime.haraVersion", { max: 128 });
  closedObject(value.evidence, "result.evidence", [
    "profile",
    "sourceDigest",
    "startedAt",
    "completedAt",
    "elapsedMs",
    "cleanup",
  ]);
  literal(value.evidence.profile, PURE_PROFILE, "result.evidence.profile");
  digest(value.evidence.sourceDigest, "result.evidence.sourceDigest");
  timestamp(value.evidence.startedAt, "result.evidence.startedAt");
  timestamp(value.evidence.completedAt, "result.evidence.completedAt");
  finiteNumber(value.evidence.elapsedMs, "result.evidence.elapsedMs");
  oneOf(value.evidence.cleanup, ["completed", "uncertain"], "result.evidence.cleanup");
  return value;
}

export function assertResultBound(value, request, descriptor) {
  const result = parseExecutionResult(value);
  const parsedRequest = parseExecutionRequest(request);
  const parsedDescriptor = parseHostDescriptor(descriptor);
  if (result.requestId !== parsedRequest.requestId) fail("remote/result-unbound", "result.requestId does not match request");
  if (
    result.runtime.hostId !== parsedDescriptor.hostId ||
    result.runtime.hostGeneration !== parsedDescriptor.generation ||
    result.runtime.backend !== parsedDescriptor.backend ||
    result.runtime.runtimeBuild !== parsedDescriptor.runtimeBuild ||
    result.runtime.haraVersion !== parsedDescriptor.haraVersion
  ) {
    fail("remote/result-unbound", "result runtime identity does not match the selected host");
  }
  if (
    result.evidence.profile !== parsedRequest.profile ||
    result.evidence.sourceDigest !== parsedRequest.sourceDigest
  ) {
    fail("remote/result-unbound", "result evidence does not match the request");
  }
  const aggregate = utf8Bytes(canonicalJson({
    value: result.value,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics: result.diagnostics,
  }));
  if (aggregate > parsedRequest.limits.outputBytes) {
    fail("remote/limit-exceeded", `result output exceeds ${parsedRequest.limits.outputBytes} bytes`);
  }
  return result;
}

export function validateRelayBaseUrl(value) {
  stringValue(value, "relayUrl", { max: 256 });
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("remote/config-invalid", "relayUrl must be an absolute URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    fail("remote/config-invalid", "relayUrl must be explicit http://127.0.0.1:<port>");
  }
  return url.origin;
}

export function validatePairingToken(value) {
  stringValue(value, "pairingToken", { min: 16, max: 512 });
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
    fail("remote/config-invalid", "pairingToken must not contain whitespace or control characters");
  }
  return value;
}

export function parseRegisterResponse(value) {
  closedObject(value, "register response", [
    "protocol",
    "accepted",
    "hostId",
    "generation",
    "heartbeatTtlMs",
    "pollAfterMs",
  ]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "register.protocol");
  literal(value.accepted, true, "register.accepted");
  identifier(value.hostId, "register.hostId");
  integer(value.generation, "register.generation");
  integer(value.heartbeatTtlMs, "register.heartbeatTtlMs", { min: 1, max: 60_000 });
  integer(value.pollAfterMs, "register.pollAfterMs", { min: 1, max: RELAY_MAX_POLL_MS });
  return value;
}

export function parseRelayCommand(value) {
  if (!isObject(value)) fail("remote/protocol-invalid", "relay command must be an object");
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "command.protocol");
  switch (value.kind) {
    case "idle":
      closedObject(value, "idle command", ["protocol", "kind", "retryAfterMs"]);
      integer(value.retryAfterMs, "command.retryAfterMs", { min: 1, max: RELAY_MAX_POLL_MS });
      return value;
    case "execute":
      closedObject(value, "execute command", ["protocol", "kind", "commandId", "request"]);
      identifier(value.commandId, "command.commandId");
      parseExecutionRequest(value.request);
      return value;
    case "cancel":
      closedObject(value, "cancel command", ["protocol", "kind", "commandId", "requestId", "reason"]);
      identifier(value.commandId, "command.commandId");
      requestId(value.requestId, "command.requestId");
      if (!CANCEL_REASONS.has(value.reason)) fail("remote/protocol-invalid", `unsupported cancellation reason ${String(value.reason)}`);
      return value;
    default:
      fail("remote/operation-unsupported", `unsupported relay command ${String(value.kind)}`);
  }
}

export function parseAcceptedResponse(value) {
  closedObject(value, "accepted response", ["protocol", "accepted", "duplicate"]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "accepted.protocol");
  literal(value.accepted, true, "accepted.accepted");
  if (typeof value.duplicate !== "boolean") fail("remote/protocol-invalid", "accepted.duplicate must be boolean");
  return value;
}

export function parseRelayError(value) {
  closedObject(value, "relay error", ["protocol", "accepted", "error"]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "relay error.protocol");
  literal(value.accepted, false, "relay error.accepted");
  closedObject(value.error, "relay error.error", ["code", "message"]);
  stringValue(value.error.code, "relay error.code", { max: 128 });
  stringValue(value.error.message, "relay error.message", { max: 4_096 });
  return value;
}
