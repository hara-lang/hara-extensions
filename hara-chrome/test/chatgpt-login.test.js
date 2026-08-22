import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatgptLoginService } from "../src/chatgpt-login-service.js";
import { CHATGPT_LOGIN_PROFILE, loginSelectorFor } from "../src/chatgpt-login-profile.js";

function snapshot({ backend, tag = "button", text = "", attributes = {}, tabId = 41 }) {
  return {
    "tab-id": tabId,
    "backend-node-id": backend,
    tag,
    text,
    attributes,
    value: null,
    checked: null,
    disabled: false,
  };
}

function fixture({
  url = "https://chatgpt.com/",
  inventoryStatuses = [{ state: "signed-out", "signed-in?": false }],
  loginTriggers = [snapshot({
    backend: 10,
    attributes: {
      "data-hara-chatgpt-action": "login",
      "aria-label": "Log in",
      href: "/auth/login",
    },
  })],
  authSurface = [],
  verificationSurface = [],
} = {}) {
  let currentUrl = url;
  let statuses = [...inventoryStatuses];
  const clicks = [];
  const calls = [];
  const selectors = {
    loginTrigger: loginSelectorFor(CHATGPT_LOGIN_PROFILE, "loginTrigger"),
    authSurface: loginSelectorFor(CHATGPT_LOGIN_PROFILE, "authSurface"),
    verificationSurface: loginSelectorFor(CHATGPT_LOGIN_PROFILE, "verificationSurface"),
  };
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "target") return { "tab-id": 41, url: currentUrl };
      if (method === "query-all") {
        if (args[0] === selectors.loginTrigger) return loginTriggers;
        return [];
      }
      if (method === "query-exists") {
        if (args[0] === selectors.authSurface) return authSurface.length > 0;
        if (args[0] === selectors.verificationSurface) return verificationSurface.length > 0;
        return false;
      }
      if (method === "click") {
        clicks.push(args[0]);
        currentUrl = "https://chatgpt.com/auth/login?state=secret-oauth-state";
        return true;
      }
      throw new Error(`unexpected DOM method ${method}`);
    },
  };
  const chatgptService = {
    async dispatch(method) {
      assert.equal(method, "status");
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return {
    domService,
    chatgptService,
    calls,
    clicks,
    setUrl(value) { currentUrl = value; },
    setStatuses(values) { statuses = [...values]; },
  };
}

test("login-status reports signed-in inventory without touching credential fields", async () => {
  const env = fixture({
    inventoryStatuses: [{ state: "inventory-ready", "signed-in?": true, profile: { id: "chatgpt-web/en/1" } }],
  });
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "signed-in");
  assert.equal(status["signed-in?"], true);
  assert.equal(status["credential-handling"], "browser-only");
  assert.equal(env.calls.filter((call) => call.method === "query-all").length, 0);
});

test("login-start clicks one visible login control and returns user-controlled authentication", async () => {
  const unsupported = Object.assign(new Error("unsupported"), { code: "chatgpt/ui-unsupported" });
  const env = fixture({ inventoryStatuses: [{ state: "signed-out", "signed-in?": false }, unsupported] });
  const service = createChatgptLoginService({
    domService: env.domService,
    chatgptService: env.chatgptService,
    transitionTimeoutMs: 500,
    pollIntervalMs: 0,
  });
  const status = await service.dispatch("login-start", [], { tabId: 41 });
  assert.equal(status.state, "authentication-required");
  assert.equal(status.started, true);
  assert.equal(status["user-action-required?"], true);
  assert.equal(status.url, "https://chatgpt.com/auth/login");
  assert.doesNotMatch(status.url, /secret-oauth-state/);
  assert.deepEqual(env.clicks, [{ "tab-id": 41, "backend-node-id": 10 }]);
  assert.equal(env.calls.some((call) => call.method === "fill"), false);
});

