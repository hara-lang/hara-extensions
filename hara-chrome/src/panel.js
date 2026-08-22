import { mountStudio } from "../vendor/studio/ui.js";
import { preloadRequires, parseSourcePaths, chooseHome, restoreHome } from "./home.js";
import { createPageTargetClient, flattenPageTargets } from "./page-target.js";
import { createRuntimeClient } from "./runtime-client.js";

const params = new URLSearchParams(location.search);
const readiness = { kernel: false, resp: "off", error: null, host: "offscreen" };
const tabId = params.has("tabId")
  ? Number(params.get("tabId"))
  : globalThis.chrome?.devtools?.inspectedWindow?.tabId;
if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("PANEL_TARGET_TAB_REQUIRED");

const inspectedWindow = globalThis.chrome?.devtools?.inspectedWindow;
const unavailablePageClient = new Proxy({}, {
  get: () => async () => { throw new Error("HARA_NOT_FOUND"); },
});
const pageClient = inspectedWindow ? createPageTargetClient(inspectedWindow) : unavailablePageClient;

async function pageTargetRecords() {
  try {
    const description = await pageClient.describe();
    return flattenPageTargets(description).map((record) => ({
      ...record,
      environmentLabel: description?.brokers?.find((entry) => entry.id === record.brokerId)?.label
        ?? description?.page?.title
        ?? "Inspected page",
    }));
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/HARA_NOT_FOUND|HARA_PAGE_RELOADED/.test(message)) console.debug("[hara panel] page scan", error);
    return [];
  }
}

function brokerIdFor(environmentId) {
  return String(environmentId ?? "").startsWith("page:")
    ? String(environmentId).slice("page:".length)
    : String(environmentId ?? "default");
}

const pageProvider = {
  list: pageTargetRecords,
  async invoke(input = {}) {
    const brokerId = brokerIdFor(input.environmentId);
    switch (input.operation) {
      case "session.list": return pageClient.list(brokerId);
      case "session.info": return pageClient.info(brokerId, input.session);
      case "session.new": return pageClient.create(brokerId, input.session);
      case "session.close": return pageClient.close(brokerId, input.session);
      case "eval": return pageClient.eval({
        brokerId,
        session: input.session,
        source: input.source,
        ...(input.options ?? {}),
      });
      case "doc": return pageClient.doc(brokerId, input.session, input.symbol);
      case "complete": return pageClient.complete(brokerId, input.session, input.prefix);
      default: throw new Error(`HARA_PAGE_PROVIDER_UNSUPPORTED ${input.operation}`);
    }
  },
};

const runtime = createRuntimeClient({ chromeApi: chrome, targetTabId: tabId, pageProvider });
await runtime.start();
const broker = runtime.broker;
const studio = mountStudio(document.getElementById("hara-studio-mount"), { broker });

const targetSelect = document.getElementById("kernel-target");
const kernelStatus = document.getElementById("kernel-status");
const respUrl = document.getElementById("resp-url");
const respButton = document.getElementById("resp-connect");
const respStatus = document.getElementById("resp-status");
let targetRecords = [];
let refreshGeneration = 0;
let runtimeState = runtime.status() ?? { runtimeState: "starting", respState: "off" };
let runtimeInstanceId = runtimeState.instanceId ?? null;

function localRecords() {
  return broker.list().map((kernel) => ({
    id: `local:${kernel}`,
    environmentId: "local",
    environmentLabel: "Browser local",
    kind: "local",
    kernel,
    label: `Browser local · ${kernel}`,
    state: broker.pending?.has?.(kernel) ? "starting" : "running",
    active: studio.state.kernel === kernel,
  }));
}

async function scanTargets() {
  const page = await pageTargetRecords();
  return { targets: [...page, ...localRecords()], pageFound: page.length > 0 };
}

function selectedRecord() {
  return targetRecords.find((record) => record.id === targetSelect.value)
    ?? targetRecords.find((record) => record.active)
    ?? targetRecords[0]
    ?? null;
}

