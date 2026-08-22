import { launchExtensionRuntime } from "../scripts/browser-runtime.mjs";

export async function launchWithExtension(options = {}) {
  return launchExtensionRuntime(options);
}

export async function activeTabId(serviceWorker) {
  return serviceWorker.evaluate(
    async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  );
}
