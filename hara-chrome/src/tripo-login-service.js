import { TRIPO_SELECTOR_PROFILE, selectorFor } from "./tripo-profile.js";
import { TRIPO_REPL_PROTOCOL, TripoError } from "./tripo-service.js";

export const TRIPO_LOGIN_DEFAULT_TIMEOUT_MS = 600000;
export const TRIPO_LOGIN_MAX_TIMEOUT_MS = 1800000;
export const TRIPO_LOGIN_TRANSITION_TIMEOUT_MS = 15000;
export const TRIPO_LOGIN_METHODS = Object.freeze(new Set([
  "login-status",
  "login-start",
  "login-wait",
  "login",
]));

function fail(code, message, data = {}) {
  throw new TripoError(code, message, data);
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function attributes(snapshot) {
  return snapshot?.attributes && typeof snapshot.attributes === "object" ? snapshot.attributes : {};
}

function elementReference(snapshot) {
  const tabId = Number(snapshot?.["tab-id"] ?? snapshot?.tabId);
  const backendNodeId = Number(snapshot?.["backend-node-id"] ?? snapshot?.backendNodeId);
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("tripo/login-ui-invalid", "login control is missing an opaque DOM reference");
  }
  return { "tab-id": tabId, "backend-node-id": backendNodeId };
}

function safeLocation(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ""));
  } catch {
    fail("tripo/missing-target", "the panel-bound target has no valid URL");
  }
  return { parsed, safeUrl: `${parsed.origin}${parsed.pathname}` };
}

function checkedTimeout(value, fallback = TRIPO_LOGIN_DEFAULT_TIMEOUT_MS) {
  const timeout = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > TRIPO_LOGIN_MAX_TIMEOUT_MS) {
    fail("tripo/invalid-login-timeout", `login timeout must be an integer from 1000 to ${TRIPO_LOGIN_MAX_TIMEOUT_MS} milliseconds`, { timeout: value });
  }
  return timeout;
}

function triggerScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"] ?? attrs.title ?? snapshot?.text).toLowerCase();
  const href = String(attrs.href ?? "").toLowerCase();
  const tag = String(snapshot?.tag ?? "").toLowerCase();
  let score = 0;
  if (attrs["data-hara-tripo-action"] === "login") score += 100;
  if (href.includes("/login") || href.includes("/signin")) score += 80;
  if (label.includes("sign up/log in")) score += 70;
  if (label === "log in" || label === "sign in") score += 60;
  else if (label.includes("log in") || label.includes("sign in")) score += 40;
  if (tag === "button" || tag === "a") score += 20;
  return score;
}

function chooseTrigger(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("tripo/login-ui-unsupported", "a visible Tripo login control was not found");
  }
  const ranked = candidates.map((candidate) => ({ candidate, score: triggerScore(candidate) }))
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    fail("tripo/login-ui-unsupported", "the visible Tripo login control is ambiguous", {
      candidates: ranked.length,
      score: ranked[0].score,
    });
  }
  return ranked[0].candidate;
}

