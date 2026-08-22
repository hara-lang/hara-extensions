import { CHATGPT_REPL_PROTOCOL, ChatgptError } from "./chatgpt-service.js";
import { CHATGPT_LOGIN_PROFILE, loginSelectorFor } from "./chatgpt-login-profile.js";

export const CHATGPT_LOGIN_DEFAULT_TIMEOUT_MS = 600000;
export const CHATGPT_LOGIN_MAX_TIMEOUT_MS = 1800000;
export const CHATGPT_LOGIN_TRANSITION_TIMEOUT_MS = 15000;
export const CHATGPT_LOGIN_METHODS = Object.freeze(new Set([
  "login-status",
  "login-start",
  "login-wait",
  "login",
]));

function fail(code, message, data = {}) {
  throw new ChatgptError(code, message, data);
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function attributes(snapshot) {
  return snapshot?.attributes && typeof snapshot.attributes === "object"
    ? snapshot.attributes
    : {};
}

function elementReference(snapshot) {
  const tabId = Number(snapshot?.["tab-id"] ?? snapshot?.tabId);
  const backendNodeId = Number(snapshot?.["backend-node-id"] ?? snapshot?.backendNodeId);
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("chatgpt/login-ui-invalid", "login control is missing an opaque DOM reference");
  }
  return { "tab-id": tabId, "backend-node-id": backendNodeId };
}

function safeLocation(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl ?? ""));
  } catch {
    fail("chatgpt/missing-target", "the panel-bound target has no valid URL");
  }
  return {
    parsed,
    safeUrl: `${parsed.origin}${parsed.pathname}`,
  };
}

function checkedTimeout(value, fallback = CHATGPT_LOGIN_DEFAULT_TIMEOUT_MS) {
  const timeout = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > CHATGPT_LOGIN_MAX_TIMEOUT_MS) {
    fail(
      "chatgpt/invalid-login-timeout",
      `login timeout must be an integer from 1000 to ${CHATGPT_LOGIN_MAX_TIMEOUT_MS} milliseconds`,
      { timeout: value },
    );
  }
  return timeout;
}

function triggerScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(
    attrs["aria-label"]
      ?? attrs.title
      ?? snapshot?.text,
  ).toLowerCase();
  const href = String(attrs.href ?? "").toLowerCase();
  const tag = String(snapshot?.tag ?? "").toLowerCase();
  let score = 0;
  if (attrs["data-hara-chatgpt-action"] === "login") score += 100;
  if (href.includes("/auth/login")) score += 80;
  if (label === "log in" || label === "sign in") score += 60;
  else if (label.includes("log in") || label.includes("sign in")) score += 40;
  if (tag === "button" || tag === "a") score += 20;
  return score;
}

function chooseLoginTrigger(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    fail("chatgpt/login-ui-unsupported", "a visible ChatGPT login control was not found");
  }
  const ranked = candidates
    .map((candidate) => ({ candidate, score: triggerScore(candidate) }))
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    fail("chatgpt/login-ui-unsupported", "the visible ChatGPT login control is ambiguous", {
      candidates: ranked.length,
      score: ranked[0].score,
    });
  }
  return ranked[0].candidate;
}

