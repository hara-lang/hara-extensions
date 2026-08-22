import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDebuggerCoordinator,
  createDomService,
  DOM_DEFAULT_LIMIT,
  DOM_MAX_LIMIT,
} from "../src/dom-service.js";

function eventSource() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
  };
}

function fakeChrome() {
  const onEvent = eventSource();
  const onDetach = eventSource();
  const calls = [];
  let attaches = 0;
  let detaches = 0;
  return {
    calls,
    counts: {
      get attaches() { return attaches; },
      get detaches() { return detaches; },
    },
    tabs: {
      async get(tabId) {
        if (tabId === 404) throw new Error("No tab with given id");
        return { id: tabId, url: `https://target.test/${tabId}` };
      },
    },
    debugger: {
      onEvent,
      onDetach,
      async attach({ tabId }, version) {
        calls.push(["attach", tabId, version]);
        attaches += 1;
      },
      async detach({ tabId }) {
        calls.push(["detach", tabId]);
        detaches += 1;
        onDetach.emit({ tabId }, "target_closed");
      },
      async sendCommand({ tabId }, method, params = {}) {
        calls.push([method, tabId, params]);
        return null;
      },
    },
  };
}

function fakeCoordinator() {
  const calls = [];
  const eventListeners = new Set();
  const detachListeners = new Set();
  const released = [];
  let selectorNodes = {
    "#save": [2],
    ".row": [2, 3, 4],
    ".missing": [],
  };
  let detachedBackend = null;

  const backend = (nodeId) => nodeId + 1000;
  return {
    calls,
    released,
    setSelector(selector, nodes) { selectorNodes = { ...selectorNodes, [selector]: nodes }; },
    setDetached(backendNodeId) { detachedBackend = backendNodeId; },
    emit(method, params = {}) {
      for (const listener of eventListeners) listener({ tabId: 7 }, method, params);
    },
    async acquire(tabId, owner) { calls.push(["acquire", tabId, owner]); return true; },
    async release(tabId, owner) { released.push([tabId, owner]); return true; },
    async releaseOwner() { return true; },
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onDetach(listener) { detachListeners.add(listener); return () => detachListeners.delete(listener); },
    async send(tabId, method, params = {}) {
      calls.push([method, tabId, params]);
      switch (method) {
        case "DOM.enable":
        case "Page.enable":
        case "Runtime.enable":
        case "DOM.focus":
        case "DOM.scrollIntoViewIfNeeded":
        case "Input.dispatchMouseEvent":
        case "Runtime.releaseObject":
        case "Runtime.releaseObjectGroup":
          return null;
        case "DOM.getDocument":
          return { root: { nodeId: 1 } };
        case "DOM.querySelector": {
          if (params.selector === "[") throw new Error("DOM Error while querying");
          return { nodeId: selectorNodes[params.selector]?.[0] ?? 0 };
        }
        case "DOM.querySelectorAll": {
          if (params.selector === "[") throw new Error("DOM Error while querying");
          return { nodeIds: selectorNodes[params.selector] ?? [] };
        }
        case "DOM.describeNode": {
          const backendNodeId = params.backendNodeId ?? backend(params.nodeId);
          if (backendNodeId === detachedBackend) throw new Error("Could not find node");
          return {
            node: {
              nodeId: params.nodeId ?? backendNodeId - 1000,
              backendNodeId,
              nodeName: "BUTTON",
            },
          };
        }
        case "DOM.resolveNode":
          if (params.backendNodeId === detachedBackend) throw new Error("Could not find node");
          return { object: { objectId: `object-${params.backendNodeId}` } };
        case "Runtime.callFunctionOn":
          if (params.functionDeclaration.includes("isContentEditable")) {
            return { result: { value: { ok: true } } };
          }
          return {
            result: {
              value: {
                tag: "button",
                text: "Save",
                attributes: { id: "save", class: "row" },
                value: "",
                checked: false,
                disabled: false,
              },
            },
          };
        case "DOM.getBoxModel":
          return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
        default:
          throw new Error(`unexpected command: ${method}`);
      }
    },
  };
}

