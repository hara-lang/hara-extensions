import { checkedTabId, fail, runtimeStatus } from "./runtime-protocol.js";

const ROOT = "ROOT";

function documentSnapshot(document) {
  return {
    kernel: document.kernel ?? null,
    documentId: document.documentId ?? null,
    generation: document.generation ?? null,
    moduleId: document.moduleId ?? null,
    nodeId: document.nodeId ?? null,
  };
}

function candidateResult(candidate) {
  return {
    candidateId: candidate.candidateId,
    kernel: candidate.kernel,
    documentId: candidate.documentId,
    generation: candidate.generation,
    moduleId: candidate.moduleId,
    nodeId: candidate.nodeId ?? null,
    value: candidate.value,
    prepared: candidate.prepared !== false,
  };
}

export function createRuntimeHostCore({
  loadRuntime,
  connectResp,
  createRespHandler,
  requestProvider,
  onStatus = () => {},
  now = () => Date.now(),
} = {}) {
  if (typeof loadRuntime !== "function") throw new TypeError("createRuntimeHostCore requires loadRuntime");
  if (typeof connectResp !== "function") throw new TypeError("createRuntimeHostCore requires connectResp");
  if (typeof createRespHandler !== "function") throw new TypeError("createRuntimeHostCore requires createRespHandler");
  if (typeof requestProvider !== "function") throw new TypeError("createRuntimeHostCore requires requestProvider");

  let loaded = null;
  let loading = null;
  let runtimeState = "off";
  let respState = "off";
  let respUrl = "ws://127.0.0.1:7356";
  let respSocket = null;
  let respConnectionGeneration = 0;
  let targetTabId = null;
  let generation = 0;
  let runtimeInstance = 0;
  let instanceId = null;
  let lastError = null;
  let nextMount = 1;
  let nextCandidate = 1;
  const mounts = new Map();
  const candidates = new Map();
  const previewTraces = new Map();

  function broker() {
    return loaded?.broker ?? null;
  }

  function snapshot() {
    const owner = broker();
    const kernels = owner ? owner.list() : [];
    const pending = owner?.pending ? [...owner.pending.keys()] : [];
    const documents = owner?.documents ? [...owner.documents.values()].map(documentSnapshot) : [];
    return runtimeStatus({
      runtimeState,
      respState,
      targetTabId,
      kernel: runtimeState === "ready" ? ROOT : null,
      respUrl,
      kernels,
      pending,
      documents,
      generation,
      instanceId,
      error: lastError,
    });
  }

  function publish(overrides = {}) {
    generation += 1;
    if ("runtimeState" in overrides) runtimeState = overrides.runtimeState;
    if ("respState" in overrides) respState = overrides.respState;
    if ("targetTabId" in overrides) targetTabId = overrides.targetTabId;
    if ("respUrl" in overrides) respUrl = overrides.respUrl;
    if ("error" in overrides) lastError = overrides.error;
    const value = snapshot();
    onStatus(value);
    return value;
  }

  async function ensureRuntime() {
    if (loaded) return loaded;
    if (loading) return loading;
    runtimeState = "starting";
    lastError = null;
    publish();
    loading = Promise.resolve(loadRuntime({ targetTabId: () => targetTabId })).then(async (value) => {
      if (!value?.broker) throw new Error("runtime loader did not return a broker");
      loaded = value;
      await loaded.broker.require(ROOT);
      runtimeInstance += 1;
      instanceId = `runtime-${now()}-${runtimeInstance}`;
      runtimeState = "ready";
      publish();
      return loaded;
    }, (error) => {
      runtimeState = "error";
      lastError = {
        code: error?.code ?? "runtime/start-failed",
        message: String(error?.message ?? error),
        at: now(),
      };
      publish();
      throw error;
    }).finally(() => { loading = null; });
    return loading;
  }

  async function disposeRuntime() {
    const current = loaded;
    if (current?.dispose) await current.dispose();
    if (loaded !== current) return;
    loaded = null;
    loading = null;
    mounts.clear();
    candidates.clear();
    previewTraces.clear();
    instanceId = null;
  }

  function localRecords() {
    const owner = broker();
    if (!owner) return [];
    return owner.list().map((kernel) => ({
      id: `local:${kernel}`,
      environmentId: "local",
      environmentLabel: "Browser local",
      kind: "local",
      kernel,
      label: `Browser local · ${kernel}`,
      state: owner.pending?.has?.(kernel) ? "starting" : "running",
      active: kernel === ROOT,
    }));
  }

  async function pageRecords() {
    if (!targetTabId) return [];
    try {
      const value = await requestProvider("target.list", [], targetTabId);
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error?.code === "runtime/provider-unavailable") return [];
      throw error;
    }
  }

  async function listTargets() {
    await ensureRuntime();
    return [...await pageRecords(), ...localRecords()];
  }

  function localAdapter() {
    const owner = broker();
    return {
      environmentId: "local",
      kind: "local",
      kernel: ROOT,
      list: async () => owner.list(),
      info: async (session) => {
        await owner.require(session);
        return {
          name: session,
          state: owner.pending?.has?.(session) ? "starting" : "running",
          active: session === ROOT,
          documents: [...(owner.documents?.values?.() ?? [])]
            .filter((document) => document.kernel === session)
            .map(documentSnapshot),
        };
      },
      eval: (session, source) => owner.eval(session, source),
      create: async (session) => { await owner.create(session); return session; },
      close: async (session) => { await owner.close(session); return true; },
      complete: async () => [],
    };
  }

  function pageAdapter(environmentId, record = {}) {
    const invoke = (operation, data = {}) => requestProvider(
      "target.invoke",
      [{ environmentId, operation, ...data }],
      targetTabId,
    );
    return {
      ...record,
      environmentId,
      kind: "page",
      list: () => invoke("session.list"),
      info: (session) => invoke("session.info", { session }),
      eval: (session, source, options = {}) => invoke("eval", { session, source, options }),
      create: (session) => invoke("session.new", { session }),
      close: (session) => invoke("session.close", { session }),
      doc: (session, symbol) => invoke("doc", { session, symbol }),
      complete: (session, prefix) => invoke("complete", { session, prefix }),
    };
  }

  async function resolveTarget(environmentId = null) {
    const records = await listTargets();
    if (!environmentId || environmentId === "local") return localAdapter();
    const record = records.find((entry) => entry.environmentId === environmentId && entry.active)
      ?? records.find((entry) => entry.environmentId === environmentId);
    if (!record) return null;
    return record.kind === "page" ? pageAdapter(environmentId, record) : localAdapter();
  }

  async function connectRespSocket(url = respUrl) {
    await ensureRuntime();
    const connectionGeneration = ++respConnectionGeneration;
    const previousSocket = respSocket;
    respSocket = null;
    previousSocket?.close?.();
    respUrl = String(url || respUrl);
    respState = "connecting";
    publish();
    const handler = createRespHandler({ listTargets, resolveTarget });
    let socket = null;
    const onStatus = (state) => {
      if (connectionGeneration !== respConnectionGeneration) return;
      if (socket !== null && respSocket !== socket) return;
      respState = state === "closed" ? "off" : state;
      if (state === "closed" && respSocket === socket) respSocket = null;
      publish();
    };
    socket = connectResp(respUrl, handler, { onStatus });
    if (connectionGeneration !== respConnectionGeneration) {
      socket?.close?.();
      return snapshot();
    }
    respSocket = socket;
    return snapshot();
  }

  async function disconnectRespSocket() {
    respConnectionGeneration += 1;
    const socket = respSocket;
    respSocket = null;
    socket?.close?.();
    respState = "off";
    publish();
    return snapshot();
  }

  function envelope(value) {
    return { value, snapshot: snapshot() };
  }

  async function brokerDispatch(method, args) {
    const owner = (await ensureRuntime()).broker;
    switch (method) {
      case "broker.snapshot":
        return envelope(null);
      case "broker.list":
        return envelope(owner.list());
      case "broker.require": {
        const name = String(args[0] ?? ROOT);
        await owner.require(name);
        return envelope({ name });
      }
      case "broker.eval":
        return envelope(await owner.eval(String(args[0] ?? ROOT), String(args[1] ?? "")));
      case "broker.create": {
        const name = String(args[0] ?? "");
        await owner.create(name, args[1] ?? {});
        return envelope({ name });
      }
      case "broker.close":
        await owner.close(String(args[0] ?? ""));
        return envelope(true);
      case "broker.preview-document": {
        const preview = await owner.previewDocument(String(args[0]), String(args[1]), args[2] ?? [], args[3] ?? {});
        const traces = {};
        for (const row of preview.rows ?? []) {
          if (!row.traceId) continue;
          traces[row.traceId] = owner.getPreviewTrace(preview.generationId, row.traceId);
        }
        previewTraces.set(preview.generationId, traces);
        return envelope({ ...preview, traces });
      }
      case "broker.dispose-preview": {
        const generationId = String(args[0]);
        previewTraces.delete(generationId);
        return envelope(await owner.disposePreview(generationId));
      }
      case "broker.eval-form":
        return envelope(await owner.evalForm(String(args[0]), String(args[1]), String(args[2] ?? "")));
      case "broker.prepare-document": {
        const candidate = await owner.prepareDocument(String(args[0]), String(args[1]), String(args[2] ?? ""), args[3] ?? {});
        const candidateId = `candidate-${nextCandidate++}`;
        candidate.candidateId = candidateId;
        candidates.set(candidateId, candidate);
        return envelope(candidateResult(candidate));
      }
      case "broker.eval-prepared-document": {
        const candidate = candidates.get(String(args[0]));
        if (!candidate) fail("runtime/no-candidate", `no prepared document candidate ${args[0]}`);
        return envelope(await owner.evalPreparedDocument(candidate, String(args[1] ?? "")));
      }
      case "broker.commit-document": {
        const candidateId = String(args[0]);
        const candidate = candidates.get(candidateId);
        if (!candidate) fail("runtime/no-candidate", `no prepared document candidate ${candidateId}`);
        candidates.delete(candidateId);
        return envelope(owner.commitDocument(candidate));
      }
      case "broker.discard-document": {
        const candidateId = String(args[0]);
        const candidate = candidates.get(candidateId);
        if (!candidate) return envelope(false);
        candidates.delete(candidateId);
        return envelope(owner.discardDocument(candidate));
      }
      case "broker.has-document":
        return envelope(owner.hasDocument(String(args[0]), String(args[1])));
      case "broker.trace-eval":
        return envelope(await owner.traceEval(String(args[0]), String(args[1]), String(args[2] ?? "")));
      case "broker.list-sessions":
        return envelope(await owner.listSessions(String(args[0])));
      case "broker.create-session": {
        const options = { ...(args[2] ?? {}) };
        const remoteMountId = options.filesystem?.__haraRemoteMount;
        if (remoteMountId) {
          const mount = mounts.get(String(remoteMountId));
          if (!mount) fail("runtime/no-mount", `no filesystem mount ${remoteMountId}`);
          options.filesystem = mount;
        }
        const session = await owner.createSession(String(args[0]), String(args[1]), options);
        return envelope({ kernel: session.kernel, name: session.name });
      }
      case "broker.close-session":
        return envelope(await owner.closeSession(String(args[0]), String(args[1])));
      case "broker.eval-session":
        return envelope(await owner.evalSession(String(args[0]), String(args[1]), String(args[2] ?? "")));
      case "broker.eval-document": {
        const result = await owner.evalDocument(String(args[0]), String(args[1]), String(args[2] ?? ""), args[3] ?? {});
        return envelope({
          kernel: result.kernel,
          documentId: result.documentId,
          generation: result.generation,
          moduleId: result.moduleId,
          nodeId: result.nodeId ?? null,
          value: result.value,
        });
      }
      case "broker.release-document":
        return envelope(owner.releaseDocument(String(args[0]), String(args[1])));
      default:
        if (method.startsWith("broker.")) fail("runtime/operation-unsupported", `unsupported broker operation ${method}`);
        return null;
    }
  }

  async function contextDispatch(method, args) {
    const owner = (await ensureRuntime()).broker;
    const kernelName = String(args[0] ?? ROOT);
    const kernel = await owner.require(kernelName);
    switch (method) {
      case "context.create-filesystem": {
        const mount = await kernel.context.createFilesystem(args[1] ?? { provider: "indexeddb", key: "home" });
        const mountId = `mount-${nextMount++}`;
        mounts.set(mountId, mount);
        return envelope({ mountId });
      }
      case "context.attach-filesystem": {
        const sessionName = String(args[1] ?? ROOT);
        const mount = mounts.get(String(args[2]));
        if (!mount) fail("runtime/no-mount", `no filesystem mount ${args[2]}`);
        await kernel.context.session(sessionName).attachFilesystem(mount);
        return envelope(true);
      }
      case "context.call": {
        const sessionName = args[1] == null ? null : String(args[1]);
        const operation = String(args[2] ?? "");
        const operationArgs = args[3] ?? [];
        const context = sessionName ? kernel.context.session(sessionName) : kernel.context;
        return envelope(await context.call(operation, operationArgs));
      }
      default:
        fail("runtime/operation-unsupported", `unsupported context operation ${method}`);
    }
  }

  async function dispatch(method, args = []) {
    try {
      switch (method) {
        case "runtime.status":
          return { status: snapshot() };
        case "runtime.start": {
          const options = args[0] ?? {};
          if (options.targetTabId != null) targetTabId = checkedTabId(options.targetTabId);
          lastError = null;
          await ensureRuntime();
          return { status: snapshot() };
        }
        case "runtime.bind": {
          const options = args[0] ?? {};
          targetTabId = checkedTabId(options.targetTabId);
          lastError = null;
          publish();
          return { status: snapshot() };
        }
        case "runtime.stop":
          runtimeState = "stopping";
          publish();
          await disconnectRespSocket();
          await disposeRuntime();
          runtimeState = "off";
          targetTabId = null;
          instanceId = null;
          lastError = null;
          publish();
          return { status: snapshot() };
        case "resp.connect":
          lastError = null;
          await connectRespSocket(args[0]?.url ?? respUrl);
          return { status: snapshot() };
        case "resp.disconnect":
          await disconnectRespSocket();
          return { status: snapshot() };
        case "resp.reconnect":
          lastError = null;
          await disconnectRespSocket();
          await connectRespSocket(args[0]?.url ?? respUrl);
          return { status: snapshot() };
        case "target.list":
          return { value: await listTargets(), status: snapshot() };
        default: {
          const brokerValue = await brokerDispatch(method, args);
          if (brokerValue) return brokerValue;
          if (method.startsWith("context.")) return contextDispatch(method, args);
          fail("runtime/operation-unsupported", `unsupported runtime operation ${method}`);
        }
      }
    } catch (error) {
      const operationalFailure = [
        "runtime.start", "runtime.bind", "runtime.stop",
        "resp.connect", "resp.disconnect", "resp.reconnect",
      ].includes(method);
      if (operationalFailure) {
        lastError = {
          code: error?.code ?? "runtime/request-failed",
          message: String(error?.message ?? error),
          at: now(),
        };
        if (["starting", "stopping"].includes(runtimeState)) runtimeState = "error";
        publish();
      }
      throw error;
    }
  }

  return {
    dispatch,
    snapshot,
    publish,
    listTargets,
    resolveTarget,
    _state: () => ({ loaded, loading, mounts, candidates, previewTraces, respSocket }),
  };
}
