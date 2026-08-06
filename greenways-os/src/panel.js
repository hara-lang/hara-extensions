import { createBrowserBroker } from "../vendor/studio/broker.js";
import { createHostServices } from "../vendor/studio/host-services.js";
import { GraphHost } from "../vendor/studio/graph-host.js";
import { SessionRouter } from "../vendor/studio/session-router.js";
import { CapabilityRegistry } from "../vendor/studio/capability-registry.js";
import { createClockCapability } from "../vendor/studio/capabilities/clock.js";
import { mountStudio } from "../vendor/studio/ui.js";
import { createHostCalls, mergeHostCalls } from "./host-bridge.js";
import { preloadRequires, parseSourcePaths, chooseHome, restoreHome } from "./home.js";
import { createPageTargetClient, flattenPageTargets } from "./page-target.js";
import { connectResp, createBrowserRespHandler } from "./resp-client.js";

const params = new URLSearchParams(location.search);
const tabId = params.has("tabId")
  ? Number(params.get("tabId"))
  : globalThis.chrome?.devtools?.inspectedWindow?.tabId;

const asset = (path) => chrome.runtime.getURL(path);
async function fetchText(path) {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
  return response.text();
}

const port = chrome.runtime.connect({ name: "hara-host" });
const sessionRouter = new SessionRouter();
const capabilityRegistry = new CapabilityRegistry({ adapters: {
  "clock/frame": createClockCapability(),
} });
const graphHost = new GraphHost({
  workerUrl: asset("vendor/studio/program-worker.js"),
  sessionRouter,
  capabilityRegistry,
});
const hostCalls = mergeHostCalls(createHostServices({
  graphHost,
  graphHostOptions: { sessionRouter },
}), createHostCalls(port));

const moduleBytes = new Uint8Array(
  await (await fetch(asset("vendor/hara.wasm"))).arrayBuffer(),
);

const resources = { "chrome.api": await fetchText("src/hara/api.hal") };
for (const name of ["store", "boot", "node", "draw", "program", "graph", "session"]) {
  resources[`studio.${name}`] = await fetchText(`vendor/studio/hal/${name}.hal`);
}

const broker = createBrowserBroker({
  workerUrl: asset("vendor/hta-worker.js"),
  moduleBytes,
  hostCalls,
  resources,
  onKernelStarting: async (kernel) => {
    const mount = await kernel.context.createFilesystem({ provider: "indexeddb", key: "hara-chrome" });
    await kernel.context.session().attachFilesystem(mount);
  },
  onKernelCreated: async (kernel) => sessionRouter.register(kernel.name, kernel.context, {
    onRelease: (sessionId) => graphHost.releaseSession(sessionId),
  }),
  onKernelClosed: (kernel) => sessionRouter.unregister(kernel.name),
});
const studio = mountStudio(document.getElementById("hara-studio-mount"), { broker });
const inspectedWindow = globalThis.chrome?.devtools?.inspectedWindow;
const unavailablePageClient = new Proxy({}, {
  get: () => async () => { throw new Error("HARA_NOT_FOUND"); },
});
const pageClient = inspectedWindow ? createPageTargetClient(inspectedWindow) : unavailablePageClient;

const targetSelect = document.getElementById("kernel-target");
const kernelStatus = document.getElementById("kernel-status");
const respUrl = document.getElementById("resp-url");
const respButton = document.getElementById("resp-connect");
const respStatus = document.getElementById("resp-status");
let targetRecords = [];
let respSocket = null;
let refreshGeneration = 0;

function localRecords() {
  return broker.list().map((kernel) => ({
    id: `local:${kernel}`,
    environmentId: "local",
    environmentLabel: "DevTools Local",
    kind: "local",
    kernel,
    label: `DevTools Local · ${kernel}`,
    state: broker.pending?.has?.(kernel) ? "starting" : "running",
    active: studio.state.kernel === kernel,
  }));
}