function actionFor(state) {
  switch (state) {
    case "signed-out": return "start-login";
    case "authentication-required": return "complete-login-in-browser";
    case "verification-required": return "complete-verification-in-browser";
    case "external-authentication": return "complete-provider-login-in-browser";
    default: return null;
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createTripoLoginService({
  domService,
  tripoService,
  profile = TRIPO_SELECTOR_PROFILE,
  sleep = defaultSleep,
  now = () => Date.now(),
  pollIntervalMs = 100,
  transitionTimeoutMs = TRIPO_LOGIN_TRANSITION_TIMEOUT_MS,
} = {}) {
  if (!domService || typeof domService.dispatch !== "function") {
    throw new TypeError("createTripoLoginService requires a DOM service");
  }
  if (!tripoService || typeof tripoService.dispatch !== "function") {
    throw new TypeError("createTripoLoginService requires the Tripo inventory service");
  }
  let closed = false;

  async function targetInfo(target) {
    if (closed) fail("tripo/closed", "Tripo login service has been closed");
    const info = await domService.dispatch("target", [], target);
    const tabId = Number(info?.["tab-id"] ?? info?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) fail("tripo/missing-target", "the panel-bound target has no live Chrome tab ID");
    const { parsed, safeUrl } = safeLocation(info?.url);
    return { "tab-id": tabId, url: safeUrl, origin: parsed.origin, pathname: parsed.pathname };
  }

  async function querySnapshots(group, target, limit = 20) {
    return domService.dispatch("query-all", [selectorFor(profile, group), limit], target);
  }

  async function surfaceExists(group, target) {
    return domService.dispatch("query-exists", [selectorFor(profile, group)], target);
  }

  function response(info, state, additions = {}) {
    return {
      protocol: TRIPO_REPL_PROTOCOL,
      state,
      "signed-in?": state === "signed-in",
      "user-action-required?": actionFor(state) !== null,
      action: actionFor(state),
      "credential-handling": "browser-only",
      ...info,
      ...additions,
    };
  }

  async function visibleAuthState(info, target) {
    if (await surfaceExists("verificationSurface", target)) {
      return response(info, "verification-required", {
        message: "Complete the verification challenge in the visible browser window.",
      });
    }
    if (await surfaceExists("authSurface", target)) {
      return response(info, "authentication-required", {
        message: "Complete sign-in in the visible browser window using the account's existing authentication method.",
      });
    }
    return null;
  }

  async function loginStatus(target) {
    const info = await targetInfo(target);
    if (!profile.origins.includes(info.origin)) {
      return response(info, "external-authentication", {
        message: "Complete authentication in the browser; the REPL does not inspect this provider page.",
      });
    }

    if (/\/(?:auth|login|signin)(?:\/|$)/i.test(info.pathname)) {
      return (await visibleAuthState(info, target))
        ?? response(info, "authentication-required", {
          message: "Complete sign-in in the visible Tripo browser window.",
        });
    }

    try {
      const current = await tripoService.dispatch("status", [], target);
      if (current?.["signed-in?"] === true) {
        return response(info, "signed-in", {
          "inventory-state": current.state,
          profile: current.profile ?? null,
        });
      }
      if (current?.state === "signed-out") {
        return (await visibleAuthState(info, target)) ?? response(info, "signed-out");
      }
    } catch (error) {
      if (error?.code !== "tripo/ui-unsupported") throw error;
    }

    return (await visibleAuthState(info, target))
      ?? response(info, "loading", { message: "Tripo authentication state is not yet settled." });
  }

  async function waitFor(predicate, timeoutMs, timeoutCode, timeoutMessage, target) {
    const deadline = now() + timeoutMs;
    let latest = null;
    do {
      latest = await loginStatus(target);
      if (predicate(latest)) return latest;
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    } while (true);
    fail(timeoutCode, timeoutMessage, {
      timeoutMs,
      lastState: latest?.state ?? null,
      origin: latest?.origin ?? null,
      url: latest?.url ?? null,
    });
  }

  async function loginStart(target) {
    const current = await loginStatus(target);
    if (current["signed-in?"]) return { ...current, started: false };
    if (current.state !== "signed-out") return { ...current, started: false };
    const trigger = chooseTrigger(await querySnapshots("loginTrigger", target));
    const clicked = await domService.dispatch("click", [elementReference(trigger)], target);
    if (clicked !== true) fail("tripo/login-action-unverified", "the visible Tripo login control did not activate");
    const transitioned = await waitFor(
      (status) => status.state !== "signed-out" && status.state !== "loading",
      transitionTimeoutMs,
      "tripo/login-transition-timeout",
      "Tripo did not enter an authentication state after the login control was activated",
      target,
    );
    return { ...transitioned, started: true };
  }

  async function loginWait(rawTimeout, target) {
    const timeoutMs = checkedTimeout(rawTimeout);
    return waitFor(
      (status) => status["signed-in?"] === true,
      timeoutMs,
      "tripo/login-timeout",
      "Tripo login did not complete before the timeout",
      target,
    );
  }

  async function login(rawTimeout, target) {
    const started = await loginStart(target);
    if (started["signed-in?"]) return started;
    return loginWait(rawTimeout, target);
  }

  async function dispatch(method, args = [], target = null) {
    switch (method) {
      case "login-status":
        if (args.length !== 0) fail("tripo/invalid-request", "login-status expects 0 arguments");
        return loginStatus(target);
      case "login-start":
        if (args.length !== 0) fail("tripo/invalid-request", "login-start expects 0 arguments");
        return loginStart(target);
      case "login-wait":
        if (args.length > 1) fail("tripo/invalid-request", "login-wait expects 0-1 arguments");
        return loginWait(args[0], target);
      case "login":
        if (args.length > 1) fail("tripo/invalid-request", "login expects 0-1 arguments");
        return login(args[0], target);
      default:
        fail("tripo/operation-unsupported", `unsupported Tripo login operation: ${method}`);
    }
  }

  return {
    dispatch,
    async close() {
      closed = true;
      return true;
    },
  };
}