function localAdapter(record) {
  return {
    ...record,
    list: async () => broker.list(),
    info: async (session) => {
      await broker.require(session);
      return {
        name: session,
        state: broker.pending?.has?.(session) ? "starting" : "running",
        active: studio.state.kernel === session,
        documents: [...(broker.documents?.values?.() ?? [])]
          .filter((document) => document.kernel === session),
      };
    },
    eval: (session, source) => broker.eval(session, source),
    create: async (session) => { await broker.create(session); await refreshTargets(); return session; },
    close: async (session) => { await broker.close(session); await refreshTargets(); return true; },
    complete: async () => [],
  };
}

function pageAdapter(record) {
  return {
    ...record,
    list: () => pageClient.list(record.brokerId),
    info: (session) => pageClient.info(record.brokerId, session),
    eval: (session, source, options = {}) => pageClient.eval({
      brokerId: record.brokerId,
      session,
      source,
      file: options.file,
      line: options.line ? Number(options.line) : undefined,
      column: options.column ? Number(options.column) : undefined,
    }),
    create: async (session) => { const value = await pageClient.create(record.brokerId, session); await refreshTargets(); return value; },
    close: async (session) => { const value = await pageClient.close(record.brokerId, session); await refreshTargets(); return value; },
    doc: (session, symbol) => pageClient.doc(record.brokerId, session, symbol),
    complete: (session, prefix) => pageClient.complete(record.brokerId, session, prefix),
  };
}

async function resolveTarget(environmentId = null) {
  if (!targetRecords.length) await refreshTargets();
  let record;
  if (environmentId) {
    record = targetRecords.find((entry) => entry.environmentId === environmentId && entry.active)
      ?? targetRecords.find((entry) => entry.environmentId === environmentId);
  } else {
    record = selectedRecord();
  }
  if (!record) return null;
  return record.kind === "page" ? pageAdapter(record) : localAdapter(record);
}

