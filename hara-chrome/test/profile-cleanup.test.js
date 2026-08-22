import assert from "node:assert/strict";
import { test } from "node:test";
import { removeProfileWithRetry } from "../scripts/profile-cleanup.mjs";

test("disposable profile cleanup retries macOS ENOTEMPTY with backoff", async () => {
  const delays = [];
  let calls = 0;
  await removeProfileWithRetry("/tmp/profile", {
    remove: async () => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("directory not empty");
        error.code = "ENOTEMPTY";
        throw error;
      }
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    attempts: 5,
    baseDelayMs: 10,
  });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("profile cleanup does not hide non-transient filesystem failures", async () => {
  const error = new Error("permission denied");
  error.code = "EACCES";
  await assert.rejects(
    removeProfileWithRetry("/tmp/profile", {
      remove: async () => { throw error; },
      sleep: async () => assert.fail("non-transient errors must not be retried"),
    }),
    (found) => found === error,
  );
});
