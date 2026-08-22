import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeHostCore } from "../src/runtime-host-core.js";

function fakeBroker() {
  const kernels = new Map();
  const pending = new Map();
  const documents = new Map();
  const previews = new Map();
  const calls = [];
  const mounts = [];
  const contextFor = (name) => ({
    async createFilesystem(options) {
      const mount = { id: `fs-${mounts.length + 1}`, options };
      mounts.push(mount);
      return mount;
    },
    session(session = "ROOT") {
      return {
        async attachFilesystem(mount) { calls.push(["attach", name, session, mount.id]); return true; },
        async call(operation, args) { calls.push(["session-call", name, session, operation, args]); return new Map([[{ name: "value" }, 42]]); },
      };
    },
    async call(operation, args) { calls.push(["call", name, operation, args]); return true; },
    close() {},
  });
  function ensure(name = "ROOT") {
    if (!kernels.has(name)) kernels.set(name, { name, context: contextFor(name), worker: { terminate() {} }, sessions: new Set(["ROOT"]) });
    return kernels.get(name);
  }
  const broker = {
    kernels,
    pending,
    documents,
    previews,
    list() { ensure("ROOT"); return [...kernels.keys()]; },
    async require(name = "ROOT") { return ensure(name); },
    async eval(name, source) {
      ensure(name);
      if (source === "(explode)") throw Object.assign(new Error("user eval failed"), { code: "EVAL_FAILED" });
      return source === "(+ 40 2)" ? 42 : source;
    },
    async create(name) { if (kernels.has(name)) throw new Error(`SESSION_EXISTS ${name}`); return ensure(name); },
    async close(name) { kernels.delete(name); return true; },
    async previewDocument(kernel, documentId, forms) {
      const generationId = "preview-1";
      const trace = new Map([[{ name: "status" }, { name: "ok" }]]);
      previews.set(generationId, { traces: new Map([["trace-1", trace]]) });
      return { generationId, sessionName: "PREVIEW.1", rows: [{ ...forms[0], status: "ok", traceId: "trace-1", value: "42" }] };
    },
    getPreviewTrace(generationId, traceId) { return previews.get(generationId).traces.get(traceId); },
    async disposePreview(generationId) { return previews.delete(generationId); },
    async prepareDocument(kernel, documentId, source, options) {
      return { kernel, documentId, source, nodeId: options?.nodeId ?? null, generation: 1, moduleId: "module-1", value: "task-1", prepared: true };
    },
    async evalPreparedDocument(candidate, source) { return `${candidate.documentId}:${source}`; },
    commitDocument(candidate) {
      candidate.prepared = false;
      const value = { ...candidate };
      documents.set(`${candidate.kernel}\0${candidate.documentId}`, value);
      return value;
    },
    discardDocument(candidate) { candidate.prepared = false; return true; },
    hasDocument(kernel, documentId) { return documents.has(`${kernel}\0${documentId}`); },
    async evalForm(_kernel, _documentId, source) { return source; },
    releaseDocument(kernel, documentId) { return documents.delete(`${kernel}\0${documentId}`); },
    async traceEval(_kernel, _session, source) { return new Map([[{ name: "source" }, source]]); },
    async listSessions() { return ["ROOT"]; },
    async createSession(kernel, name, options) { return { kernel, name, context: contextFor(kernel), options }; },
    async closeSession() { return true; },
    async evalSession(_kernel, _session, source) { return source; },
    async evalDocument(kernel, documentId, source) {
      const value = { kernel, documentId, generation: 2, moduleId: "module-2", value: source };
      documents.set(`${kernel}\0${documentId}`, value);
      return value;
    },
  };
  return { broker, calls, mounts };
}

