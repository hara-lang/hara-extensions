import { BrowserWasmSandbox } from "../vendor/packages/hta/sandbox.js";
import {
  REMOTE_LANGUAGE_HOST_STORAGE_KEY,
  createRemoteLanguageHostController,
} from "./remote-language-host-core.js";

const asset = (path) => chrome.runtime.getURL(path);
let lastStatus = null;

async function loadModuleBytes() {
  const response = await fetch(asset("vendor/hara.wasm"), {
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`remote/runtime-fetch-failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const controller = createRemoteLanguageHostController({
  storageArea: chrome.storage.local,
  storageEvents: chrome.storage.onChanged,
  loadModuleBytes,
  createSandbox: ({ moduleBytes }) => new BrowserWasmSandbox({
    workerUrl: asset("vendor/hta-worker.js"),
    moduleBytes,
  }),
  onStatus: (status) => {
    lastStatus = status;
  },
});

void controller.start().catch((error) => {
  console.warn("[hara language host] startup failed", error?.code ?? "remote/unavailable");
});

addEventListener("pagehide", () => {
  void controller.close();
}, { once: true });

// Extension-only diagnostics. No pairing token or source content is projected.
globalThis.haraRemoteLanguageHost = Object.freeze({
  protocol: "hara.remote-language-host/0-alpha",
  storageKey: REMOTE_LANGUAGE_HOST_STORAGE_KEY,
  status: () => controller.status(),
  refresh: () => controller.refresh(),
  close: () => controller.close(),
  lastStatus: () => lastStatus,
});
