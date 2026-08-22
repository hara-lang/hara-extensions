import assert from "node:assert/strict";
import { test } from "node:test";
import { TRIPO_SELECTOR_PROFILE, selectorFor } from "../src/tripo-profile.js";
import { createTripoLoginService } from "../src/tripo-login-service.js";

function snapshot({ backend, tag = "button", text = "", attributes = {}, tabId = 41 }) {
  return { "tab-id": tabId, "backend-node-id": backend, tag, text, attributes, value: null, checked: null, disabled: false };
}

function fixture({
  url = "https://studio.tripo3d.ai/",
  statuses = [{ state: "signed-out", "signed-in?": false }],
  loginTriggers = [snapshot({
    backend: 10,
    text: "Sign up/Log in",
    attributes: { "data-hara-tripo-action": "login", "aria-label": "Sign up/Log in" },
  })],
  authSurface = false,
  verificationSurface = false,
} = {}) {
  let currentUrl = url;
  let currentStatuses = [...statuses];
  let auth = authSurface;
  let verification = verificationSurface;
  const clicks = [];
  const calls = [];
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "target") return { "tab-id": 41, url: currentUrl };
      if (method === "query-all") {
        if (args[0] === selectorFor(TRIPO_SELECTOR_PROFILE, "loginTrigger")) return loginTriggers;
        return [];
      }
      if (method === "query-exists") {
        if (args[0] === selectorFor(TRIPO_SELECTOR_PROFILE, "authSurface")) return auth;
        if (args[0] === selectorFor(TRIPO_SELECTOR_PROFILE, "verificationSurface")) return verification;
        return false;
      }
      if (method === "click") {
        clicks.push(args[0]);
        currentUrl = "https://studio.tripo3d.ai/auth/login?state=secret";
        auth = true;
        return true;
      }
      throw new Error(`unexpected DOM operation ${method}`);
    },
  };
  const tripoService = {
    async dispatch(method) {
      assert.equal(method, "status");
      const next = currentStatuses.length > 1 ? currentStatuses.shift() : currentStatuses[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return {
    domService,
    tripoService,
    clicks,
    calls,
    setUrl(value) { currentUrl = value; },
    setAuth(value) { auth = value; },
    setVerification(value) { verification = value; },
    setStatuses(values) { currentStatuses = [...values]; },
  };
}

test("login-status reports an authenticated Tripo inventory", async () => {
  const environment = fixture({ statuses: [{ state: "inventory-ready", "signed-in?": true, profile: { id: "tripo-studio/en/1" } }] });
  const service = createTripoLoginService({ domService: environment.domService, tripoService: environment.tripoService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "signed-in");
  assert.equal(status["signed-in?"], true);
  assert.equal(status["credential-handling"], "browser-only");
});

test("login-start activates one visible login control and redacts query state", async () => {
  const unsupported = Object.assign(new Error("unsupported"), { code: "tripo/ui-unsupported" });
  const environment = fixture({ statuses: [{ state: "signed-out", "signed-in?": false }, unsupported] });
  const service = createTripoLoginService({
    domService: environment.domService,
    tripoService: environment.tripoService,
    pollIntervalMs: 0,
  });
  const status = await service.dispatch("login-start", [], { tabId: 41 });
  assert.equal(status.state, "authentication-required");
  assert.equal(status.started, true);
  assert.equal(status.url, "https://studio.tripo3d.ai/auth/login");
  assert.doesNotMatch(status.url, /secret/);
  assert.deepEqual(environment.clicks, [{ "tab-id": 41, "backend-node-id": 10 }]);
});

test("verification surfaces produce a distinct state without snapshots", async () => {
  const environment = fixture({
    url: "https://studio.tripo3d.ai/auth/login",
    verificationSurface: true,
    statuses: [Object.assign(new Error("unsupported"), { code: "tripo/ui-unsupported" })],
  });
  const service = createTripoLoginService({ domService: environment.domService, tripoService: environment.tripoService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "verification-required");
  assert.equal(status.action, "complete-verification-in-browser");
  assert.equal(environment.calls.some((call) => call.method === "query-all" && /one-time-code/.test(call.args[0])), false);
});

test("external identity providers are observed only by redacted origin and path", async () => {
  const environment = fixture({ url: "https://accounts.google.com/o/oauth2/auth?state=secret&code=private" });
  const service = createTripoLoginService({ domService: environment.domService, tripoService: environment.tripoService });
  const status = await service.dispatch("login-status", [], { tabId: 41 });
  assert.equal(status.state, "external-authentication");
  assert.equal(status.url, "https://accounts.google.com/o/oauth2/auth");
  assert.equal(environment.calls.filter((call) => call.method === "query-all" || call.method === "query-exists").length, 0);
});

test("login-wait follows provider navigation until Tripo is signed in", async () => {
  const environment = fixture({ url: "https://accounts.google.com/o/oauth2/auth" });
  let ticks = 0;
  const service = createTripoLoginService({
    domService: environment.domService,
    tripoService: environment.tripoService,
    pollIntervalMs: 1,
    sleep: async () => {
      ticks += 1;
      if (ticks === 1) {
        environment.setUrl("https://studio.tripo3d.ai/assets");
        environment.setStatuses([{ state: "inventory-ready", "signed-in?": true, profile: { id: "tripo-studio/en/1" } }]);
      }
    },
  });
  const status = await service.dispatch("login-wait", [5000], { tabId: 41 });
  assert.equal(status.state, "signed-in");
});

test("ambiguous login controls fail closed without clicking", async () => {
  const environment = fixture({
    loginTriggers: [
      snapshot({ backend: 10, text: "Log in", attributes: { "aria-label": "Log in" } }),
      snapshot({ backend: 11, text: "Log in", attributes: { "aria-label": "Log in" } }),
    ],
  });
  const service = createTripoLoginService({ domService: environment.domService, tripoService: environment.tripoService });
  await assert.rejects(
    service.dispatch("login-start", [], { tabId: 41 }),
    (error) => error.code === "tripo/login-ui-unsupported",
  );
  assert.deepEqual(environment.clicks, []);
});

test("invalid login timeouts fail before target observation", async () => {
  const environment = fixture();
  const service = createTripoLoginService({ domService: environment.domService, tripoService: environment.tripoService });
  await assert.rejects(
    service.dispatch("login-wait", [10], { tabId: 41 }),
    (error) => error.code === "tripo/invalid-login-timeout",
  );
  assert.deepEqual(environment.calls, []);
});
