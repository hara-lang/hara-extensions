import assert from "node:assert/strict";
import { test } from "node:test";

import { createHaraRelayHostClient } from "../src/remote-host-client.js";
import { LOOPBACK_RELAY_PROTOCOL } from "../src/remote-host-protocol.js";
import {
  TEST_TOKEN,
  eventually,
  startFakeRelay,
  testDescriptor,
  testRequest,
  testResult,
} from "./remote-host-fixtures.js";

test("relay client registers, acknowledges, executes once and submits one bound result", async () => {
  const descriptor = testDescriptor();
  const request = testRequest();
  const executeId = `relay:${request.requestId}:execute`;
  let resultBody = null;
  const relay = await startFakeRelay({
    onPoll: (body) => body.acknowledgedCommandId === executeId
      ? { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 }
      : {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: executeId,
          request,
        },
    onResult: (body) => {
      resultBody = body;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });
  let executions = 0;
  const client = createHaraRelayHostClient({
    relayUrl: relay.url,
    pairingToken: TEST_TOKEN,
    descriptor,
    executor: {
      execute: async (received) => {
        executions += 1;
        assert.deepEqual(received, request);
        return testResult(received, descriptor);
      },
    },
    minBackoffMs: 1,
    maxBackoffMs: 5,
  });
  try {
    await client.start();
    await eventually(() => resultBody);
    assert.equal(executions, 1);
    assert.equal(resultBody.hostId, descriptor.hostId);
    assert.equal(resultBody.generation, descriptor.generation);
    assert.equal(resultBody.result.value.json, 42);
    assert.equal(resultBody.result.evidence.cleanup, "completed");
    const register = relay.requests.find(({ path }) => path === "/v0/host/register");
    assert.deepEqual(register.body.descriptor.operations, ["runtime.get", "sandbox.eval"]);
    assert.equal(register.headers.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(JSON.stringify(register.body).includes(TEST_TOKEN), false);
    assert.ok(relay.requests.some(({ path, body }) => (
      path === "/v0/host/poll" && body.acknowledgedCommandId === executeId
    )));
  } finally {
    await client.close();
    await relay.close();
  }
});

test("relay cancellation aborts the matching execution and returns a truthful cancelled terminal", async () => {
  const descriptor = testDescriptor();
  const request = testRequest();
  const executeId = `relay:${request.requestId}:execute`;
  const cancelId = `relay:${request.requestId}:cancel`;
  let resultBody = null;
  let cancelSent = false;
  const relay = await startFakeRelay({
    onPoll: (body) => {
      if (!body.acknowledgedCommandId) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: executeId,
          request,
        };
      }
      if (body.acknowledgedCommandId === executeId && !cancelSent) {
        cancelSent = true;
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "cancel",
          commandId: cancelId,
          requestId: request.requestId,
          reason: "client-cancelled",
        };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult: (body) => {
      resultBody = body;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });
  let cancels = 0;
  const client = createHaraRelayHostClient({
    relayUrl: relay.url,
    pairingToken: TEST_TOKEN,
    descriptor,
    executor: {
      execute: (received, { signal }) => new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(testResult(received, descriptor, {
          status: "cancelled",
          value: null,
          diagnostics: [{
            code: "remote/cancelled",
            severity: "warning",
            message: "remote Hara execution was cancelled",
          }],
        })), { once: true });
      }),
      cancel: () => {
        cancels += 1;
        return true;
      },
    },
    minBackoffMs: 1,
    maxBackoffMs: 5,
  });
  try {
    await client.start();
    await eventually(() => resultBody);
    assert.equal(resultBody.result.status, "cancelled");
    assert.equal(cancels, 1);
    assert.ok(relay.requests.some(({ path, body }) => (
      path === "/v0/host/poll" && body.acknowledgedCommandId === cancelId
    )));
  } finally {
    await client.close();
    await relay.close();
  }
});
