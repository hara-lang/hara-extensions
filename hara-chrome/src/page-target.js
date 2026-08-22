const PAGE_RPC_BUCKET = "__haraDevtoolsRpcV1";

/**
 * Runs inside the inspected page. Keep this function self-contained because
 * Chrome serialises it into the page's main JavaScript world.
 */
export async function pageDispatch(request) {
  function toPlain(value, seen = new WeakSet()) {
    if (value === null || value === undefined) return null;
    if (["string", "boolean"].includes(typeof value)) return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return String(value);
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    const type = value?.constructor?.name;
    if ((type === "HtaKeyword" || type === "Keyword") && typeof value.name === "string") {
      return `:${value.name}`;
    }
    if ((type === "HtaSymbol" || type === "Symbol") && typeof value.name === "string") {
      return value.name;
    }
    if (Array.isArray(value)) return value.map((item) => toPlain(item, seen));
    if (value instanceof Set) return [...value].map((item) => toPlain(item, seen));
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) => [toPlain(key, seen), toPlain(item, seen)]);
      const objectLike = entries.every(([key]) => typeof key === "string");
      return objectLike ? Object.fromEntries(entries) : entries;
    }
    if (ArrayBuffer.isView(value)) return [...value];

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (["context", "worker", "spawn", "resources"].includes(key)) continue;
      output[key] = toPlain(item, seen);
    }
    return output;
  }

  function pageMetadata() {
    return {
      url: globalThis.location?.href ?? null,
      title: globalThis.document?.title ?? null,
      visibility: globalThis.document?.visibilityState ?? null,
      documentId: globalThis.performance?.timeOrigin
        ? `${Math.trunc(globalThis.performance.timeOrigin)}:${globalThis.location?.href ?? ""}`
        : globalThis.location?.href ?? null,
    };
  }

  function candidates() {
    return [
      globalThis.hara,
      globalThis.Hara,
      globalThis.__hara,
      globalThis.__HARA__,
      globalThis.haraRuntime,
    ].filter(Boolean);
  }

  function fallbackRuntime() {
    return candidates().find((candidate) => candidate?.broker) ?? null;
  }

  function brokerDescription(runtime, id = "default") {
    const broker = runtime.broker;
    const runningNames = typeof broker.list === "function"
      ? broker.list()
      : [...(broker.kernels?.keys?.() ?? [])];
    const pendingNames = [...(broker.pending?.keys?.() ?? [])];
    const names = [...new Set([...runningNames, ...pendingNames])];
    const activeKernel = runtime.studio?.state?.kernel
      ?? runtime.state?.activeKernel
      ?? runtime.activeKernel
      ?? runningNames[0]
      ?? "ROOT";
    const activeSpace = runtime.state?.activeSpace
      ?? runtime.activeSpace
      ?? runtime.studio?.state?.space
      ?? null;
    const documents = [...(broker.documents?.values?.() ?? [])].map((document) => ({
      kernel: document.kernel ?? null,
      documentId: document.documentId ?? null,
      generation: document.generation ?? null,
      moduleId: document.moduleId ?? null,
      nodeId: document.nodeId ?? null,
      private: true,
    }));
    return {
      id,
      label: runtime.label ?? globalThis.document?.title ?? "Hara page",
      activeKernel,
      activeSpace,
      kernels: names.map((name) => ({
        name,
        state: pendingNames.includes(name) ? "starting" : "running",
        active: name === activeKernel,
      })),
      pending: pendingNames,
      documents,
    };
  }

  async function invokeRegistry(registry, input) {
    if (typeof registry.dispatch === "function") return registry.dispatch(input);
    const methods = {
      describe: "describe",
      eval: "eval",
      "session.list": "listKernels",
      "session.info": "inspectKernel",
      "session.new": "createKernel",
      "session.close": "closeKernel",
      doc: "doc",
      complete: "complete",
    };
    const method = methods[input.op];
    if (!method || typeof registry[method] !== "function") {
      throw new Error(`HARA_DEVTOOLS_UNSUPPORTED ${input.op}`);
    }
    return registry[method](input);
  }

  const registry = globalThis[Symbol.for("hara.devtools.registry.v1")];
  if (registry) return toPlain(await invokeRegistry(registry, request));

  const runtime = fallbackRuntime();
  if (!runtime) throw new Error("HARA_NOT_FOUND");
  const broker = runtime.broker;
  const brokerId = request.brokerId ?? "default";
  if (brokerId !== "default") throw new Error(`NO_BROKER ${brokerId}`);
  const session = request.session ?? request.kernel
    ?? runtime.studio?.state?.kernel
    ?? runtime.state?.activeKernel
    ?? "ROOT";

  switch (request.op) {
    case "describe":
      return toPlain({ version: 1, page: pageMetadata(), brokers: [brokerDescription(runtime)] });
    case "session.list":
      return toPlain(typeof broker.list === "function" ? broker.list() : []);
    case "session.info": {
      const description = brokerDescription(runtime);
      const kernel = description.kernels.find((entry) => entry.name === session);
      if (!kernel) throw new Error(`NO_SESSION ${session}`);
      return toPlain({
        ...kernel,
        brokerId,
        activeSpace: description.activeSpace,
        documents: description.documents.filter((entry) => entry.kernel === session),
      });
    }
    case "session.new":
      if (typeof broker.create !== "function") throw new Error("SESSION_CREATE_UNSUPPORTED");
      await broker.create(session);
      return session;
    case "session.close":
      if (typeof broker.close !== "function") throw new Error("SESSION_CLOSE_UNSUPPORTED");
      await broker.close(session);
      return true;
    case "eval": {
      if (typeof request.source !== "string") throw new Error("EVAL_SOURCE_MUST_BE_STRING");
      const value = await broker.eval(session, request.source);
      return toPlain(value);
    }
    case "doc": {
      const symbol = String(request.symbol ?? "");
      if (!/^[A-Za-z0-9*+!?._/-]+$/.test(symbol)) throw new Error("INVALID_SYMBOL");
      const source = `["SYMBOL" "${symbol}" "DOC" (get (meta #'${symbol}) :doc) "ARGLISTS" (get (meta #'${symbol}) :arglists) "FILE" (get (meta #'${symbol}) :file) "LINE" (get (meta #'${symbol}) :line) "COLUMN" (get (meta #'${symbol}) :column)]`;
      return toPlain(await broker.eval(session, source));
    }
    case "complete":
      return [];
    default:
      throw new Error(`HARA_DEVTOOLS_UNSUPPORTED ${request.op}`);
  }
}