async function scanTargets() {
  const local = localRecords();
  try {
    const description = await pageClient.describe();
    const page = flattenPageTargets(description).map((record) => ({
      ...record,
      environmentLabel: description?.brokers?.find((entry) => entry.id === record.brokerId)?.label
        ?? description?.page?.title
        ?? "Inspected page",
    }));
    return { targets: [...page, ...local], pageFound: page.length > 0, description };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/HARA_NOT_FOUND|HARA_PAGE_RELOADED/.test(message)) console.debug("[hara devtools] page scan", error);
    return { targets: local, pageFound: false, description: null };
  }
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
          .filter((document) => document.kernel === session)
          .map((document) => ({
            documentId: document.documentId,
            generation: document.generation,
            moduleId: document.moduleId,
          })),
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
    option.textContent = `${record.state === "starting" ? "◌" : record.active ? "●" : "○"} ${record.label}`;
    return option;
  }));
  const preserved = targets.some((record) => record.id === previous) ? previous : null;
  const preferred = targets.find((record) => record.kind === "page" && record.active)
    ?? targets.find((record) => record.active)
    ?? targets[0];
  targetSelect.value = preserved ?? preferred?.id ?? "";
  const pageCount = targets.filter((record) => record.kind === "page").length;
  kernelStatus.textContent = pageFound
    ? `${pageCount} page kernel${pageCount === 1 ? "" : "s"}`
    : "no page registry · local kernel only";
}

async function evalSource(source, options = {}) {
  const target = await resolveTarget();
  if (!target) throw new Error("NO_TARGET_SELECTED");
  return target.eval(target.kernel, source, options);
}

const respHandler = createBrowserRespHandler({
  listTargets: async () => {
    await refreshTargets();
    return targetRecords;
  },
  resolveTarget,
});

function setRespState(state, label = state) {
  respStatus.dataset.state = state;
  respStatus.textContent = label;
  respButton.textContent = state === "connected" || state === "connecting" ? "disconnect RESP" : "connect RESP";
}

function connectBridge(url = respUrl.value) {
  respSocket?.close();
  setRespState("connecting");
  respSocket = connectResp(url, respHandler, {
    onStatus: (state) => setRespState(state, state === "connected" ? "RESP connected" : state),
  });
  return respSocket;
}

respButton.addEventListener("click", () => {
  if (respSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(respSocket.readyState)) {
    respSocket.close();
    respSocket = null;
    setRespState("closed", "offline");
  } else {
    connectBridge();
  }
});
document.getElementById("kernel-refresh").addEventListener("click", refreshTargets);
targetSelect.addEventListener("change", () => {
  const target = selectedRecord();
  kernelStatus.textContent = target ? `${target.kind} · ${target.kernel}` : "no target";
});
globalThis.chrome?.devtools?.network?.onNavigated?.addListener(() => setTimeout(refreshTargets, 100));

let homeDir = null;
let homeSourcePaths = ["."];
const loadedResources = new Set(Object.keys(resources));
const register = async (ns, text) => {
  const kernel = await broker.require(studio.state.kernel);
  return kernel.context.call("register-resource", [ns, text]);
};

async function preload(source) {
  if (!homeDir) return;
  await preloadRequires(source, {
    dir: homeDir,
    sourcePaths: homeSourcePaths,
    register,
    loaded: loadedResources,
  });
}

const homeLabel = document.getElementById("home-label");
async function setHome(dir) {
  homeDir = dir;
  homeLabel.textContent = dir ? `home: ${dir.name}` : "no home";
  homeSourcePaths = ["."];
  if (dir) {
    for (const descriptor of ["project.edn", "project.hal"]) {
      try {
        const projectSource = await (
          await (await dir.getFileHandle(descriptor)).getFile()
        ).text();
        homeSourcePaths = parseSourcePaths(projectSource);
        break;
      } catch { /* try the migration fallback */ }
    }
  }
}

window.hara = {
  broker,
  studio,
  evalSource,
  evalLocalSource: (source) => broker.eval(studio.state.kernel, source),
  preload,
  setHome,
  tabId,
  pageClient,
  refreshTargets,
  targets: () => [...targetRecords],
  connectResp: connectBridge,
};

if (params.has("resp")) {
  respUrl.value = params.get("resp");
  connectBridge(respUrl.value);
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

setHome(await restoreHome());
await refreshTargets();
setInterval(refreshTargets, 2000);
