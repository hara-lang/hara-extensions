import {
  CONTROL_PREFERENCES_KEY,
  CONTROL_PROTOCOL,
  CONTROL_SESSION_KEY,
  DEFAULT_CONTROL_PREFERENCES,
  badgeForSnapshot,
  classifyTab,
  initialSession,
  normalizePreferences,
  normalizeSession,
  publicTab,
  requireBindableTab,
  titleForSnapshot,
} from "./control-model.js";
import { CONTROL_PORT, serializeError } from "./runtime-protocol.js";

function storageGet(area, key) {
  return area?.get ? area.get(key) : Promise.resolve({});
}

function storageSet(area, value) {
  return area?.set ? area.set(value) : Promise.resolve();
}

export function createControlSupervisor({
  chromeApi,
  runtimeSupervisor,
  probeContext = async () => ({ adapterState: "unavailable", authentication: null }),
  downloadStatus = () => "idle",
  now = () => Date.now(),
} = {}) {
  if (!chromeApi?.tabs || !chromeApi?.runtime || !chromeApi?.storage || !chromeApi?.action) {
    throw new TypeError("createControlSupervisor requires tabs, runtime, storage, and action APIs");
  }
  if (!runtimeSupervisor) throw new TypeError("createControlSupervisor requires a runtime supervisor");

  let started = false;
  let closed = false;
  let preferences = { ...DEFAULT_CONTROL_PREFERENCES };
  let session = initialSession(now);
  let activeTab = null;
  let runtimeStatus = runtimeSupervisor.status();
  let contextual = { adapterState: "none", authentication: null };
  let sequence = Promise.resolve();
  const ports = new Set();
  const removeListeners = [];
  let removeRuntimeListener = () => {};

  const run = (operation) => {
    const next = sequence.then(operation, operation);
    sequence = next.catch(() => {});
    return next;
  };

  function post(port, value) {
    try { port.postMessage(value); } catch { /* popup closed */ }
  }

  async function queryActiveTab() {
    const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] ?? null;
  }

  async function readTab(tabId) {
    if (!tabId) return null;
    try { return await chromeApi.tabs.get(tabId); } catch { return null; }
  }

  function safePanelUrl(rawValue) {
    try {
      const value = new URL(String(rawValue ?? ""));
      return value.origin === new URL(chromeApi.runtime.getURL("/")).origin
        && value.pathname.endsWith("/src/panel.html")
        ? value
        : null;
    } catch {
      return null;
    }
  }

  async function persist() {
    await storageSet(chromeApi.storage.session, { [CONTROL_SESSION_KEY]: session });
  }

  async function updateAction(snapshot) {
    await chromeApi.action.setBadgeText({ text: badgeForSnapshot(snapshot) });
    await chromeApi.action.setTitle({ title: titleForSnapshot(snapshot) });
  }

  function adapterKind(boundTab) {
    return boundTab?.adapter ?? "none";
  }

  async function buildSnapshot({ probe = false } = {}) {
    activeTab = await queryActiveTab();
    let boundTab = await readTab(session.boundTabId);
    if (session.boundTabId && !boundTab) {
      try {
        runtimeStatus = (await runtimeSupervisor.stop({ closeDocument: true }))?.status
          ?? runtimeSupervisor.status();
      } catch (error) {
        recordError(error);
        runtimeStatus = runtimeSupervisor.status();
      }
      session.bindingDesired = false;
      session.boundTabId = null;
      session.boundWindowId = null;
      session.boundUrl = null;
      session.boundTitle = null;
      session.runtimeDesired = false;
      session.respDesired = false;
      session.adapterDesired = false;
      session.replTabId = null;
      contextual = { adapterState: "none", authentication: null };
      await persist();
    }
    const classifiedBound = boundTab ? classifyTab(boundTab) : null;
    if (probe && classifiedBound?.adapter !== "none" && session.adapterDesired && runtimeStatus.runtimeState === "ready") {
      try {
        contextual = await probeContext(classifiedBound);
      } catch (error) {
        contextual = { adapterState: "error", authentication: null };
        session.lastError = {
          code: error?.code ?? "control/context-probe-failed",
          message: String(error?.message ?? error),
          at: now(),
        };
      }
    } else if (!classifiedBound || classifiedBound.adapter === "none") {
      contextual = { adapterState: "none", authentication: null };
    } else if (!session.adapterDesired) {
      contextual = { adapterState: "disabled", authentication: null };
    } else if (runtimeStatus.runtimeState !== "ready") {
      contextual = { adapterState: "unavailable", authentication: null };
    }

    const snapshot = {
      protocol: CONTROL_PROTOCOL,
      revision: session.revision,
      activeTab: publicTab(activeTab),
      boundTab: publicTab(boundTab),
      binding: {
        desired: session.bindingDesired,
        state: session.bindingDesired && boundTab ? "bound" : "off",
      },
      runtime: {
        desired: session.runtimeDesired,
        state: runtimeStatus.runtimeState ?? "off",
        host: runtimeStatus.runtimeState === "off" ? null : "offscreen",
        kernel: runtimeStatus.kernel ?? null,
        kernels: runtimeStatus.kernels ?? [],
      },
      resp: {
        desired: session.respDesired,
        state: runtimeStatus.respState ?? "off",
        url: preferences.respUrl,
      },
      adapter: {
        kind: adapterKind(classifiedBound),
        desired: session.adapterDesired,
        state: contextual.adapterState ?? "unavailable",
        authentication: contextual.authentication ?? null,
      },
      dom: {
        state: runtimeStatus.runtimeState === "ready" && boundTab ? "ready" : "off",
      },
      downloads: {
        state: downloadStatus() ?? "idle",
      },
      activity: {
        lastError: session.lastError ?? runtimeStatus.error ?? null,
        updatedAt: session.updatedAt,
      },
      capabilities: {
        canBind: classifyTab(activeTab).bindable,
        canRuntime: Boolean(boundTab || classifyTab(activeTab).bindable),
        canResp: Boolean(boundTab || classifyTab(activeTab).bindable),
        canAdapter: Boolean(classifiedBound && classifiedBound.adapter !== "none"),
      },
    };
    await updateAction(snapshot);
    return snapshot;
  }

  async function publish(options = {}) {
    session.revision += 1;
    session.updatedAt = now();
    await persist();
    const snapshot = await buildSnapshot(options);
    for (const port of ports) post(port, { event: "snapshot", value: snapshot });
    return snapshot;
  }

  function recordError(error) {
    session.lastError = {
      code: error?.code ?? "control/error",
      message: String(error?.message ?? error),
      at: now(),
    };
  }

  async function bindActiveTab() {
    const tab = requireBindableTab(await queryActiveTab());
    if (session.boundTabId && session.boundTabId !== tab.id) {
      await runtimeSupervisor.disconnectResp().catch(() => {});
      await runtimeSupervisor.stop({ closeDocument: true }).catch(() => {});
    }
    session.controlled = true;
    session.bindingDesired = true;
    session.boundTabId = tab.id;
    session.boundWindowId = tab.windowId;
    session.boundUrl = tab.url;
    session.boundTitle = tab.title;
    session.adapterDesired = preferences.adapterDefaultEnabled;
    session.lastError = null;
    if (runtimeStatus.runtimeState !== "off") await runtimeSupervisor.bindTarget(tab.id);
    return publish({ probe: true });
  }

  async function unbind() {
    session.controlled = true;
    session.bindingDesired = false;
    session.runtimeDesired = false;
    session.respDesired = false;
    session.adapterDesired = false;
    await runtimeSupervisor.stop({ closeDocument: true }).catch(() => {});
    session.boundTabId = null;
    session.boundWindowId = null;
    session.boundUrl = null;
    session.boundTitle = null;
    session.replTabId = null;
    contextual = { adapterState: "none", authentication: null };
    return publish();
  }

  async function ensureBound() {
    if (session.boundTabId && await readTab(session.boundTabId)) return session.boundTabId;
    await bindActiveTab();
    return session.boundTabId;
  }

  async function setRuntime(value) {
    session.controlled = true;
    session.runtimeDesired = value === true;
    session.lastError = null;
    if (session.runtimeDesired) {
      const tabId = await ensureBound();
      runtimeStatus = (await runtimeSupervisor.start(tabId))?.status ?? runtimeSupervisor.status();
    } else {
      session.respDesired = false;
      runtimeStatus = (await runtimeSupervisor.stop({ closeDocument: true }))?.status ?? runtimeSupervisor.status();
    }
    return publish({ probe: session.runtimeDesired });
  }

  async function setResp(value) {
    session.controlled = true;
    session.respDesired = value === true;
    session.lastError = null;
    if (session.respDesired) {
      const tabId = await ensureBound();
      session.runtimeDesired = true;
      await runtimeSupervisor.start(tabId);
      runtimeStatus = (await runtimeSupervisor.connectResp(preferences.respUrl))?.status ?? runtimeSupervisor.status();
    } else {
      runtimeStatus = (await runtimeSupervisor.disconnectResp())?.status ?? runtimeSupervisor.status();
    }
    return publish({ probe: session.runtimeDesired });
  }

  async function setAdapter(value) {
    session.controlled = true;
    session.adapterDesired = value === true;
    session.lastError = null;
    return publish({ probe: session.adapterDesired });
  }

  async function findReplTab() {
    if (session.replTabId) {
      const existing = await readTab(session.replTabId);
      if (existing) return existing;
      session.replTabId = null;
    }
    const prefix = chromeApi.runtime.getURL("src/panel.html");
    const tabs = await chromeApi.tabs.query({ url: `${prefix}*` }).catch(() => []);
    return tabs.find((tab) => {
      const parsed = new URL(tab.url);
      return Number(parsed.searchParams.get("tabId")) === session.boundTabId;
    }) ?? null;
  }

  async function focusTab(tab) {
    await chromeApi.tabs.update(tab.id, { active: true });
    if (tab.windowId != null && chromeApi.windows?.update) {
      try { await chromeApi.windows.update(tab.windowId, { focused: true }); } catch { /* best effort */ }
    }
  }

  async function openRepl() {
    const tabId = await ensureBound();
    session.runtimeDesired = true;
    await runtimeSupervisor.start(tabId);
    let tab = await findReplTab();
    if (!tab) {
      const url = new URL(chromeApi.runtime.getURL("src/panel.html"));
      url.searchParams.set("tabId", String(tabId));
      url.searchParams.set("control", "popup");
      tab = await chromeApi.tabs.create({ url: url.href, active: true });
    } else {
      await focusTab(tab);
    }
    session.replTabId = tab.id;
    return publish({ probe: true });
  }

  async function reconnect() {
    const tabId = await ensureBound();
    session.runtimeDesired = true;
    session.lastError = null;
    await runtimeSupervisor.start(tabId);
    if (session.respDesired) await runtimeSupervisor.connectResp(preferences.respUrl);
    else await runtimeSupervisor.bindTarget(tabId);
    return publish({ probe: true });
  }

  async function disconnectAll() {
    session.controlled = true;
    session.bindingDesired = false;
    session.runtimeDesired = false;
    session.respDesired = false;
    session.adapterDesired = false;
    session.lastError = null;
    await runtimeSupervisor.stop({ closeDocument: true }).catch(() => {});
    const replTabId = session.replTabId;
    session.boundTabId = null;
    session.boundWindowId = null;
    session.boundUrl = null;
    session.boundTitle = null;
    session.replTabId = null;
    if (replTabId) {
      const replTab = await readTab(replTabId);
      const replUrl = replTab ? safePanelUrl(replTab.url) : null;
      if (replUrl?.searchParams.get("control") === "popup") {
        try { await chromeApi.tabs.remove(replTabId); } catch { /* already closed */ }
      }
    }
    contextual = { adapterState: "none", authentication: null };
    return publish();
  }

  async function dispatch(method, args = []) {
    return run(async () => {
      if (!started) await start();
      try {
        switch (method) {
          case "status": return publish({ probe: true });
          case "set-binding": return args[0] === true ? bindActiveTab() : unbind();
          case "set-runtime": return setRuntime(args[0]);
          case "set-resp": return setResp(args[0]);
          case "set-adapter": return setAdapter(args[0]);
          case "open-repl": return openRepl();
          case "reconnect": return reconnect();
          case "disconnect-all": return disconnectAll();
          case "clear-error":
            session.lastError = null;
            return publish({ probe: true });
          default: {
            const error = new Error(`control/operation-unsupported: unsupported control operation ${method}`);
            error.code = "control/operation-unsupported";
            throw error;
          }
        }
      } catch (error) {
        recordError(error);
        await publish();
        throw error;
      }
    });
  }

  function connectPort(port) {
    ports.add(port);
    const onMessage = async (message = {}) => {
      const id = message.id ?? null;
      try {
        const value = await dispatch(message.method, message.args ?? []);
        post(port, { id, ok: true, value });
      } catch (error) {
        post(port, { id, ok: false, ...serializeError(error) });
      }
    };
    const onDisconnect = () => {
      ports.delete(port);
      port.onMessage?.removeListener?.(onMessage);
    };
    port.onMessage?.addListener?.(onMessage);
    port.onDisconnect?.addListener?.(onDisconnect);
    void dispatch("status").then((value) => post(port, { event: "snapshot", value })).catch(() => {});
  }

  async function tabAllowed(tabId) {
    if (!started) await start();
    if (!session.controlled) return true;
    return session.bindingDesired && session.boundTabId === Number(tabId);
  }

  async function adapterAllowed(tabId, kind) {
    if (!await tabAllowed(tabId)) return false;
    if (!session.controlled) return true;
    const tab = await readTab(session.boundTabId);
    return session.adapterDesired && classifyTab(tab).adapter === kind;
  }


  async function adoptUncontrolledRuntime(value) {
    if (session.controlled || value?.runtimeState === "off" || !value?.targetTabId) return;
    const tab = await readTab(value.targetTabId);
    const classified = classifyTab(tab);
    if (!classified.bindable) return;
    session.bindingDesired = true;
    session.boundTabId = classified.id;
    session.boundWindowId = classified.windowId;
    session.boundUrl = classified.url;
    session.boundTitle = classified.title;
    session.runtimeDesired = true;
    session.respDesired = ["connecting", "connected"].includes(value.respState);
    session.adapterDesired = preferences.adapterDefaultEnabled;
  }

  async function start() {
    if (started) return buildSnapshot();
    const [local, transient] = await Promise.all([
      storageGet(chromeApi.storage.local, CONTROL_PREFERENCES_KEY),
      storageGet(chromeApi.storage.session, CONTROL_SESSION_KEY),
    ]);
    preferences = normalizePreferences(local?.[CONTROL_PREFERENCES_KEY]);
    session = normalizeSession(transient?.[CONTROL_SESSION_KEY], now);
    runtimeStatus = runtimeSupervisor.status();
    started = true;

    removeRuntimeListener = runtimeSupervisor.onStatus((value) => {
      runtimeStatus = value;
      if (started) void run(async () => {
        await adoptUncontrolledRuntime(value);
        return publish({ probe: false });
      });
    });

    const onActivated = () => { if (ports.size > 0) void dispatch("status"); };
    const onUpdated = (tabId, changeInfo) => {
      if ((tabId === session.boundTabId || tabId === activeTab?.id) && (changeInfo.url || changeInfo.status === "complete")) {
        void dispatch("status");
      }
    };
    const onRemoved = (tabId) => {
      if (tabId === session.boundTabId || tabId === session.replTabId) void dispatch("status");
    };
    chromeApi.tabs.onActivated?.addListener?.(onActivated);
    chromeApi.tabs.onUpdated?.addListener?.(onUpdated);
    chromeApi.tabs.onRemoved?.addListener?.(onRemoved);
    removeListeners.push(
      () => chromeApi.tabs.onActivated?.removeListener?.(onActivated),
      () => chromeApi.tabs.onUpdated?.removeListener?.(onUpdated),
      () => chromeApi.tabs.onRemoved?.removeListener?.(onRemoved),
    );

    if (session.runtimeDesired && session.boundTabId && await readTab(session.boundTabId)) {
      try {
        await runtimeSupervisor.start(session.boundTabId);
        if (session.respDesired) await runtimeSupervisor.connectResp(preferences.respUrl);
      } catch (error) {
        recordError(error);
      }
    }
    return publish({ probe: session.runtimeDesired });
  }

  async function close() {
    if (closed) return true;
    closed = true;
    removeRuntimeListener();
    for (const remove of removeListeners.splice(0)) remove();
    for (const port of ports) {
      try { port.disconnect(); } catch { /* already closed */ }
    }
    ports.clear();
    return true;
  }

  return {
    start,
    close,
    dispatch,
    connectPort,
    tabAllowed,
    adapterAllowed,
    status: () => buildSnapshot(),
    portName: CONTROL_PORT,
    _state: () => ({ preferences, session: { ...session }, runtimeStatus, ports: new Set(ports) }),
  };
}
