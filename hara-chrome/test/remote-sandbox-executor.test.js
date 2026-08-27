import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCanonicalRemoteSandboxExecutor,
  sha256Source,
} from "../src/remote-sandbox-executor.js";
import { eventually, testDescriptor, testRequest } from "./remote-host-fixtures.js";

class FakeSandbox {
  constructor({ value = { text: "42", json: 42 }, waitForAbort = false } = {}) {
    this.value = value;
    this.waitForAbort = waitForAbort;
    this.state = "new";
    this.requests = [];
  }

  snapshot() {
    return { state: this.state };
  }

  async run(request, { signal } = {}) {
    this.requests.push(request);
    this.state = "running";
    if (this.waitForAbort) {
      await new Promise((_, reject) => {
        const rejectCancelled = () => {
          this.state = "closed";
          const error = new Error("sandbox request was cancelled");
          error.code = "sandbox/cancelled";
          reject(error);
        };
        if (signal?.aborted) rejectCancelled();
        else signal?.addEventListener("abort", rejectCancelled, { once: true });
      });
    }
    this.state = "closed";
    return {
      protocol: "hara.browser-wasm-sandbox/0-alpha",
      profile: "hara.mcp-pure/0-alpha",
      status: "completed",
      value: this.value,
      cleanup: "completed",
    };
  }

  cancel() {
    return this.state === "running";
  }

  close() {
    this.state = "closed";
  }
}

async function boundRequest(overrides = {}) {
  const source = overrides.source ?? "(+ 40 2)";
  return testRequest({ ...overrides, source, sourceDigest: await sha256Source(source) });
}

test("canonical remote executor creates a fresh eval-only sandbox and returns attributable 42", async () => {
  const sandboxes = [];
  const executor = createCanonicalRemoteSandboxExecutor({
    createSandbox: () => {
      const sandbox = new FakeSandbox();
      sandboxes.push(sandbox);
      return sandbox;
    },
  });
  const descriptor = testDescriptor();
  const first = await executor.execute(await boundRequest(), { descriptor });
  const second = await executor.execute(await boundRequest({
    requestId: "00000000-0000-4000-8000-000000000172",
  }), { descriptor });

  assert.equal(first.status, "completed");
  assert.deepEqual(first.value, { text: "42", json: 42 });
  assert.equal(first.evidence.cleanup, "completed");
  assert.equal(first.runtime.runtimeBuild, descriptor.runtimeBuild);
  assert.equal(second.status, "completed");
  assert.equal(sandboxes.length, 2);
  assert.notEqual(sandboxes[0], sandboxes[1]);
  for (const sandbox of sandboxes) {
    assert.equal(sandbox.requests.length, 1);
    assert.equal(sandbox.requests[0].operation, "sandbox.eval");
    assert.equal(sandbox.state, "closed");
  }
  assert.equal(executor.active(), 0);
});

test("source digest mismatch fails before sandbox creation", async () => {
  let creates = 0;
  const executor = createCanonicalRemoteSandboxExecutor({
    createSandbox: () => {
      creates += 1;
      return new FakeSandbox();
    },
  });
  const request = testRequest({ sourceDigest: `sha256:${"0".repeat(64)}` });
  const result = await executor.execute(request, { descriptor: testDescriptor() });
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0].code, "remote/source-digest-mismatch");
  assert.equal(creates, 0);
});

test("cancellation reaches the active canonical sandbox and settles once", async () => {
  const sandbox = new FakeSandbox({ waitForAbort: true });
  const executor = createCanonicalRemoteSandboxExecutor({ createSandbox: () => sandbox });
  const request = await boundRequest();
  const pending = executor.execute(request, { descriptor: testDescriptor() });
  await eventually(() => executor.active() === 1 && sandbox.state === "running");
  assert.equal(executor.cancel(request.requestId, "client-cancelled"), true);
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.evidence.cleanup, "completed");
  assert.equal(executor.cancel(request.requestId), false);
  assert.equal(executor.active(), 0);
});

test("unsupported call/check requests never reach a sandbox", async () => {
  let creates = 0;
  const executor = createCanonicalRemoteSandboxExecutor({
    createSandbox: () => {
      creates += 1;
      return new FakeSandbox();
    },
  });
  await assert.rejects(
    executor.execute({ ...testRequest(), operation: "sandbox.call" }, { descriptor: testDescriptor() }),
  );
  assert.equal(creates, 0);
});
