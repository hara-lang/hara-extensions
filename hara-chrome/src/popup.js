import { derivePopupView } from "./popup-model.js";
import { CONTROL_PORT } from "./runtime-protocol.js";

const port = chrome.runtime.connect({ name: CONTROL_PORT });
const pending = new Map();
const rowNames = ["binding", "runtime", "resp", "adapter", "dom", "downloads"];
let nextId = 1;
let busy = 0;
let snapshot = null;

const rows = Object.fromEntries(rowNames.map((name) => [name, {
  root: document.getElementById(`${name}-row`),
  lamp: document.getElementById(`${name}-lamp`),
  state: document.getElementById(`${name}-state`),
  detail: document.getElementById(`${name}-detail`),
  toggle: document.getElementById(`${name}-toggle`),
}]));

const elements = {
  panel: document.querySelector(".hara-runtime-compact"),
  globalStatus: document.getElementById("global-status"),
  globalLamp: document.getElementById("global-lamp"),
  globalLabel: document.getElementById("global-label"),
  targetLabel: document.getElementById("target-label"),
  targetTitle: document.getElementById("target-title"),
  adapterRow: document.getElementById("adapter-row"),
  adapterLabel: document.getElementById("adapter-label"),
  errorPanel: document.getElementById("error-panel"),
  errorCode: document.getElementById("error-code"),
  errorMessage: document.getElementById("error-message"),
  clearError: document.getElementById("clear-error"),
  openRepl: document.getElementById("open-repl"),
  reconnect: document.getElementById("reconnect"),
  disconnectAll: document.getElementById("disconnect-all"),
};

function actualVisualState(value) {
  if (["ready", "connected", "bound", "signed-in", "idle"].includes(value)) return "ready";
  if (value === "connecting") return "connecting";
  if (value === "stopping") return "stopping";
  if (["starting", "loading", "armed", "active"].includes(value)) return "starting";
  if (["signed-out", "authentication-required", "verification-required", "external-authentication"].includes(value)) return "attention";
  if (["error", "blocked"].includes(value)) return "error";
  if (["disabled", "unavailable"].includes(value)) return "disabled";
  return "off";
}

function globalVisualState(value) {
  if (value === "ok") return "ready";
  if (value === "busy") return "starting";
  if (value === "attention") return "attention";
  if (value === "error") return "error";
  return "off";
}

function setBusy(value) {
  busy = Math.max(0, busy + (value ? 1 : -1));
  document.body.dataset.busy = String(busy > 0);
  if (snapshot) render(snapshot);
}

function setRow(name, value) {
  const row = rows[name];
  const visualState = actualVisualState(value.state);
  if (row.root) {
    row.root.dataset.state = visualState;
    if (typeof value.desired === "boolean") row.root.dataset.desired = value.desired ? "on" : "off";
  }
  row.lamp.dataset.state = value.lamp;
  row.state.textContent = value.stateLabel;
  if (row.detail && value.detail !== undefined) row.detail.textContent = value.detail;
  if (!row.toggle) return;
  row.toggle.checked = value.desired === true;
  row.toggle.disabled = value.disabled === true || busy > 0;
  row.toggle.setAttribute("aria-description", `${value.stateLabel} actual state`);
}

function render(value) {
  snapshot = value;
  const view = derivePopupView(value);
  const visualState = globalVisualState(view.globalState);
  elements.panel.dataset.state = visualState;
  elements.globalStatus.dataset.state = visualState;
  elements.globalLamp.dataset.state = view.globalState;
  elements.globalLabel.textContent = view.globalLabel;
  elements.targetLabel.textContent = view.targetLabel;
  elements.targetTitle.textContent = view.targetTitle;
  elements.targetTitle.title = view.targetTitle;

  for (const name of rowNames) setRow(name, view.rows[name]);
  elements.adapterRow.hidden = view.rows.adapter.hidden;
  elements.adapterLabel.textContent = view.rows.adapter.label;
  elements.openRepl.disabled = view.actions.openReplDisabled || busy > 0;
  elements.reconnect.disabled = view.actions.reconnectDisabled || busy > 0;
  elements.disconnectAll.disabled = view.actions.disconnectDisabled || busy > 0;

  elements.errorPanel.hidden = !view.error;
  if (view.error) {
    elements.errorCode.textContent = view.error.code.toUpperCase();
    elements.errorMessage.textContent = view.error.message;
  }
  document.body.dataset.ready = "true";
}

function request(method, args = []) {
  const id = nextId++;
  setBusy(true);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, args });
  }).finally(() => setBusy(false));
}

port.onMessage.addListener((message) => {
  if (message?.event === "snapshot") {
    render(message.value);
    return;
  }
  const entry = pending.get(message?.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    if (message.value) render(message.value);
    entry.resolve(message.value);
    return;
  }
  const error = new Error(message.error ?? "control request failed");
  error.code = message.code ?? "control/error";
  entry.reject(error);
});

port.onDisconnect.addListener(() => {
  for (const entry of pending.values()) entry.reject(new Error("control supervisor disconnected"));
  pending.clear();
  render({
    ...snapshot,
    activity: {
      ...(snapshot?.activity ?? {}),
      lastError: {
        code: "control/disconnected",
        message: "Control supervisor disconnected",
      },
    },
    capabilities: snapshot?.capabilities ?? {},
  });
});

function bindToggle(id, method) {
  document.getElementById(id).addEventListener("change", async (event) => {
    try {
      await request(method, [event.currentTarget.checked]);
    } catch {
      await request("status").catch(() => {});
    }
  });
}

bindToggle("binding-toggle", "set-binding");
bindToggle("runtime-toggle", "set-runtime");
bindToggle("resp-toggle", "set-resp");
bindToggle("adapter-toggle", "set-adapter");

elements.openRepl.addEventListener("click", () => void request("open-repl").catch(() => {}));
elements.reconnect.addEventListener("click", () => void request("reconnect").catch(() => {}));
elements.disconnectAll.addEventListener("click", () => void request("disconnect-all").catch(() => {}));
elements.clearError.addEventListener("click", () => void request("clear-error").catch(() => {}));

void request("status").catch((error) => render({
  activity: {
    lastError: {
      code: error.code ?? "control/error",
      message: error.message,
    },
  },
  capabilities: {},
}));
