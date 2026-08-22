import assert from "node:assert/strict";
import { test } from "node:test";
import { selectorFor, TRIPO_SELECTOR_PROFILE } from "../src/tripo-profile.js";
import { createTripoDownloadService } from "../src/tripo-download-service.js";

function snapshot({ backend, tag = "button", text = "", attributes = {}, disabled = false, tabId = 41 }) {
  return {
    "tab-id": tabId,
    "backend-node-id": backend,
    tag,
    text,
    attributes,
    value: null,
    checked: null,
    disabled,
  };
}

const asset = {
  kind: ":asset",
  id: "asset-chair",
  title: "Wooden chair",
  href: "/assets/wooden-chair",
  "workspace-id": "personal",
  element: { "tab-id": 41, "backend-node-id": 999 },
};

function fixture({
  url = "https://studio.tripo3d.ai/assets/wooden-chair",
  assetDetails = [snapshot({ backend: 1, tag: "main", attributes: { "data-hara-tripo-surface": "asset-detail" } })],
  exportTriggers = [snapshot({ backend: 2, text: "Export", attributes: { "data-hara-tripo-action": "export" } })],
  exportFormats = [
    snapshot({ backend: 3, text: "GLB", attributes: { "data-hara-tripo-export-format": "glb" } }),
    snapshot({ backend: 4, text: "FBX", disabled: true, attributes: {
      "data-hara-tripo-export-format": "fbx",
      "data-unavailable-reason": "Upgrade required",
    } }),
  ],
  exportConfirms = [snapshot({ backend: 5, text: "Download", attributes: { "data-hara-tripo-action": "download" } })],
  exportBlocked = [],
} = {}) {
  let surfaceOpen = false;
  const calls = [];
  const clicks = [];
  const captures = [];
  const selectors = Object.fromEntries(
    Object.keys(TRIPO_SELECTOR_PROFILE.selectors)
      .map((name) => [name, selectorFor(TRIPO_SELECTOR_PROFILE, name)]),
  );
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "query-all") {
        switch (args[0]) {
          case selectors.assetDetail: return assetDetails;
          case selectors.exportSurface: return surfaceOpen
            ? [snapshot({ backend: 6, tag: "div", attributes: { "data-hara-tripo-surface": "export" } })]
            : [];
          case selectors.exportTrigger: return exportTriggers;
          case selectors.exportFormats: return surfaceOpen ? exportFormats : [];
          case selectors.exportConfirm: return surfaceOpen ? exportConfirms : [];
          case selectors.exportBlocked: return exportBlocked;
          default: return [];
        }
      }
      if (method === "click") {
        clicks.push(args[0]);
        if (args[0]?.["backend-node-id"] === 2) surfaceOpen = true;
        return true;
      }
      throw new Error(`unexpected DOM operation: ${method}`);
    },
  };
  const tripoService = {
    async dispatch(method) {
      assert.equal(method, "status");
      return {
        state: "inventory-ready",
        "signed-in?": true,
        "tab-id": 41,
        url,
        origin: "https://studio.tripo3d.ai",
      };
    },
  };
  const downloadBroker = {
    async capture(options, trigger) {
      captures.push(options);
      assert.equal(await trigger(), true);
      return {
        protocol: "greenways.browser-download/0-alpha",
        id: 77,
        state: "complete",
        path: "/Downloads/Greenways/Tripo/Wooden-chair.glb",
        "relative-path": "Greenways/Tripo/Wooden-chair.glb",
        mime: "model/gltf-binary",
        bytes: 1234,
        danger: "safe",
        "exists?": true,
        "started-at": "2026-08-18T00:00:00Z",
        "ended-at": "2026-08-18T00:00:01Z",
        source: { origin: "https://cdn.tripo3d.ai", pathname: "/asset.glb" },
      };
    },
    cancelOwner() { return true; },
  };
  const service = createTripoDownloadService({
    domService,
    tripoService,
    downloadBroker,
    owner: "test-port",
    exportSurfaceTimeoutMs: 100,
    pollIntervalMs: 0,
  });
  return { service, calls, clicks, captures };
}

