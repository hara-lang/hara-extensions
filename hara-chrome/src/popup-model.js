const AUTH_LABELS = Object.freeze({
  "signed-in": "SIGNED IN",
  "signed-out": "SIGNED OUT",
  "authentication-required": "LOGIN REQUIRED",
  "verification-required": "VERIFY",
  "external-authentication": "PROVIDER LOGIN",
  loading: "LOADING",
});

const STATE_LABELS = Object.freeze({
  off: "OFF",
  bound: "BOUND",
  starting: "STARTING",
  ready: "READY",
  stopping: "STOPPING",
  connecting: "CONNECTING",
  connected: "CONNECTED",
  error: "ERROR",
  unavailable: "UNAVAILABLE",
  disabled: "DISABLED",
  none: "NONE",
  idle: "IDLE",
  armed: "ARMED",
  active: "ACTIVE",
  blocked: "BLOCKED",
});

function stateLabel(value) {
  return AUTH_LABELS[value] ?? STATE_LABELS[value] ?? String(value ?? "UNKNOWN").toUpperCase();
}

function lamp(value) {
  if (["ready", "connected", "bound", "signed-in", "idle"].includes(value)) return "ok";
  if (["starting", "stopping", "connecting", "loading", "armed", "active"].includes(value)) return "busy";
  if (["error", "blocked"].includes(value)) return "error";
  if (["signed-out", "authentication-required", "verification-required", "external-authentication"].includes(value)) return "attention";
  return "off";
}

function adapterLabel(kind) {
  if (kind === "chatgpt") return "ChatGPT adapter";
  if (kind === "tripo") return "Tripo Studio adapter";
  return "Context adapter";
}

function targetLabel(tab) {
  if (!tab) return "NO TARGET";
  return `${tab.hostname || tab.kind || "TAB"} · TAB ${tab.id ?? "—"}`;
}

export function derivePopupView(snapshot = {}) {
  const target = snapshot.boundTab ?? snapshot.activeTab ?? null;
  const authentication = snapshot.adapter?.authentication;
  const adapterState = authentication ?? snapshot.adapter?.state ?? "none";
  const error = snapshot.activity?.lastError ?? null;
  let globalState = "off";
  let globalLabel = "OFFLINE";
  if (error) {
    globalState = "error";
    globalLabel = "ERROR";
  } else if (["signed-out", "authentication-required", "verification-required", "external-authentication"].includes(authentication)) {
    globalState = "attention";
    globalLabel = "ATTENTION";
  } else if (["starting", "stopping"].includes(snapshot.runtime?.state) || snapshot.resp?.state === "connecting") {
    globalState = "busy";
    globalLabel = "CONNECTING";
  } else if (snapshot.runtime?.state === "ready" && snapshot.binding?.state === "bound") {
    globalState = "ok";
    globalLabel = "READY";
  } else if (snapshot.binding?.state === "bound") {
    globalState = "ok";
    globalLabel = "BOUND";
  }

  return {
    globalState,
    globalLabel,
    targetLabel: targetLabel(target),
    targetTitle: target?.title || target?.url || "No active browser target",
    rows: {
      binding: {
        label: "Current tab",
        desired: snapshot.binding?.desired === true,
        state: snapshot.binding?.state ?? "off",
        stateLabel: stateLabel(snapshot.binding?.state ?? "off"),
        lamp: lamp(snapshot.binding?.state ?? "off"),
        disabled: snapshot.binding?.desired !== true && snapshot.capabilities?.canBind !== true,
      },
      runtime: {
        label: "Hara runtime",
        desired: snapshot.runtime?.desired === true,
        state: snapshot.runtime?.state ?? "off",
        stateLabel: stateLabel(snapshot.runtime?.state ?? "off"),
        lamp: lamp(snapshot.runtime?.state ?? "off"),
        detail: snapshot.runtime?.host === "offscreen" ? "OFFSCREEN HOST" : "",
        disabled: snapshot.capabilities?.canRuntime !== true,
      },
      resp: {
        label: "RESP",
        desired: snapshot.resp?.desired === true,
        state: snapshot.resp?.state ?? "off",
        stateLabel: stateLabel(snapshot.resp?.state ?? "off"),
        lamp: lamp(snapshot.resp?.state ?? "off"),
        detail: snapshot.resp?.url ?? "",
        disabled: snapshot.capabilities?.canResp !== true,
      },
      adapter: {
        label: adapterLabel(snapshot.adapter?.kind),
        desired: snapshot.adapter?.desired === true,
        state: adapterState,
        stateLabel: stateLabel(adapterState),
        lamp: lamp(adapterState),
        disabled: snapshot.capabilities?.canAdapter !== true,
        hidden: !snapshot.adapter?.kind || snapshot.adapter.kind === "none",
      },
      dom: {
        label: "DOM service",
        state: snapshot.dom?.state ?? "off",
        stateLabel: stateLabel(snapshot.dom?.state ?? "off"),
        lamp: lamp(snapshot.dom?.state ?? "off"),
      },
      downloads: {
        label: "Downloads",
        state: snapshot.downloads?.state ?? "idle",
        stateLabel: stateLabel(snapshot.downloads?.state ?? "idle"),
        lamp: lamp(snapshot.downloads?.state ?? "idle"),
      },
    },
    actions: {
      openReplDisabled: snapshot.binding?.state !== "bound",
      reconnectDisabled: snapshot.binding?.state !== "bound",
      disconnectDisabled: snapshot.binding?.state !== "bound"
        && snapshot.runtime?.state === "off"
        && snapshot.resp?.state === "off",
    },
    error: error ? {
      code: error.code ?? "control/error",
      message: error.message ?? "Unknown control error",
    } : null,
  };
}