async function refreshTargets() {
  const generation = ++refreshGeneration;
  const previous = targetSelect.value;
  const { targets, pageFound } = await scanTargets();
  if (generation !== refreshGeneration) return;
  targetRecords = targets;
  targetSelect.replaceChildren(...targets.map((record) => {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${record.state === "starting" ? "◌" : record.active ? "●" : "₋"} ${record.label}`;
    return option;
  }));
  const preserved = targets.some((record) => record.id === previous) ? previous : null;
  const preferred = targets.find((record) => record.kind === "page" && record.active)
    ?? targets.find((record) => record.active)
    ?? targets[0];
  targetSelect.value = preserved ?? preferred?.id ?? "";
  const pageCount = targets.filter((record) => record.kind === "page").length;
  kernelStatus.textContent = pageFound
    ? `${pageCount} page kernel${pageCount === 1 ? "" : "s"} · offscreen local`
    : "offscreen local runtime";
}

async function evalSource(source, options = {}) {
  const target = await resolveTarget();
  if (!target) throw new Error("NO_TARGET_SELECTED");
  return target.eval(target.kernel, source, options);
}

function setRespState(state, label = state) {
  const normalized = state === "closed" ? "off" : state;
  readiness.resp = normalized;
  respStatus.dataset.state = normalized;
  respStatus.textContent = label;
  respButton.textContent = normalized === "connected" || normalized === "connecting" ? "disconnect RESP" : "connect RESP";
}

runtime.onStatus((value) => {
  if (value.instanceId && runtimeInstanceId && value.instanceId !== runtimeInstanceId) {
    location.reload();
    return;
  }
  if (value.instanceId) runtimeInstanceId = value.instanceId;
  runtimeState = value;
  readiness.kernel = value.runtimeState === "ready";
  readiness.resp = value.respState ?? "off";
  readiness.error = value.error ? value.error.message ?? String(value.error) : null;
  setRespState(value.respState ?? "off", value.respState === "connected" ? "RESP connected" : value.respState ?? "off");
  void refreshTargets();
});
runtime.onError((error) => { readiness.error = String(error?.message ?? error); });

async function connectBridge(url = respUrl.value) {
  respUrl.value = String(url ?? respUrl.value);
  setRespState("connecting");
  await runtime.connectResp(respUrl.value);
  return true;
}

async function disconnectBridge() {
  await runtime.disconnectResp();
  setRespState("off", "offline");
  return true;
}

respButton.addEventListener("click", () => {
  if (["connected", "connecting"].includes(runtimeState?.respState)) void disconnectBridge();
  else void connectBridge();
});
document.getElementById("kernel-refresh").addEventListener("click", refreshTargets);
targetSelect.addEventListener("change", () => {
  const target = selectedRecord();
  kernelStatus.textContent = target ? `${target.kind} · ${target.kernel}` : "no target";
});
globalThis.chrome?.devtools?.network?.onNavigated?.addListener(() => setTimeout(refreshTargets, 100));

let homeDir = null;
let homeSourcePaths = ["."];
const loadedResources = new Set([
  "chrome.api", "browser.dom", "browser.site.chatgpt", "browser.site.tripo",
  "studio.store", "studio.boot", "studio.node", "studio.draw", "studio.program", "studio.graph", "studio.session",
]);
const register = async (ns, text) => {
  const kernel = await broker.require(studio.state.kernel);
  return kernel.context.call("register-resource", [ns, text]);
};

async function preload(source) {
  if (!homeDir) return;
  await preloadRequires(source, { dir: homeDir, sourcePaths: homeSourcePaths, register, loaded: loadedResources });
}

const homeLabel = document.getElementById("home-label");
async function setHome(dir) {
  homeDir = dir;
  homeLabel.textContent = dir ? `home: ${dir.name}` : "no home";
  homeSourcePaths = ["."];
  if (dir) {
    for (const descriptor of ["project.edn", "project.hal"]) {
      try {
        const projectSource = await (await (await dir.getFileHandle(descriptor)).getFile()).text();
        homeSourcePaths = parseSourcePaths(projectSource);
        break;
      } catch { /* try migration fallback */ }
    }
  }
}

window.hara = {
  broker,
  studio,
  runtime,
  evalSource,
  evalLocalSource: (source) => broker.eval(studio.state.kernel, source),
  preload,
  setHome,
  tabId,
  pageClient,
  refreshTargets,
  targets: () => [...targetRecords],
  connectResp: connectBridge,
  disconnectResp: disconnectBridge,
  ready: readiness,
};

if (params.has("resp")) {
  respUrl.value = params.get("resp");
  await connectBridge(respUrl.value);
}

document.getElementById("home-button").addEventListener("click", async () => {
  try { setHome(await chooseHome()); } catch { /* picker cancelled */ }
});
document.getElementById("run-file-button").addEventListener("click", async () => {
  try {
    const [fileHandle] = await showOpenFilePicker({
      types: [{ description: "hara", accept: { "text/plain": [".hal"] } }],
    });
    const source = await (await fileHandle.getFile()).text();
    const target = selectedRecord();
    if (target?.kind === "local") await preload(source);
    studio.logNote(`hara=> ${fileHandle.name} [${target?.label ?? "target"}]`);
    studio.logValue(await evalSource(source, { file: fileHandle.name }));
  } catch (error) {
    if (error?.name !== "AbortError") studio.logError(error);
  }
});

window.addEventListener("beforeunload", () => { void runtime.close(); }, { once: true });

try {
  await setHome(await restoreHome());
  await broker.require(studio.state.kernel);
  readiness.kernel = true;
  await refreshTargets();
  setInterval(refreshTargets, 2000);
} catch (error) {
  readiness.error = String(error?.message ?? error);
  throw error;
}
