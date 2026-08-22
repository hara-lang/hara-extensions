import assert from "node:assert/strict";
import { test } from "node:test";
import { createRemoteBroker, createRuntimeClient } from "../src/runtime-client.js";
import { createPortPair, tick } from "./helpers.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("remote broker preserves the Studio broker shape while routing state to the offscreen runtime", async () => {
  const statusListeners = new Set();
  const calls = [];
  const commit = deferred();
  const connection = {
    onStatus(listener) { statusListeners.add(listener); listener({ runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], pending: [], documents: [] }); },
    reportError(error) { throw error; },
    async request(method, args) {
      calls.push([method, args]);
      switch (method) {
        case "broker.require": return { value: { name: args[0] }, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
        case "broker.eval": return { value: { answer: 42 }, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
        case "context.create-filesystem": return { value: { mountId: "mount-1" }, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
        case "context.attach-filesystem": return { value: true, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
        case "broker.prepare-document": return { value: { candidateId: "candidate-1", kernel: "ROOT", documentId: "doc", generation: 1, moduleId: "module", value: 7, prepared: true }, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
        case "broker.commit-document": return commit.promise;
        case "broker.eval-form": return { value: 9, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], documents: [{ kernel: "ROOT", documentId: "doc", generation: 1, moduleId: "module" }] } };
        case "broker.release-document": return { value: true, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], documents: [] } };
        default: return { value: true, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
      }
    },
  };

  const broker = createRemoteBroker(connection);
  assert.deepEqual(broker.list(), ["ROOT"]);
  const kernel = await broker.require("ROOT");
  const evaluated = await broker.eval("ROOT", "(+ 40 2)");
  assert.equal(evaluated instanceof Map, true);
  assert.equal([...evaluated.values()][0], 42);

  const mount = await kernel.context.createFilesystem({ provider: "indexeddb", key: "space" });
  await kernel.context.session().attachFilesystem(mount);
  assert.ok(calls.some(([method]) => method === "context.attach-filesystem"));

  const candidate = await broker.prepareDocument("ROOT", "doc", "(def x 1)");
  const committed = broker.commitDocument(candidate);
  assert.equal(committed.documentId, "doc");
  assert.equal(broker.hasDocument("ROOT", "doc"), true);
  let evalSettled = false;
  const form = broker.evalForm("ROOT", "doc", "(+ x 1)").then((value) => { evalSettled = true; return value; });
  await Promise.resolve();
  assert.equal(evalSettled, false, "form evaluation waits for the remote commit acknowledgement");
  commit.resolve({ value: committed, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], documents: [{ kernel: "ROOT", documentId: "doc", generation: 1, moduleId: "module" }] } });
  assert.equal(await form, 9);
  assert.equal(evalSettled, true);

  await broker.releaseDocument("ROOT", "doc");
  assert.equal(broker.hasDocument("ROOT", "doc"), false);
});

test("remote contexts are replaced after an explicit runtime instance change", async () => {
  let statusListener;
  const connection = {
    onStatus(listener) { statusListener = listener; listener({ runtimeState: "ready", instanceId: "runtime-a", kernels: ["ROOT"], documents: [] }); },
    reportError() {},
    async request(method, args) {
      if (method === "broker.require") return { value: { name: args[0] }, snapshot: { runtimeState: "ready", instanceId: "runtime-a", kernels: ["ROOT"] } };
      return { value: true, snapshot: { runtimeState: "ready", instanceId: "runtime-a", kernels: ["ROOT"] } };
    },
  };
  const broker = createRemoteBroker(connection);
  const first = (await broker.require("ROOT")).context;
  statusListener({ runtimeState: "off", instanceId: null, kernels: [], documents: [] });
  statusListener({ runtimeState: "ready", instanceId: "runtime-b", kernels: ["ROOT"], documents: [] });
  const second = (await broker.require("ROOT")).context;
  assert.notEqual(first, second);
});


test("runtime client registers its exact tab before requesting the shared runtime", async () => {
  const pair = createPortPair("hara-runtime-client");
  const messages = [];
  pair.b.onMessage.addListener((message) => {
    messages.push(message);
    if (message.channel === "runtime-request") {
      pair.b.postMessage({
        channel: "runtime-response",
        id: message.id,
        ok: true,
        value: { status: { runtimeState: "ready", targetTabId: 73, instanceId: "runtime-1" } },
      });
    }
  });
  const client = createRuntimeClient({
    chromeApi: { runtime: { connect: () => pair.a } },
    targetTabId: 73,
  });
  const started = await client.start();
  assert.equal(started.status.targetTabId, 73);
  assert.equal(messages[0].channel, "runtime-client-register");
  assert.equal(messages[0].targetTabId, 73);
  assert.equal(messages[1].channel, "runtime-request");
  await client.close();
  await tick();
});

test("explicit null runtime instance IDs invalidate cached remote contexts", async () => {
  let statusListener;
  let instanceId = "runtime-a";
  const connection = {
    onStatus(listener) {
      statusListener = listener;
      listener({ runtimeState: "ready", instanceId, kernels: ["ROOT"], documents: [] });
    },
    reportError() {},
    async request(method, args) {
      if (method === "broker.require") {
        return { value: { name: args[0] }, snapshot: { runtimeState: "ready", instanceId, kernels: ["ROOT"] } };
      }
      return { value: true, snapshot: { runtimeState: "ready", instanceId, kernels: ["ROOT"] } };
    },
  };

  const broker = createRemoteBroker(connection);
  const first = (await broker.require("ROOT")).context;
  instanceId = null;
  statusListener({ runtimeState: "ready", instanceId: null, kernels: ["ROOT"], documents: [] });
  const second = (await broker.require("ROOT")).context;
  assert.notEqual(first, second);
});

test("release waits for an in-flight remote document commit", async () => {
  const statusListeners = new Set();
  const commit = deferred();
  const calls = [];
  const connection = {
    onStatus(listener) {
      statusListeners.add(listener);
      listener({ runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], pending: [], documents: [] });
    },
    reportError(error) { throw error; },
    async request(method, args) {
      calls.push([method, args]);
      if (method === "broker.prepare-document") {
        return {
          value: {
            candidateId: "candidate-release",
            kernel: "ROOT",
            documentId: "doc-release",
            generation: 1,
            moduleId: "module-release",
            value: true,
            prepared: true,
          },
          snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], documents: [] },
        };
      }
      if (method === "broker.commit-document") return commit.promise;
      if (method === "broker.release-document") {
        return {
          value: true,
          snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"], documents: [] },
        };
      }
      return { value: true, snapshot: { runtimeState: "ready", instanceId: "runtime-1", kernels: ["ROOT"] } };
    },
  };

  const broker = createRemoteBroker(connection);
  const candidate = await broker.prepareDocument("ROOT", "doc-release", "(def x 1)");
  broker.commitDocument(candidate);
  let released = false;
  const release = broker.releaseDocument("ROOT", "doc-release").then((value) => {
    released = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(calls.some(([method]) => method === "broker.release-document"), false);

  commit.resolve({
    value: true,
    snapshot: {
      runtimeState: "ready",
      instanceId: "runtime-1",
      kernels: ["ROOT"],
      documents: [{ kernel: "ROOT", documentId: "doc-release", generation: 1, moduleId: "module-release" }],
    },
  });
  assert.equal(await release, true);
  assert.equal(calls.some(([method]) => method === "broker.release-document"), true);
});
