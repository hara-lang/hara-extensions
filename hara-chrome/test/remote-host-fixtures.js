import { createServer } from "node:http";

import {
  EXECUTION_HOST_PROTOCOL,
  EXECUTION_RESULT_PROTOCOL,
  LOOPBACK_RELAY_PROTOCOL,
  PURE_PROFILE,
  REMOTE_HOST_OPERATIONS,
} from "../src/remote-host-protocol.js";

export const TEST_TOKEN = "test-loopback-token-00000001";
export const TEST_HOST_ID = "hara.chrome.fixture";
export const TEST_GENERATION = 7;
export const TEST_RUNTIME_BUILD = `sha256:${"1".repeat(64)}`;
export const TEST_REQUEST_ID = "00000000-0000-4000-8000-000000000171";
export const TEST_SOURCE_DIGEST = `sha256:${"2".repeat(64)}`;

export function testDescriptor(overrides = {}) {
  return {
    protocol: EXECUTION_HOST_PROTOCOL,
    hostId: TEST_HOST_ID,
    generation: TEST_GENERATION,
    kind: "browser-wasm",
    state: "ready",
    backend: "raw-wasm",
    runtimeBuild: TEST_RUNTIME_BUILD,
    haraVersion: "hara-raw-wasm/0-alpha",
    profiles: [PURE_PROFILE],
    operations: [...REMOTE_HOST_OPERATIONS],
    limits: {
      maxSourceBytes: 65_536,
      maxOutputBytes: 1_048_576,
      maxWallMs: 30_000,
    },
    observedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function testRequest(overrides = {}) {
  return {
    protocol: EXECUTION_HOST_PROTOCOL,
    requestId: TEST_REQUEST_ID,
    operation: "sandbox.eval",
    profile: PURE_PROFILE,
    source: "(+ 40 2)",
    sourceDigest: TEST_SOURCE_DIGEST,
    limits: {
      wallMs: 5_000,
      outputBytes: 262_144,
    },
    ...overrides,
  };
}

export function testResult(request, descriptor, overrides = {}) {
  return {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: request.requestId,
    runId: `fixture:${request.requestId}`,
    status: "completed",
    value: { text: "42", json: 42 },
    stdout: "",
    stderr: "",
    diagnostics: [],
    runtime: {
      hostId: descriptor.hostId,
      hostGeneration: descriptor.generation,
      backend: descriptor.backend,
      runtimeBuild: descriptor.runtimeBuild,
      haraVersion: descriptor.haraVersion,
    },
    evidence: {
      profile: request.profile,
      sourceDigest: request.sourceDigest,
      startedAt: "2026-08-24T00:00:00.000Z",
      completedAt: "2026-08-24T00:00:00.001Z",
      elapsedMs: 1,
      cleanup: "completed",
    },
    ...overrides,
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startFakeRelay({ token = TEST_TOKEN, onRegister, onPoll, onResult } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: false,
          error: { code: "authentication_failed", message: "invalid bearer token" },
        }));
        return;
      }
      const body = await readJson(request);
      requests.push({ path: request.url, body, headers: { ...request.headers } });
      let value;
      if (request.url === "/v0/host/register") {
        value = (await onRegister?.(body, { request, response, requests })) ?? {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: true,
          hostId: body.descriptor.hostId,
          generation: body.descriptor.generation,
          heartbeatTtlMs: 5_000,
          pollAfterMs: 1,
        };
      } else if (request.url === "/v0/host/poll") {
        value = (await onPoll?.(body, { request, response, requests })) ?? {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "idle",
          retryAfterMs: 1,
        };
      } else if (request.url === "/v0/host/result") {
        value = (await onResult?.(body, { request, response, requests })) ?? {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: true,
          duplicate: false,
        };
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({
          protocol: LOOPBACK_RELAY_PROTOCOL,
          accepted: false,
          error: { code: "not_found", message: "not found" },
        }));
        return;
      }
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: false,
        error: { code: "internal_error", message: String(error?.message ?? error) },
      }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export async function eventually(predicate, { timeoutMs = 5_000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) throw lastError;
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}