function userAction(state) {
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

export function createChatgptLoginService({
  domService,
  chatgptService,
  profile = CHATGPT_LOGIN_PROFILE,
  sleep = defaultSleep,
  now = () => Date.now(),
  pollIntervalMs = 100,
  transitionTimeoutMs = CHATGPT_LOGIN_TRANSITION_TIMEOUT_MS,
} = {}) {
  if (!domService || typeof domService.dispatch !== "function") {
    throw new TypeError("createChatgptLoginService requires a DOM service");
  }
  if (!chatgptService || typeof chatgptService.dispatch !== "function") {
    throw new TypeError("createChatgptLoginService requires the ChatGPT inventory service");
  }
  let closed = false;

  async function targetInfo(target) {
    if (closed) fail("chatgpt/closed", "ChatGPT login service has been closed");
    const info = await domService.dispatch("target", [], target);
    const tabId = Number(info?.["tab-id"] ?? info?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      fail("chatgpt/missing-target", "the panel-bound target has no live Chrome tab ID");
    }
    const { parsed, safeUrl } = safeLocation(info?.url);
    return {
      "tab-id": tabId,
      url: safeUrl,
      origin: parsed.origin,
      pathname: parsed.pathname,
    };
  }

  async function queryLoginSnapshots(group, target, limit = 20) {
    return domService.dispatch(
      "query-all",
      [loginSelectorFor(profile, group), limit],
      target,
    );
  }

  async function loginSurfaceExists(group, target) {
    return domService.dispatch(
      "query-exists",
      [loginSelectorFor(profile, group)],
      target,
    );
  }

  function response(info, state, additions = {}) {
    return {
      protocol: CHATGPT_REPL_PROTOCOL,
      state,
      "signed-in?": state === "signed-in",
      "user-action-required?": userAction(state) !== null,
      action: userAction(state),
      "credential-handling": "browser-only",
      ...info,
      ...additions,
    };
  }

  async function visibleLoginSurface(info, target) {
    if (await loginSurfaceExists("verificationSurface", target)) {
      return response(info, "verification-required", {
        message: "Complete the verification challenge in the visible browser window.",
      });
    }
    if (await loginSurfaceExists("authSurface", target)) {
      return response(info, "authentication-required", {
        message: "Complete sign-in in the visible browser window using the account's existing authentication method.",
      });
    }
    return null;
  }

  async function loginStatus(target) {
    const info = await targetInfo(target);
    if (!profile.chatgptOrigins.includes(info.origin)) {
      return response(info, "external-authentication", {
        message: "Complete authentication in the browser; the REPL does not inspect this provider page.",
      });
    }

    // On an authentication route, visible credential or verification surfaces
    // take precedence over generic login buttons. This prevents login-start
    // from mistaking a form's submit control for the landing-page trigger.
    if (info.pathname.startsWith("/auth/")) {
      return (await visibleLoginSurface(info, target))
        ?? response(info, "authentication-required", {
          message: "Complete sign-in in the visible browser window using the account's existing authentication method.",
        });
    }

    try {
      const current = await chatgptService.dispatch("status", [], target);
      if (current?.["signed-in?"] === true) {
        return response(info, "signed-in", {
          "inventory-state": current.state,
          profile: current.profile ?? null,
        });
      }
      if (current?.state === "signed-out") {
        // Some layouts keep a login form in a modal without changing the URL.
        // Check that surface before declaring the landing page merely signed out.
        return (await visibleLoginSurface(info, target))
          ?? response(info, "signed-out");
      }
    } catch (error) {
      if (error?.code !== "chatgpt/ui-unsupported") throw error;
    }

    return (await visibleLoginSurface(info, target))
      ?? response(info, "loading", {
        message: "ChatGPT authentication state is not yet settled.",
      });
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
    if (current.state !== "signed-out") {
      return { ...current, started: false };
    }
    const trigger = chooseLoginTrigger(await queryLoginSnapshots("loginTrigger", target));
    const clicked = await domService.dispatch("click", [elementReference(trigger)], target);
    if (clicked !== true) {
      fail("chatgpt/login-action-unverified", "the visible ChatGPT login control did not activate");
    }
    const transitioned = await waitFor(
      (status) => status.state !== "signed-out" && status.state !== "loading",
      transitionTimeoutMs,
      "chatgpt/login-transition-timeout",
      "ChatGPT did not enter an authentication state after the login control was activated",
      target,
    );
    return { ...transitioned, started: true };
  }

  async function loginWait(rawTimeout, target) {
    const timeoutMs = checkedTimeout(rawTimeout);
    return waitFor(
      (status) => status["signed-in?"] === true,
      timeoutMs,
      "chatgpt/login-timeout",
      "ChatGPT login did not complete before the timeout",
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
        if (args.length !== 0) fail("chatgpt/invalid-request", "login-status expects 0 arguments");
        return loginStatus(target);
      case "login-start":
        if (args.length !== 0) fail("chatgpt/invalid-request", "login-start expects 0 arguments");
        return loginStart(target);
      case "login-wait":
        if (args.length > 1) fail("chatgpt/invalid-request", "login-wait expects 0-1 arguments");
        return loginWait(args[0], target);
      case "login":
        if (args.length > 1) fail("chatgpt/invalid-request", "login expects 0-1 arguments");
        return login(args[0], target);
      default:
        fail("chatgpt/operation-unsupported", `unsupported ChatGPT login operation: ${method}`);
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
