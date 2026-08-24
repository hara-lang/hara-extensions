import { expect, test } from "@playwright/test";

import { REMOTE_LANGUAGE_HOST_STORAGE_KEY } from "../src/remote-language-host-core.js";
import { LOOPBACK_RELAY_PROTOCOL } from "../src/remote-host-protocol.js";
import { sha256Source } from "../src/remote-sandbox-executor.js";
import { launchWithExtension } from "./extension.js";
import { TEST_TOKEN, eventually, startFakeRelay, testRequest } from "./remote-host-fixtures.js";

test("offscreen Hara language host evaluates through a fresh canonical pure Wasm sandbox", async () => {
  test.setTimeout(120_000);
  const positive = testRequest({ sourceDigest: await sha256Source("(+ 40 2)") });
  const deniedSource = "(require [chrome.api])";
  const negative = testRequest({
    requestId: "00000000-0000-4000-8000-000000000173",
    source: deniedSource,
    sourceDigest: await sha256Source(deniedSource),
  });
  const queue = [
    { commandId: `relay:${positive.requestId}:execute`, request: positive, acknowledged: false },
    { commandId: `relay:${negative.requestId}:execute`, request: negative, acknowledged: false },
  ];
  const results = [];
  let descriptor = null;
  const relay = await startFakeRelay({
    onRegister: (body) => {
      descriptor = body.descriptor;
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: true,
        hostId: descriptor.hostId,
        generation: descriptor.generation,
        heartbeatTtlMs: 5_000,
        pollAfterMs: 1,
      };
    },
    onPoll: (body) => {
      const current = queue[results.length];
      if (!current) return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
      if (body.acknowledgedCommandId === current.commandId) current.acknowledged = true;
      if (!current.acknowledged) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: current.commandId,
          request: current.request,
        };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult: (body) => {
      results.push(body.result);
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });

  const runtime = await launchWithExtension({ url: "about:blank" });
  try {
    await runtime.serviceWorker.evaluate(
      async ({ key, relayUrl, token }) => {
        await chrome.storage.local.set({
          [key]: {
            enabled: true,
            relayUrl,
            token,
            hostId: "hara.chrome.playwright",
            generation: 1,
          },
        });
        await globalThis.haraRuntimeSupervisor.ensureDocument();
        return true;
      },
      { key: REMOTE_LANGUAGE_HOST_STORAGE_KEY, relayUrl: relay.url, token: TEST_TOKEN },
    );

    await eventually(() => results.length === 2, { timeoutMs: 60_000, intervalMs: 25 });

    expect(descriptor).not.toBeNull();
    expect(descriptor.kind).toBe("browser-wasm");
    expect(descriptor.backend).toBe("raw-wasm");
    expect(descriptor.profiles).toEqual(["hara.mcp-pure/0-alpha"]);
    expect(descriptor.operations).toEqual(["runtime.get", "sandbox.eval"]);
    expect(descriptor.runtimeBuild).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(descriptor)).not.toContain(TEST_TOKEN);

    expect(results[0].status).toBe("completed");
    expect(results[0].value).toEqual({ text: "42", json: 42 });
    expect(results[0].runtime.runtimeBuild).toBe(descriptor.runtimeBuild);
    expect(results[0].evidence.profile).toBe("hara.mcp-pure/0-alpha");
    expect(results[0].evidence.sourceDigest).toBe(positive.sourceDigest);
    expect(results[0].evidence.cleanup).toBe("completed");

    expect(["completed", "failed"]).toContain(results[1].status);
    if (results[1].status === "completed") {
      expect(results[1].value?.json ?? null).toBeNull();
    }
    expect(JSON.stringify(results[1])).not.toMatch(/chrome\.api.*enabled|browser authority/i);
    expect(results[1].evidence.cleanup).toBe("completed");
    expect(JSON.stringify(results)).not.toContain(TEST_TOKEN);

    const offscreenUrl = `chrome-extension://${runtime.extensionId}/src/runtime-host.html`;
    const contexts = await runtime.serviceWorker.evaluate(
      async (documentUrl) => chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [documentUrl],
      }),
      offscreenUrl,
    );
    expect(contexts).toHaveLength(1);
  } finally {
    await runtime.serviceWorker.evaluate(async (key) => {
      await chrome.storage.local.set({ [key]: { enabled: false } });
    }, REMOTE_LANGUAGE_HOST_STORAGE_KEY).catch(() => {});
    await runtime.close();
    await relay.close();
  }
});