test("export-options opens the visible export surface and reports plan-aware formats", async () => {
  const env = fixture();
  const options = await env.service.dispatch("export-options", [asset], { tabId: 41 });
  assert.deepEqual(options, [
    {
      format: "glb",
      label: "GLB",
      "available?": true,
      "selected?": false,
      note: null,
      element: { "tab-id": 41, "backend-node-id": 3 },
    },
    {
      format: "fbx",
      label: "FBX",
      "available?": false,
      "selected?": false,
      note: "Upgrade required",
      element: { "tab-id": 41, "backend-node-id": 4 },
    },
  ]);
  assert.deepEqual(env.clicks, [{ "tab-id": 41, "backend-node-id": 2 }]);
});

test("download-asset requires explicit confirmation before page interaction", async () => {
  const env = fixture();
  await assert.rejects(
    env.service.dispatch("download-asset", [{ asset, format: ":glb" }], { tabId: 41 }),
    (error) => error.code === "tripo/download-confirmation-required",
  );
  assert.deepEqual(env.calls, []);
  assert.deepEqual(env.captures, []);
});

test("download-asset selects a visible format and captures the page-initiated download", async () => {
  const env = fixture();
  const receipt = await env.service.dispatch("download-asset", [{
    asset,
    format: ":glb",
    directory: "Greenways/Tripo",
    name: "Wooden chair",
    "confirm-download?": true,
    "timeout-ms": 90000,
  }], { tabId: 41 });
  assert.deepEqual(env.captures, [{
    owner: "test-port",
    tabId: 41,
    origin: "https://studio.tripo3d.ai",
    directory: "Greenways/Tripo",
    name: "Wooden chair",
    format: "glb",
    timeoutMs: 90000,
  }]);
  assert.deepEqual(env.clicks, [
    { "tab-id": 41, "backend-node-id": 2 },
    { "tab-id": 41, "backend-node-id": 3 },
    { "tab-id": 41, "backend-node-id": 5 },
  ]);
  assert.deepEqual(receipt, {
    kind: "asset-download",
    "asset-id": "asset-chair",
    "workspace-id": "personal",
    format: "glb",
    protocol: "greenways.browser-download/0-alpha",
    id: 77,
    state: "complete",
    path: "/Downloads/Greenways/Tripo/Wooden-chair.glb",
    "relative-path": "Greenways/Tripo/Wooden-chair.glb",
    mime: "model/gltf-binary",
    bytes: 1234,
    danger: "safe",
    "exists?": true,
    "started-at": "2026-08-18T00:00:00Z",
    "ended-at": "2026-08-18T00:00:01Z",
    source: { origin: "https://cdn.tripo3d.ai", pathname: "/asset.glb" },
  });
});

test("download requires the exact asset route to already be open", async () => {
  const env = fixture({ url: "https://studio.tripo3d.ai/assets" });
  await assert.rejects(
    env.service.dispatch("export-options", [asset], { tabId: 41 }),
    (error) => error.code === "tripo/asset-not-open",
  );
  assert.deepEqual(env.clicks, []);
});

test("unavailable visible formats fail before arming the download broker", async () => {
  const env = fixture();
  await assert.rejects(
    env.service.dispatch("download-asset", [{
      asset,
      format: ":fbx",
      "confirm-download?": true,
    }], { tabId: 41 }),
    (error) => error.code === "tripo/download-unavailable" && /Upgrade/.test(error.message),
  );
  assert.deepEqual(env.captures, []);
});

test("unknown formats report the exact visible choices", async () => {
  const env = fixture();
  await assert.rejects(
    env.service.dispatch("download-asset", [{
      asset,
      format: ":stl",
      "confirm-download?": true,
    }], { tabId: 41 }),
    (error) => error.code === "tripo/export-format-unavailable"
      && error.data.available.join(",") === "glb,fbx",
  );
});