test("credential forms take precedence over generic signed-out controls", async () => {
  const env = fixture({
    url: "https://chatgpt.com/auth/login",
    inventoryStatuses: [{ state: "signed-out", "signed-in?": false }],
    authSurface: [snapshot({ backend: 13, tag: "input", attributes: { type: "email" } })],
  });
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  const status = await service.dispatch("login-start", [], { tabId: 41 });
  assert.equal(status.state, "authentication-required");
  assert.equal(status.started, false);
  assert.deepEqual(env.clicks, []);
  assert.equal(
    env.calls.some((call) => call.method === "query-all" && call.args[0] === loginSelectorFor(CHATGPT_LOGIN_PROFILE, "authSurface")),
    false,
  );
});

test("external identity providers are observed only as browser-controlled authentication", async () => {
  const env = fixture({ url: "https://accounts.google.com/o/oauth2/auth?state=secret" });
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "external-authentication");
  assert.equal(status.origin, "https://accounts.google.com");
  assert.equal(status.url, "https://accounts.google.com/o/oauth2/auth");
  assert.equal(status.action, "complete-provider-login-in-browser");
  assert.equal(env.calls.filter((call) => call.method === "query-all").length, 0);
});

test("verification surfaces produce a distinct user-action state", async () => {
  const unsupported = Object.assign(new Error("unsupported"), { code: "chatgpt/ui-unsupported" });
  const env = fixture({
    url: "https://chatgpt.com/auth/login",
    inventoryStatuses: [unsupported],
    verificationSurface: [snapshot({ backend: 11, tag: "input", attributes: { autocomplete: "one-time-code" } })],
  });
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "verification-required");
  assert.equal(status.action, "complete-verification-in-browser");
});

test("login-wait follows provider navigation and resolves only after signed-in inventory appears", async () => {
  const env = fixture({ url: "https://accounts.google.com/o/oauth2/auth" });
  let ticks = 0;
  const service = createChatgptLoginService({
    domService: env.domService,
    chatgptService: env.chatgptService,
    pollIntervalMs: 1,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        env.setUrl("https://chatgpt.com/");
        env.setStatuses([{ state: "inventory-ready", "signed-in?": true, profile: { id: "chatgpt-web/en/1" } }]);
      }
    },
  });
  const status = await service.dispatch("login-wait", [5000], { tabId: 41 });
  assert.equal(status.state, "signed-in");
  assert.equal(status["signed-in?"], true);
});

test("login-wait fails with a distinct bounded timeout", async () => {
  const env = fixture({ url: "https://accounts.google.com/o/oauth2/auth" });
  let current = 0;
  const service = createChatgptLoginService({
    domService: env.domService,
    chatgptService: env.chatgptService,
    now: () => current,
    sleep: async () => { current += 1000; },
    pollIntervalMs: 1,
  });
  await assert.rejects(
    service.dispatch("login-wait", [1000], { tabId: 41 }),
    (error) => error.code === "chatgpt/login-timeout" && error.data.lastState === "external-authentication",
  );
});

test("ambiguous login controls fail closed without clicking", async () => {
  const env = fixture({
    loginTriggers: [
      snapshot({ backend: 10, text: "Log in", attributes: { "aria-label": "Log in" } }),
      snapshot({ backend: 12, text: "Log in", attributes: { "aria-label": "Log in" } }),
    ],
  });
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  await assert.rejects(
    service.dispatch("login-start", [], { tabId: 41 }),
    (error) => error.code === "chatgpt/login-ui-unsupported",
  );
  assert.deepEqual(env.clicks, []);
});

test("invalid login timeouts fail before observing the target", async () => {
  const env = fixture();
  const service = createChatgptLoginService({ domService: env.domService, chatgptService: env.chatgptService });
  await assert.rejects(
    service.dispatch("login-wait", [10], { tabId: 41 }),
    (error) => error.code === "chatgpt/invalid-login-timeout",
  );
  assert.deepEqual(env.calls, []);
});
