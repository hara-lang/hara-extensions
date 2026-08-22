import { checkedTabId } from "./runtime-protocol.js";

export const CONTROL_PROTOCOL = "greenways.hara-control/0-alpha";
export const CONTROL_PREFERENCES_KEY = "hara-control.preferences";
export const CONTROL_SESSION_KEY = "hara-control.session";

export const DEFAULT_CONTROL_PREFERENCES = Object.freeze({
  adapterDefaultEnabled: true,
  respUrl: "ws://127.0.0.1:7356",
});

export function safeUrl(rawValue) {
  try {
    return new URL(String(rawValue ?? ""));
  } catch {
    return null;
  }
}

export function classifyTab(tab = {}) {
  tab = tab ?? {};
  const parsed = safeUrl(tab.url);
  const base = {
    id: Number.isInteger(Number(tab.id)) && Number(tab.id) > 0 ? Number(tab.id) : null,
    windowId: Number.isInteger(Number(tab.windowId)) && Number(tab.windowId) >= 0 ? Number(tab.windowId) : null,
    title: String(tab.title ?? ""),
    url: parsed?.href ?? String(tab.url ?? ""),
    origin: parsed?.origin ?? null,
    hostname: parsed?.hostname ?? null,
    kind: "unsupported",
    adapter: "none",
    bindable: false,
    restricted: true,
  };
  if (!parsed) return base;
  if (parsed.origin === "https://chatgpt.com") {
    return { ...base, kind: "chatgpt", adapter: "chatgpt", bindable: true, restricted: false };
  }
  if (parsed.origin === "https://studio.tripo3d.ai") {
    return { ...base, kind: "tripo", adapter: "tripo", bindable: true, restricted: false };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { ...base, kind: "web", adapter: "none", bindable: true, restricted: false };
  }
  if (parsed.protocol === "chrome-extension:") {
    return { ...base, kind: "extension", adapter: "none", bindable: false, restricted: true };
  }
  return base;
}

export function publicTab(tab) {
  if (!tab) return null;
  return classifyTab(tab);
}

export function normalizePreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CONTROL_PREFERENCES };
  }
  return {
    adapterDefaultEnabled: value.adapterDefaultEnabled !== false,
    respUrl: typeof value.respUrl === "string" && value.respUrl.length > 0
      ? value.respUrl
      : DEFAULT_CONTROL_PREFERENCES.respUrl,
  };
}

export function initialSession(now = Date.now) {
  return {
    controlled: false,
    bindingDesired: false,
    boundTabId: null,
    boundWindowId: null,
    boundUrl: null,
    boundTitle: null,
    runtimeDesired: false,
    respDesired: false,
    adapterDesired: true,
    replTabId: null,
    lastError: null,
    revision: 0,
    updatedAt: now(),
  };
}

export function normalizeSession(value, now = Date.now) {
  const defaults = initialSession(now);
  if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
  const positive = (input) => {
    const number = Number(input);
    return Number.isInteger(number) && number > 0 ? number : null;
  };
  return {
    ...defaults,
    controlled: value.controlled === true,
    bindingDesired: value.bindingDesired === true,
    boundTabId: positive(value.boundTabId),
    boundWindowId: positive(value.boundWindowId),
    boundUrl: typeof value.boundUrl === "string" ? value.boundUrl : null,
    boundTitle: typeof value.boundTitle === "string" ? value.boundTitle : null,
    runtimeDesired: value.runtimeDesired === true,
    respDesired: value.respDesired === true,
    adapterDesired: value.adapterDesired !== false,
    replTabId: positive(value.replTabId),
    lastError: value.lastError && typeof value.lastError === "object" ? value.lastError : null,
    revision: Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0,
    updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : now(),
  };
}

export function badgeForSnapshot(snapshot) {
  if (snapshot?.activity?.lastError) return "!";
  const auth = snapshot?.adapter?.authentication;
  if (["signed-out", "authentication-required", "verification-required", "external-authentication"].includes(auth)) {
    return "AUTH";
  }
  if (["starting", "stopping"].includes(snapshot?.runtime?.state) || snapshot?.resp?.state === "connecting") {
    return "…";
  }
  if (snapshot?.binding?.state === "bound" && snapshot?.runtime?.state === "ready") return "ON";
  return "";
}

export function titleForSnapshot(snapshot) {
  const target = snapshot?.boundTab?.hostname ?? snapshot?.activeTab?.hostname ?? "no target";
  if (snapshot?.activity?.lastError) return `Hara — ERROR — ${target}`;
  if (snapshot?.adapter?.authentication && snapshot.adapter.authentication !== "signed-in") {
    return `Hara — AUTH — ${target}`;
  }
  if (snapshot?.runtime?.state === "ready") return `Hara — READY — ${target}`;
  if (snapshot?.binding?.state === "bound") return `Hara — BOUND — ${target}`;
  return "Hara — disconnected";
}

export function requireBindableTab(tab) {
  const classified = classifyTab(tab);
  if (!classified.bindable) {
    const error = new Error("control/tab-not-bindable: the selected tab cannot be controlled");
    error.code = "control/tab-not-bindable";
    error.data = { tabId: classified.id, url: classified.url, kind: classified.kind };
    throw error;
  }
  checkedTabId(classified.id, "control/invalid-tab");
  return classified;
}
