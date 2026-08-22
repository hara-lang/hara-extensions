import { rm } from "node:fs/promises";

const RETRYABLE_PROFILE_ERRORS = new Set(["ENOTEMPTY"]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Chromium may release profile files slightly after the context close event,
 * especially on macOS. Retry only the known transient ENOTEMPTY race and
 * surface every other filesystem failure immediately.
 */
export async function removeProfileWithRetry(directory, {
  remove = (target) => rm(target, { recursive: true, force: true }),
  sleep = delay,
  attempts = 7,
  baseDelayMs = 25,
} = {}) {
  if (!directory) return;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError("profile cleanup attempts must be a positive integer");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(directory);
      return;
    } catch (error) {
      const retryable = RETRYABLE_PROFILE_ERRORS.has(error?.code);
      if (!retryable || attempt === attempts - 1) throw error;
      await sleep(baseDelayMs * (2 ** attempt));
    }
  }
}