test("offscreen runtime core owns broker, filesystem, document, and RESP lifecycle", async () => {
  const environment = fakeBroker();
  let disposed = false;
  const statuses = [];
  const sockets = [];
  const core = createRuntimeHostCore({
    loadRuntime: async () => ({ broker: environment.broker, dispose: async () => { disposed = true; environment.broker.kernels.clear(); } }),
    connectResp: (url, handler, { onStatus }) => {
      const socket = { url, handler, close() { onStatus("closed"); } };
      sockets.push(socket);
      onStatus("connected");
      return socket;
    },
    createRespHandler: ({ listTargets }) => async (message) => message.op === "target.list" ? listTargets() : null,
    requestProvider: async () => [],
    onStatus: (value) => statuses.push(value),
    now: (() => { let value = 1000; return () => ++value; })(),
  });

  assert.equal(core.snapshot().runtimeState, "off");
  const started = await core.dispatch("runtime.start", [{ targetTabId: 41 }]);
  assert.equal(started.status.runtimeState, "ready");
  assert.equal(started.status.targetTabId, 41);
  assert.match(started.status.instanceId, /^runtime-/);
  assert.deepEqual(started.status.kernels, ["ROOT"]);

  const evaluated = await core.dispatch("broker.eval", ["ROOT", "(+ 40 2)"]);
  assert.equal(evaluated.value, 42);

  const filesystem = await core.dispatch("context.create-filesystem", ["ROOT", { provider: "indexeddb", key: "home" }]);
  assert.match(filesystem.value.mountId, /^mount-/);
  const attached = await core.dispatch("context.attach-filesystem", ["ROOT", "ROOT", filesystem.value.mountId]);
  assert.equal(attached.value, true);
  assert.deepEqual(environment.calls[0], ["attach", "ROOT", "ROOT", "fs-1"]);

  const prepared = await core.dispatch("broker.prepare-document", ["ROOT", "doc-1", "(def x 1)", { nodeId: "node-1" }]);
  assert.match(prepared.value.candidateId, /^candidate-/);
  const committed = await core.dispatch("broker.commit-document", [prepared.value.candidateId]);
  assert.equal(committed.value.documentId, "doc-1");
  assert.equal(core.snapshot().documents.length, 1);

  const preview = await core.dispatch("broker.preview-document", ["ROOT", "doc-1", [{ source: "(+ 1 1)" }], {}]);
  assert.equal(preview.value.rows[0].traceId, "trace-1");
  assert.ok(preview.value.traces["trace-1"] instanceof Map);

  const connected = await core.dispatch("resp.connect", [{ url: "ws://127.0.0.1:7356" }]);
  assert.equal(connected.status.respState, "connected");
  assert.equal(sockets.length, 1);

  await assert.rejects(core.dispatch("broker.eval", ["ROOT", "(explode)"]), /user eval failed/);
  assert.equal(core.snapshot().runtimeState, "ready");
  assert.equal(core.snapshot().error, null, "ordinary evaluator failures do not poison runtime health");

  const stopped = await core.dispatch("runtime.stop");
  assert.equal(stopped.status.runtimeState, "off");
  assert.equal(stopped.status.instanceId, null);
  assert.equal(disposed, true);
  assert.ok(statuses.some((status) => status.runtimeState === "stopping"));
});

test("runtime core validates bound tab IDs and resolves remote filesystem mounts for sessions", async () => {
  const environment = fakeBroker();
  const core = createRuntimeHostCore({
    loadRuntime: async () => ({ broker: environment.broker }),
    connectResp: () => ({ close() {} }),
    createRespHandler: () => async () => null,
    requestProvider: async () => [],
  });
  await assert.rejects(core.dispatch("runtime.start", [{ targetTabId: 0 }]), (error) => error.code === "runtime/invalid-tab");
  await core.dispatch("runtime.start", [{ targetTabId: 9 }]);
  const filesystem = await core.dispatch("context.create-filesystem", ["ROOT", { provider: "indexeddb", key: "space" }]);
  const session = await core.dispatch("broker.create-session", ["ROOT", "WORK", { filesystem: { __haraRemoteMount: filesystem.value.mountId } }]);
  assert.deepEqual(session.value, { kernel: "ROOT", name: "WORK" });
});

test("runtime stop failures remain retryable instead of losing the live environment", async () => {
  const environment = fakeBroker();
  let disposeAttempts = 0;
  const core = createRuntimeHostCore({
    loadRuntime: async () => ({
      broker: environment.broker,
      dispose: async () => {
        disposeAttempts += 1;
        if (disposeAttempts === 1) {
          throw Object.assign(new Error("reap failed"), { code: "RUNTIME_REAP_FAILED" });
        }
        environment.broker.kernels.clear();
      },
    }),
    connectResp: () => ({ close() {} }),
    createRespHandler: () => async () => null,
    requestProvider: async () => [],
  });

  await core.dispatch("runtime.start", [{ targetTabId: 51 }]);
  await assert.rejects(core.dispatch("runtime.stop"), (error) => error.code === "RUNTIME_REAP_FAILED");
  assert.equal(core.snapshot().runtimeState, "error");
  assert.equal(core.snapshot().error.code, "RUNTIME_REAP_FAILED");
  assert.ok(core._state().loaded, "the environment remains reachable for a cleanup retry");

  const stopped = await core.dispatch("runtime.stop");
  assert.equal(disposeAttempts, 2);
  assert.equal(stopped.status.runtimeState, "off");
  assert.equal(core._state().loaded, null);
});

test("stale RESP socket callbacks cannot overwrite a newer connection state", async () => {
  const environment = fakeBroker();
  const sockets = [];
  const core = createRuntimeHostCore({
    loadRuntime: async () => ({ broker: environment.broker }),
    connectResp: (url, _handler, { onStatus }) => {
      const socket = {
        url,
        closed: false,
        close() { this.closed = true; },
        emit(state) { onStatus(state); },
      };
      sockets.push(socket);
      return socket;
    },
    createRespHandler: () => async () => null,
    requestProvider: async () => [],
  });

  await core.dispatch("runtime.start", [{ targetTabId: 61 }]);
  await core.dispatch("resp.connect", [{ url: "ws://127.0.0.1:7356/first" }]);
  sockets[0].emit("connected");
  assert.equal(core.snapshot().respState, "connected");

  await core.dispatch("resp.connect", [{ url: "ws://127.0.0.1:7356/second" }]);
  assert.equal(sockets[0].closed, true);
  sockets[1].emit("connected");
  assert.equal(core.snapshot().respState, "connected");

  sockets[0].emit("closed");
  assert.equal(core.snapshot().respState, "connected", "the replaced socket cannot mark the live connection offline");

  await core.dispatch("resp.disconnect");
  sockets[1].emit("error");
  assert.equal(core.snapshot().respState, "off", "callbacks after explicit disconnect are ignored");
});
