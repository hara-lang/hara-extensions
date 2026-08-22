import assert from "node:assert/strict";
import { test } from "node:test";
import { TRIPO_SELECTOR_PROFILE, selectorFor } from "../src/tripo-profile.js";
import { createTripoService } from "../src/tripo-service.js";

function snapshot({ backend, tag = "a", text = "", attributes = {}, tabId = 41 }) {
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

const navigation = snapshot({
  backend: 1,
  tag: "nav",
  attributes: { "data-hara-tripo-navigation": "true", "aria-label": "Tripo Studio" },
});
const signedIn = snapshot({ backend: 2, tag: "button", attributes: { "data-hara-tripo-signed-in": "true", "aria-label": "Account" } });
const workspace = snapshot({
  backend: 3,
  tag: "button",
  text: "Personal Workspace",
  attributes: {
    "data-hara-tripo-workspace-current": "true",
    "data-workspace-id": "personal",
    "data-workspace-mode": "personal",
  },
});
const assetsNav = snapshot({ backend: 4, text: "Assets", attributes: { href: "/assets", "data-hara-tripo-action": "assets" } });
const assetSurface = snapshot({ backend: 5, tag: "main", attributes: { "data-hara-tripo-surface": "assets" } });
const assetA = snapshot({
  backend: 10,
  text: "Wooden chair",
  attributes: {
    href: "/assets/wooden-chair",
    "data-hara-tripo-kind": "asset",
    "data-asset-id": "asset-chair",
    "data-status": "complete",
    "data-visibility": "private",
    "data-workspace-id": "personal",
  },
});

function fixture({
  url = "https://studio.tripo3d.ai/assets",
  signedInItems = [signedIn],
  signedOutItems = [],
  navigationItems = [navigation],
  workspaceItems = [workspace],
  assetSurfaceItems = [assetSurface],
  assetItems = [assetA],
  assetsNavItems = [assetsNav],
} = {}) {
  const calls = [];
  const clicks = [];
  const answers = new Map([
    [selectorFor(TRIPO_SELECTOR_PROFILE, "signedIn"), signedInItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "signedOut"), signedOutItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "navigation"), navigationItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "workspace"), workspaceItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "assetLibrary"), assetSurfaceItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "assets"), assetItems],
    [selectorFor(TRIPO_SELECTOR_PROFILE, "assetsNav"), assetsNavItems],
  ]);
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "target") return { "tab-id": 41, url };
      if (method === "query-all") return answers.get(args[0]) ?? [];
      if (method === "click") {
        clicks.push(args[0]);
        return true;
      }
      throw new Error(`unexpected DOM operation: ${method}`);
    },
  };
  return { domService, calls, clicks };
}

test("status verifies the exact Tripo Studio origin and signed-in marker", async () => {
  const environment = fixture();
  const service = createTripoService({ domService: environment.domService });
  const value = await service.dispatch("status", [], { tabId: 41 });
  assert.deepEqual(value, {
    protocol: "greenways.tripo-web-repl/0-alpha",
    state: "inventory-ready",
    "signed-in?": true,
    "tab-id": 41,
    url: "https://studio.tripo3d.ai/assets",
    origin: "https://studio.tripo3d.ai",
    profile: { id: "tripo-studio/en/1", version: 1, locale: "en" },
    navigation: { "tab-id": 41, "backend-node-id": 1 },
  });
});

test("unsupported origins fail before Studio selectors are queried", async () => {
  const environment = fixture({ url: "https://example.com/assets" });
  const service = createTripoService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("status", [], { tabId: 41 }),
    (error) => error.code === "tripo/unsupported-origin",
  );
  assert.equal(environment.calls.filter((call) => call.method === "query-all").length, 0);
});

test("workspace returns a bounded current workspace snapshot", async () => {
  const environment = fixture();
  const service = createTripoService({ domService: environment.domService });
  assert.deepEqual(await service.dispatch("workspace", [], { tabId: 41 }), {
    kind: "workspace",
    id: "personal",
    name: "Personal Workspace",
    mode: "personal",
    element: { "tab-id": 41, "backend-node-id": 3 },
  });
});

test("assets returns bounded logical snapshots only when the Assets library is open", async () => {
  const environment = fixture();
  const service = createTripoService({ domService: environment.domService });
  assert.deepEqual(await service.dispatch("assets", [], { tabId: 41 }), [{
    kind: "asset",
    id: "asset-chair",
    title: "Wooden chair",
    href: "/assets/wooden-chair",
    status: "complete",
    visibility: "private",
    "workspace-id": "personal",
    "active?": false,
    element: { "tab-id": 41, "backend-node-id": 10 },
  }]);
});

test("assets fails distinctly when the library surface is not open", async () => {
  const environment = fixture({ assetSurfaceItems: [] });
  const service = createTripoService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("assets", [], { tabId: 41 }),
    (error) => error.code === "tripo/assets-not-open",
  );
});

test("open-assets clicks a uniquely ranked visible Assets control", async () => {
  const environment = fixture();
  const service = createTripoService({ domService: environment.domService });
  assert.deepEqual(await service.dispatch("open-assets", [], { tabId: 41 }), { opened: true, kind: "assets" });
  assert.deepEqual(environment.clicks, [{ "tab-id": 41, "backend-node-id": 4 }]);
});

test("open-asset re-resolves logical identity and ignores stale supplied references", async () => {
  const environment = fixture();
  const service = createTripoService({ domService: environment.domService });
  const value = await service.dispatch("open-asset", [{
    kind: ":asset",
    id: "asset-chair",
    href: "/assets/wooden-chair",
    element: { "tab-id": 41, "backend-node-id": 999 },
  }], { tabId: 41 });
  assert.deepEqual(value, { opened: true, kind: "asset", id: "asset-chair", href: "/assets/wooden-chair" });
  assert.deepEqual(environment.clicks, [{ "tab-id": 41, "backend-node-id": 10 }]);
});

test("duplicate logical asset identities fail closed", async () => {
  const environment = fixture({
    assetItems: [assetA, snapshot({
      backend: 11,
      text: "Duplicate chair",
      attributes: {
        href: "/assets/chair-copy",
        "data-hara-tripo-kind": "asset",
        "data-asset-id": "asset-chair",
      },
    })],
  });
  const service = createTripoService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("assets", [], { tabId: 41 }),
    (error) => error.code === "tripo/duplicate-identity",
  );
});

test("ambiguous current workspace controls fail closed", async () => {
  const environment = fixture({
    workspaceItems: [
      snapshot({ backend: 3, tag: "button", text: "Workspace", attributes: { "aria-label": "Workspace" } }),
      snapshot({ backend: 6, tag: "button", text: "Workspace", attributes: { "aria-label": "Workspace" } }),
    ],
  });
  const service = createTripoService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("workspace", [], { tabId: 41 }),
    (error) => error.code === "tripo/ui-unsupported",
  );
});
