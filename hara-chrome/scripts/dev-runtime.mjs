import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startBridge } from "../bridge/resp-bridge.mjs";
import { launchExtensionRuntime } from "./browser-runtime.mjs";
import { verifyHaraResp } from "./resp-client.mjs";

function numericPort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

export function booleanSetting(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  switch (String(value).trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`invalid boolean setting: ${value}`);
  }
}

export async function startDevelopmentRuntime({
  respPort = numericPort(process.env.RESP_PORT, 7355),
  wsPort = numericPort(process.env.WS_PORT, 7356),
  profileDir = process.env.PROFILE_DIR || null,
  url = process.env.URL || "about:blank",
  headless = booleanSetting(process.env.HEADLESS, true),
  token = randomBytes(32).toString("base64url"),
  log = (line) => console.log(line),
  startBridgeImpl = startBridge,
  launchExtensionImpl = launchExtensionRuntime,
  verifyRespImpl = verifyHaraResp,
} = {}) {
  let bridge = null;
  let browser = null;
  let closePromise = null;

  const close = () => {
    closePromise ??= (async () => {
      const failures = [];
      try { await browser?.close(); } catch (error) { failures.push(error); }
      try { await bridge?.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "hara-chrome runtime shutdown failed");
    })();
    return closePromise;
  };

  try {
    bridge = await startBridgeImpl({ respPort, wsPort, token });
    const respAddress = `127.0.0.1:${bridge.respPort}`;
    const wsUrl = `ws://127.0.0.1:${bridge.wsPort}/?token=${encodeURIComponent(token)}`;
    browser = await launchExtensionImpl({ profileDir, url, headless });
    if (!Number.isInteger(browser.tabId) || browser.tabId <= 0) {
      throw new Error(`browser target did not resolve an exact Chrome tab ID: ${browser.tabId}`);
    }
    const panel = await browser.openPanel({ tabId: browser.tabId, respUrl: wsUrl });
    const readiness = await verifyRespImpl({
      host: "127.0.0.1",
      port: bridge.respPort,
      tabId: browser.tabId,
    });
    log(`HARA TARGET ${browser.targetUrl} TAB ${browser.tabId}`);
    log(`HARA RESP ${respAddress}`);
    return {
      bridge,
      browser,
      panel,
      readiness,
      target: { tabId: browser.tabId, url: browser.targetUrl },
      close,
    };
  } catch (error) {
    try { await close(); } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], "hara-chrome startup and cleanup failed");
    }
    throw error;
  }
}

async function main() {
  let runtime = null;
  let exitCode = 0;
  let stopped = false;
  let resolveStop;
  const stop = new Promise((resolve) => { resolveStop = resolve; });
  const requestStop = (code = 0) => {
    if (stopped) return;
    stopped = true;
    exitCode = code;
    resolveStop();
  };
  const signalHandlers = new Map([
    ["SIGINT", () => requestStop(0)],
    ["SIGTERM", () => requestStop(0)],
  ]);
  for (const [signal, handler] of signalHandlers) process.once(signal, handler);

  try {
    runtime = await startDevelopmentRuntime();
    runtime.browser.closed.then(() => requestStop(stopped ? exitCode : 1));
    await stop;
  } catch (error) {
    exitCode = 1;
    console.error(error?.stack ?? error);
  } finally {
    stopped = true;
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    try {
      await runtime?.close();
      console.log("HARA STOPPED");
    } catch (error) {
      exitCode = 1;
      console.error(error?.stack ?? error);
    }
    process.exitCode = exitCode;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