function evalInspected(inspectedWindow, expression) {
  return new Promise((resolve, reject) => {
    inspectedWindow.eval(expression, (result, exception) => {
      if (exception) {
        reject(new Error(exception.value ?? exception.description ?? exception.code ?? "inspected eval failed"));
      } else {
        resolve(result);
      }
    });
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Promise-capable RPC over chrome.devtools.inspectedWindow.eval(). The eval API
 * only returns JSON values synchronously, so page promises settle into a small
 * page-side mailbox which the panel polls.
 */
export function createPageTargetClient(inspectedWindow, {
  timeout = 5000,
  pollInterval = 25,
} = {}) {
  if (!inspectedWindow?.eval) throw new Error("INSPECTED_WINDOW_REQUIRED");
  let counter = 0;

  async function request(input) {
    const id = `hara-${Date.now().toString(36)}-${(++counter).toString(36)}`;
    const dispatch = `(${pageDispatch.toString()})`;
    const start = `(() => {
      const bucket = globalThis[${JSON.stringify(PAGE_RPC_BUCKET)}] ||= Object.create(null);
      const id = ${JSON.stringify(id)};
      bucket[id] = { status: "pending" };
      Promise.resolve(${dispatch}(${JSON.stringify(input)})).then(
        value => { bucket[id] = { status: "done", value }; },
        error => { bucket[id] = { status: "error", error: String(error?.message ?? error) }; }
      );
      return true;
    })()`;
    await evalInspected(inspectedWindow, start);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const poll = `(() => {
        const bucket = globalThis[${JSON.stringify(PAGE_RPC_BUCKET)}];
        const id = ${JSON.stringify(id)};
        const entry = bucket?.[id];
        if (!entry) return { status: "missing" };
        if (entry.status === "pending") return entry;
        delete bucket[id];
        return entry;
      })()`;
      const entry = await evalInspected(inspectedWindow, poll);
      if (entry?.status === "done") return entry.value;
      if (entry?.status === "error") throw new Error(entry.error ?? "page request failed");
      if (entry?.status === "missing") throw new Error("HARA_PAGE_RELOADED");
      await delay(pollInterval);
    }
    throw new Error(`HARA_PAGE_TIMEOUT ${input.op ?? "request"}`);
  }

  return {
    request,
    describe: () => request({ op: "describe" }),
    list: (brokerId = "default") => request({ op: "session.list", brokerId }),
    info: (brokerId, session) => request({ op: "session.info", brokerId, session }),
    eval: ({ brokerId = "default", session = "ROOT", source, file, line, column }) =>
      request({ op: "eval", brokerId, session, source, file, line, column }),
    create: (brokerId, session) => request({ op: "session.new", brokerId, session }),
    close: (brokerId, session) => request({ op: "session.close", brokerId, session }),
    doc: (brokerId, session, symbol) => request({ op: "doc", brokerId, session, symbol }),
    complete: (brokerId, session, prefix) => request({ op: "complete", brokerId, session, prefix }),
  };
}

export function flattenPageTargets(description) {
  const page = description?.page ?? {};
  const targets = [];
  for (const broker of description?.brokers ?? []) {
    for (const kernel of broker.kernels ?? []) {
      targets.push({
        id: `page:${broker.id}:${kernel.name}`,
        environmentId: `page:${broker.id}`,
        kind: "page",
        brokerId: broker.id,
        kernel: kernel.name,
        label: `${broker.label ?? page.title ?? "Page"} · ${kernel.name}`,
        state: kernel.state ?? "running",
        active: Boolean(kernel.active),
        page,
      });
    }
  }
  return targets;
}