test("debugger coordinator reference-counts attachment owners idempotently", async () => {
  const chrome = fakeChrome();
  const coordinator = createDebuggerCoordinator(chrome);
  await coordinator.acquire(7, "dom");
  await coordinator.acquire(7, "dom");
  await coordinator.acquire(7, "legacy");
  assert.equal(chrome.counts.attaches, 1);
  await coordinator.release(7, "dom");
  assert.equal(chrome.counts.detaches, 0);
  await coordinator.release(7, "legacy");
  await coordinator.release(7, "legacy");
  assert.equal(chrome.counts.detaches, 1);
  await coordinator.close();
});

test("hara.dom validates requests and returns bounded serializable snapshots", async () => {
  assert.equal(DOM_DEFAULT_LIMIT, 100);
  assert.equal(DOM_MAX_LIMIT, 1000);
  const coordinator = fakeCoordinator();
  const service = createDomService({
    chromeApi: fakeChrome(),
    coordinator,
    owner: "test-panel",
  });
  const target = { tabId: 7 };

  assert.deepEqual(await service.dispatch("target", [], target), {
    "tab-id": 7,
    url: "https://target.test/7",
  });
  assert.equal(await service.dispatch("query", [".missing"], target), null);
  const element = await service.dispatch("query", ["#save"], target);
  assert.deepEqual(element, {
    "tab-id": 7,
    "backend-node-id": 1002,
    tag: "button",
    text: "Save",
    attributes: { id: "save", class: "row" },
    value: "",
    checked: false,
    disabled: false,
  });
  const rows = await service.dispatch("query-all", [".row", 3], target);
  assert.equal(rows.length, 3);

  await assert.rejects(
    service.dispatch("query", ["["], target),
    /dom\/invalid-selector/,
  );
  await assert.rejects(
    service.dispatch("query-all", [".row", 2], target),
    /dom\/result-limit/,
  );
  await assert.rejects(
    service.dispatch("query-all", [".row", 1001], target),
    /dom\/invalid-limit/,
  );
  await assert.rejects(
    service.dispatch("query", [], target),
    /dom\/invalid-request/,
  );
  await assert.rejects(
    service.dispatch("target", [], { tabId: 404 }),
    /dom\/missing-target/,
  );

  await Promise.all([service.close(), service.close()]);
  assert.equal(coordinator.released.length, 1);
});

test("focus, fill, click, detach, detached nodes, and navigation invalidation are distinct", async () => {
  const coordinator = fakeCoordinator();
  const service = createDomService({
    chromeApi: fakeChrome(),
    coordinator,
    owner: "interaction-panel",
  });
  const target = { tabId: 7 };
  const element = await service.dispatch("query", ["#save"], target);

  assert.equal(await service.dispatch("focus", [element], target), true);
  assert.equal(await service.dispatch("fill", [element, "new value"], target), true);
  assert.equal(await service.dispatch("click", [element], target), true);
  const mouse = coordinator.calls.filter(([method]) => method === "Input.dispatchMouseEvent");
  assert.deepEqual(mouse.map(([, , params]) => params.type), [
    "mouseMoved",
    "mousePressed",
    "mouseReleased",
  ]);

  coordinator.setDetached(element["backend-node-id"]);
  await assert.rejects(
    service.dispatch("refresh", [element], target),
    /dom\/detached-node/,
  );

  coordinator.setDetached(null);
  const fresh = await service.dispatch("query", ["#save"], target);
  coordinator.emit("Page.frameNavigated", { frame: { id: "top" } });
  await assert.rejects(
    service.dispatch("refresh", [fresh], target),
    /dom\/navigation-invalidated/,
  );

  assert.equal(await service.dispatch("detach", [], target), true);
  assert.equal(await service.dispatch("detach", [], target), true);
  await service.close();
});
