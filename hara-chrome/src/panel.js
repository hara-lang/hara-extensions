import { createBrowserBroker } from "../vendor/studio/broker.js";
import { createHostServices } from "../vendor/studio/host-services.js";
import { GraphHost } from "../vendor/studio/graph-host.js";
import { SessionRouter } from "../vendor/studio/session-router.js";
import { CapabilityRegistry } from "../vendor/studio/capability-registry.js";
import { createClockCapability } from "../vendor/studio/capabilities/clock.js";
import { mountStudio } from "../vendor/studio/ui.js";
import { createHostCalls, mergeHostCalls } from "./host-bridge.js";
import { preloadRequires, parseSourcePaths, chooseHome, restoreHome } from "./home.js";
import { connectResp } from "./resp-client.js";

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

// Host calls: the studio services (store/http/json, answered in-panel) own
// their keys; every other service/method (chrome.*, hara/echo) falls through
// to the background service worker over the port.
const port = chrome.runtime.connect({ name: "hara-host" });
const sessionRouter = new SessionRouter();
const capabilityRegistry = new CapabilityRegistry({ adapters: {
  "clock/frame": createClockCapability()
} });
const graphHost = new GraphHost({
  workerUrl: asset("vendor/studio/program-worker.js"),
  sessionRouter, capabilityRegistry
});
const hostCalls = mergeHostCalls(createHostServices({
  graphHost,
  graphHostOptions: { sessionRouter }
}), createHostCalls(port));

const moduleBytes = new Uint8Array(
  await (await fetch(asset("vendor/hara.wasm"))).arrayBuffer(),
);

// Registered into every kernel at boot: the studio hal libs plus the
// chrome.api bindings.
const resources = { "chrome.api": await fetchText("src/hara/api.hal") };
for (const name of ["store", "fs", "space", "boot", "node", "draw", "program", "graph", "session"]) {
  resources[`studio.${name}`] = await fetchText(`vendor/studio/hal/${name}.hal`);
}

const broker = createBrowserBroker({
  workerUrl: asset("vendor/hta-worker.js"),
  moduleBytes,
  hostCalls,
  resources,
  onKernelCreated: async (kernel) => sessionRouter.register(kernel.name, kernel.context, {
    onRelease: (sessionId) => graphHost.releaseSession(sessionId)
  }),
  onKernelClosed: (kernel) => sessionRouter.unregister(kernel.name)
});
const studio = mountStudio(document.getElementById("hara-studio-mount"), { broker });

function evalSource(source) {
  return broker.eval(studio.state.kernel, source);
}

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

window.hara = { broker, studio, evalSource, preload, setHome, tabId };

if (params.has("resp")) connectResp(params.get("resp"), evalSource);

document.getElementById("home-button").addEventListener("click", async () => {
  try { setHome(await chooseHome()); } catch { /* picker cancelled */ }
});
document.getElementById("run-file-button").addEventListener("click", async () => {
  try {
    const [fileHandle] = await showOpenFilePicker({
      types: [{ description: "hara", accept: { "text/plain": [".hal"] } }],
    });
    const source = await (await fileHandle.getFile()).text();
    await preload(source);
    studio.logNote(`hara=> ${fileHandle.name}`);
    studio.logValue(await evalSource(source));
  } catch (error) {
    if (error?.name !== "AbortError") studio.logError(error);
  }
});
setHome(await restoreHome());
