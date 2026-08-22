import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeSupervisor } from "../src/runtime-supervisor.js";
import { createPortPair, tick } from "./helpers.js";

function fixture({ authorizeClientRequest = async () => true } = {}) {
  let documentOpen = false;
  let createCount = 0;
  let closeCount = 0;
  let supervisor;
  let hostPair;
  const hostRequests = [];

  const chromeApi = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      async getContexts() {
        return documentOpen ? [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: "chrome-extension://test/src/runtime-host.html" }] : [];
      },
    },
    offscreen: {
      async createDocument(options) {
        createCount += 1;
        documentOpen = true;
        hostPair = createPortPair("hara-runtime-host");
        hostPair.b.onMessage.addListener((message) => {
          if (message.channel !== "runtime-request") return;
          hostRequests.push(message);
          let value;
          switch (message.method) {
            case "runtime.start":
              value = { status: { runtimeState: "ready", targetTabId: message.args[0].targetTabId, kernel: "ROOT", kernels: ["ROOT"], instanceId: "runtime-1" } };
              break;
            case "runtime.bind":
              value = { status: { runtimeState: "ready", targetTabId: message.args[0].targetTabId, kernel: "ROOT", kernels: ["ROOT"], instanceId: "runtime-1" } };
              break;
            case "resp.connect":
              value = { status: { runtimeState: "ready", respState: "connected", respUrl: message.args[0].url, instanceId: "runtime-1" } };
              break;
            case "resp.disconnect":
              value = { status: { runtimeState: "ready", respState: "off", instanceId: "runtime-1" } };
              break;
            case "runtime.stop":
              value = { status: { runtimeState: "off", respState: "off", kernel: null, kernels: [], instanceId: null } };
              break;
            default:
              value = { value: message.args[0] ?? null, snapshot: { runtimeState: "ready", instanceId: "runtime-1" } };
          }
          hostPair.b.postMessage({ channel: "runtime-response", id: message.id, ok: true, value });
        });
        queueMicrotask(() => supervisor.attachHostPort(hostPair.a));
        assert.equal(options.url, "src/runtime-host.html");
        assert.deepEqual(options.reasons, ["WORKERS"]);
      },
      async closeDocument() {
        closeCount += 1;
        documentOpen = false;
        hostPair?.b.disconnect();
      },
    },
  };
  supervisor = createRuntimeSupervisor({ chromeApi, hostTimeoutMs: 1000, providerTimeoutMs: 1000, authorizeClientRequest });
  return {
    chromeApi,
    supervisor,
    hostRequests,
    counts: () => ({ createCount, closeCount, documentOpen }),
    host: () => hostPair?.b,
  };
}

test("runtime supervisor creates one offscreen document and proxies runtime clients", async () => {
  const env = fixture();
  const statuses = [];
  env.supervisor.onStatus((status) => statuses.push(status));

  const started = await env.supervisor.start(73);
  assert.equal(started.status.runtimeState, "ready");
  assert.equal(env.counts().createCount, 1);
  assert.equal(await env.supervisor.hasDocument(), true);

  await env.supervisor.start(73);
  assert.equal(env.counts().createCount, 1, "the existing offscreen document is reused");

  const client = createPortPair("hara-runtime-client");
  env.supervisor.attachClientPort(client.a);
  const replies = [];
  client.b.onMessage.addListener((message) => replies.push(message));
  client.b.postMessage({ channel: "runtime-client-register", targetTabId: 73 });
  await tick();
  client.b.postMessage({ channel: "runtime-request", id: 91, method: "broker.eval", args: ["ROOT", "(+ 1 1)"] });
  await tick();
  await tick();
  assert.ok(replies.some((message) => message.channel === "runtime-response" && message.id === 91 && message.ok));
  assert.ok(statuses.some((status) => status.runtimeState === "ready"));

  const stopped = await env.supervisor.stop({ closeDocument: true });
  assert.equal(stopped.status.runtimeState, "off");
  assert.equal(env.counts().closeCount, 1);
  assert.equal(await env.supervisor.hasDocument(), false);
});

test("runtime supervisor routes page target requests through the provider for the exact tab", async () => {
  const env = fixture();
  await env.supervisor.start(41);

  const provider = createPortPair("hara-page-provider");
  env.supervisor.attachProviderPort(provider.a);
  provider.b.postMessage({ channel: "provider-register", targetTabId: 41 });
  provider.b.onMessage.addListener((message) => {
    if (message.channel !== "provider-request") return;
    provider.b.postMessage({
      channel: "provider-response",
      id: message.id,
      ok: true,
      value: [{ environmentId: "page:default", kind: "page", kernel: "ROOT" }],
    });
  });
  await tick();

  const responses = [];
  env.host().onMessage.addListener((message) => {
    if (message.channel === "provider-response") responses.push(message);
  });
  env.host().postMessage({ channel: "provider-request", id: 7, targetTabId: 41, method: "target.list", args: [] });
  await tick();
  await tick();
  assert.deepEqual(responses[0], {
    channel: "provider-response",
    id: 7,
    ok: true,
    value: [{ environmentId: "page:default", kind: "page", kernel: "ROOT" }],
  });

  env.host().postMessage({ channel: "provider-request", id: 8, targetTabId: 99, method: "target.list", args: [] });
  await tick();
  assert.equal(responses[1].ok, false);
  assert.equal(responses[1].code, "runtime/provider-unavailable");
});

test("runtime supervisor binds each panel client to its registered tab and applies the control authorizer", async () => {
  const authorized = [];
  const env = fixture({
    authorizeClientRequest: async (request) => {
      authorized.push(request);
      return request.tabId === 41;
    },
  });
  const supervisor = env.supervisor;
  await supervisor.start(41);

  const client = createPortPair("hara-runtime-client");
  supervisor.attachClientPort(client.a);
  const replies = [];
  client.b.onMessage.addListener((message) => replies.push(message));
  client.b.postMessage({ channel: "runtime-client-register", targetTabId: 42 });
  await tick();
  client.b.postMessage({ channel: "runtime-request", id: 1, method: "broker.eval", args: ["ROOT", "(+ 1 1)"] });
  await tick();
  assert.equal(replies.find((message) => message.id === 1)?.code, "control/tab-disabled");

  client.b.postMessage({ channel: "runtime-request", id: 2, method: "runtime.bind", args: [{ targetTabId: 41 }] });
  await tick();
  assert.equal(replies.find((message) => message.id === 2)?.code, "runtime/client-target-mismatch");
  assert.deepEqual(authorized.map((entry) => entry.tabId), [42]);
  await supervisor.close();
});
