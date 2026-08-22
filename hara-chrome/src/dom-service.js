const DEBUGGER_PROTOCOL_VERSION = "1.3";
export const DOM_DEFAULT_LIMIT = 100;
export const DOM_MAX_LIMIT = 1000;

const SNAPSHOT_FUNCTION = `function () {
  const attributes = Object.create(null);
  for (const attribute of Array.from(this.attributes || [])) {
    attributes[attribute.name] = attribute.value;
  }
  const tag = typeof this.tagName === "string" ? this.tagName.toLowerCase() : null;
  const text = this.innerText ?? this.textContent ?? "";
  return {
    tag,
    text: String(text),
    attributes,
    value: "value" in this ? String(this.value ?? "") : null,
    checked: "checked" in this ? Boolean(this.checked) : null,
    disabled: "disabled" in this ? Boolean(this.disabled) : null,
  };
}`;

const FILL_FUNCTION = `function (nextValue) {
  const value = String(nextValue);
  const tag = String(this.tagName || "").toLowerCase();
  let prototype = null;
  if (tag === "input") prototype = HTMLInputElement.prototype;
  else if (tag === "textarea") prototype = HTMLTextAreaElement.prototype;
  else if (tag === "select") prototype = HTMLSelectElement.prototype;

  if (prototype) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor && typeof descriptor.set === "function") descriptor.set.call(this, value);
      else this.value = value;
    } catch {
      return { ok: false, code: "dom/unsupported-fill-target" };
    }
  } else if (this.isContentEditable) {
    this.focus();
    this.textContent = value;
  } else {
    return { ok: false, code: "dom/unsupported-fill-target" };
  }

  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { ok: true };
}`;

function errorText(error) {
  return String(error?.message ?? error ?? "unknown DOM error");
}

export class DomError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "DomError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = {}) {
  throw new DomError(code, message, data);
}

function checkedTabId(value) {
  const tabId = Number(value);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    fail("dom/missing-target", "the panel is not bound to a live Chrome tab", { tabId: value });
  }
  return tabId;
}

function checkedOwner(owner) {
  if (typeof owner !== "string" || owner.length === 0) {
    throw new TypeError("debugger owner must be a non-empty string");
  }
  return owner;
}

function checkedSelector(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("dom/invalid-selector", "selector must be a non-empty string");
  }
  return value;
}

function checkedLimit(value) {
  const limit = value === undefined || value === null ? DOM_DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > DOM_MAX_LIMIT) {
    fail(
      "dom/invalid-limit",
      `query-all limit must be an integer from 1 to ${DOM_MAX_LIMIT}`,
      { limit: value },
    );
  }
  return limit;
}

function checkedArguments(method, args, minimum, maximum = minimum) {
  if (!Array.isArray(args) || args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    fail("dom/invalid-request", `${method} expects ${expected} argument(s)`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * One debugger attachment is shared by the closed DOM service and the legacy
 * chrome.debugger facade. Attach/detach calls are reference counted by owner so
 * an explicit DOM detach cannot tear down another in-extension consumer.
 */
export function createDebuggerCoordinator(chromeApi = globalThis.chrome) {
  if (!chromeApi?.debugger) throw new TypeError("chrome.debugger is unavailable");
  const states = new Map();
  const eventListeners = new Set();
  const detachListeners = new Set();

  const stateFor = (tabId) => {
    let state = states.get(tabId);
    if (!state) {
      state = {
        attached: false,
        ownedAttachment: false,
        attachPromise: null,
        owners: new Set(),
      };
      states.set(tabId, state);
    }
    return state;
  };

  const onEvent = (source, method, params) => {
    for (const listener of eventListeners) listener(source, method, params);
  };
  const onDetach = (source, reason) => {
    const state = states.get(source.tabId);
    if (state) {
      state.attached = false;
      state.ownedAttachment = false;
      state.attachPromise = null;
      state.owners.clear();
    }
    for (const listener of detachListeners) listener(source, reason);
  };
  chromeApi.debugger.onEvent?.addListener(onEvent);
  chromeApi.debugger.onDetach?.addListener(onDetach);

  async function acquire(rawTabId, rawOwner) {
    const tabId = checkedTabId(rawTabId);
    const owner = checkedOwner(rawOwner);
    const state = stateFor(tabId);
    if (state.attached && state.owners.has(owner)) return true;

    if (!state.attached) {
      state.attachPromise ??= (async () => {
        try {
          await chromeApi.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION);
          state.ownedAttachment = true;
        } catch (attachError) {
          // A service worker restart or the legacy facade may already own this
          // extension's debugger connection. Probe it rather than detaching it.
          try {
            await chromeApi.debugger.sendCommand({ tabId }, "Runtime.enable", {});
            state.ownedAttachment = false;
          } catch {
            throw new DomError(
              "dom/debugger-unavailable",
              errorText(attachError),
              { tabId },
            );
          }
        }
        state.attached = true;
      })();
      try {
        await state.attachPromise;
      } finally {
        state.attachPromise = null;
      }
    }
    state.owners.add(owner);
    return true;
  }

  async function release(rawTabId, rawOwner) {
    const tabId = checkedTabId(rawTabId);
    const owner = checkedOwner(rawOwner);
    const state = states.get(tabId);
    if (!state) return true;
    if (state.attachPromise) {
      try { await state.attachPromise; } catch { /* attachment already failed */ }
    }
    state.owners.delete(owner);
    if (state.owners.size > 0 || !state.attached) return true;

    const detach = state.ownedAttachment;
    state.attached = false;
    state.ownedAttachment = false;
    if (detach) {
      try {
        await chromeApi.debugger.detach({ tabId });
      } catch (error) {
        if (!/not attached|No tab with given id/i.test(errorText(error))) throw error;
      }
    }
    states.delete(tabId);
    return true;
  }

  async function releaseOwner(rawOwner) {
    const owner = checkedOwner(rawOwner);
    const tabs = [...states.entries()]
      .filter(([, state]) => state.owners.has(owner))
      .map(([tabId]) => tabId);
    const failures = [];
    for (const tabId of tabs) {
      try { await release(tabId, owner); } catch (error) { failures.push(error); }
    }
    if (failures.length) {
      throw new AggregateError(failures, `failed to release debugger owner ${owner}`);
    }
    return true;
  }

  async function send(rawTabId, method, params = {}) {
    const tabId = checkedTabId(rawTabId);
    return (await chromeApi.debugger.sendCommand({ tabId }, method, params)) ?? null;
  }

  return {
    acquire,
    release,
    releaseOwner,
    send,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onDetach(listener) {
      detachListeners.add(listener);
      return () => detachListeners.delete(listener);
    },
    async close() {
      const owners = new Set(
        [...states.values()].flatMap((state) => [...state.owners]),
      );
      const failures = [];
      for (const owner of owners) {
        try { await releaseOwner(owner); } catch (error) { failures.push(error); }
      }
      chromeApi.debugger.onEvent?.removeListener?.(onEvent);
      chromeApi.debugger.onDetach?.removeListener?.(onDetach);
      eventListeners.clear();
      detachListeners.clear();
      if (failures.length) throw new AggregateError(failures, "debugger coordinator close failed");
    },
    _states: states,
  };
}

function targetTabId(target) {
  if (target && typeof target === "object") {
    return checkedTabId(target.tabId ?? target["tab-id"]);
  }
  return checkedTabId(null);
}

function objectValue(response, operation) {
  if (response?.exceptionDetails) {
    fail("dom/protocol", `${operation} failed: ${response.exceptionDetails.text ?? "exception"}`);
  }
  return response?.result?.value;
}

function snapshotReference(reference, tabId) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
    fail("dom/invalid-reference", "element reference must be a snapshot map");
  }
  const referencedTab = Number(reference["tab-id"] ?? reference.tabId);
  const backendNodeId = Number(reference["backend-node-id"] ?? reference.backendNodeId);
  if (!Number.isInteger(referencedTab) || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("dom/invalid-reference", "element reference is missing tab-id or backend-node-id");
  }
  if (referencedTab !== tabId) {
    fail("dom/invalid-reference", "element reference belongs to another target", {
      expectedTabId: tabId,
      actualTabId: referencedTab,
    });
  }
  return backendNodeId;
}

function navigationEvent(method, params) {
  return method === "DOM.documentUpdated"
    || (method === "Page.frameNavigated" && !params?.frame?.parentId);
}

/** Closed, fixed-operation DOM service exposed only as hara.dom. */
export function createDomService({
  chromeApi = globalThis.chrome,
  coordinator = createDebuggerCoordinator(chromeApi),
  owner = `hara-dom-${Math.random().toString(36).slice(2)}`,
} = {}) {
  const leaseOwner = `${checkedOwner(owner)}:dom`;
  const states = new Map();
  const leasedTabs = new Set();
  let closePromise = null;
  let closed = false;

  const stateFor = (tabId) => {
    let state = states.get(tabId);
    if (!state) {
      state = {
        generation: 1,
        enabled: false,
        rootNodeId: null,
        references: new Map(),
        objectGroup: `hara-dom-${tabId}`,
      };
      states.set(tabId, state);
    }
    return state;
  };

  const invalidate = (tabId) => {
    const state = stateFor(tabId);
    state.generation += 1;
    state.rootNodeId = null;
  };

  const removeEventListener = coordinator.onEvent((source, method, params) => {
    if (leasedTabs.has(source.tabId) && navigationEvent(method, params)) {
      invalidate(source.tabId);
    }
  });
  const removeDetachListener = coordinator.onDetach((source) => {
    const state = states.get(source.tabId);
    if (state) {
      state.enabled = false;
      state.rootNodeId = null;
    }
  });

  async function tabInfo(tabId) {
    try {
      const tab = await chromeApi.tabs.get(tabId);
      if (!tab) fail("dom/missing-target", `Chrome tab ${tabId} does not exist`, { tabId });
      return tab;
    } catch (error) {
      if (error instanceof DomError) throw error;
      fail("dom/missing-target", `Chrome tab ${tabId} does not exist`, {
        tabId,
        cause: errorText(error),
      });
    }
  }

  async function ensureAttached(tabId) {
    if (closed) fail("dom/closed", "DOM service has been closed");
    await tabInfo(tabId);
    await coordinator.acquire(tabId, leaseOwner);
    leasedTabs.add(tabId);
    const state = stateFor(tabId);
    if (!state.enabled) {
      await coordinator.send(tabId, "DOM.enable", { includeWhitespace: "none" });
      await coordinator.send(tabId, "Page.enable", {});
      await coordinator.send(tabId, "Runtime.enable", {});
      state.enabled = true;
    }
    return state;
  }

  async function rootNode(tabId, state) {
    if (state.rootNodeId) return state.rootNodeId;
    const response = await coordinator.send(tabId, "DOM.getDocument", {
      depth: 0,
      pierce: false,
    });
    const nodeId = Number(response?.root?.nodeId);
    if (!Number.isInteger(nodeId) || nodeId <= 0) {
      fail("dom/protocol", "DOM.getDocument did not return a root node", { tabId });
    }
    state.rootNodeId = nodeId;
    return nodeId;
  }

  async function fixedCall(tabId, backendNodeId, functionDeclaration, args = []) {
    let objectId = null;
    const state = stateFor(tabId);
    try {
      const resolved = await coordinator.send(tabId, "DOM.resolveNode", {
        backendNodeId,
        objectGroup: state.objectGroup,
      });
      objectId = resolved?.object?.objectId ?? null;
      if (!objectId) fail("dom/detached-node", "node no longer resolves in the target document");
      const response = await coordinator.send(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false,
        silent: true,
      });
      return objectValue(response, "Runtime.callFunctionOn");
    } catch (error) {
      if (error instanceof DomError) throw error;
      fail("dom/detached-node", "node no longer resolves in the target document", {
        backendNodeId,
        cause: errorText(error),
      });
    } finally {
      if (objectId) {
        try { await coordinator.send(tabId, "Runtime.releaseObject", { objectId }); } catch { /* best effort */ }
      }
    }
  }

  async function snapshotFromBackend(tabId, backendNodeId, state) {
    try {
      await coordinator.send(tabId, "DOM.describeNode", {
        backendNodeId,
        depth: 0,
        pierce: false,
      });
    } catch (error) {
      fail("dom/detached-node", "node is no longer attached to the document", {
        backendNodeId,
        cause: errorText(error),
      });
    }
    const details = await fixedCall(tabId, backendNodeId, SNAPSHOT_FUNCTION);
    if (!details || typeof details !== "object") {
      fail("dom/protocol", "node snapshot was not serializable", { backendNodeId });
    }
    state.references.set(backendNodeId, state.generation);
    return {
      "tab-id": tabId,
      "backend-node-id": backendNodeId,
      tag: details.tag ?? null,
      text: details.text ?? "",
      attributes: details.attributes ?? {},
      value: details.value ?? null,
      checked: details.checked ?? null,
      disabled: details.disabled ?? null,
    };
  }

  async function snapshotFromNode(tabId, nodeId, state) {
    let description;
    try {
      description = await coordinator.send(tabId, "DOM.describeNode", {
        nodeId,
        depth: 0,
        pierce: false,
      });
    } catch (error) {
      fail("dom/detached-node", "query result was detached before it could be mirrored", {
        nodeId,
        cause: errorText(error),
      });
    }
    const backendNodeId = Number(description?.node?.backendNodeId);
    if (!Number.isInteger(backendNodeId) || backendNodeId <= 0) {
      fail("dom/protocol", "DOM.describeNode omitted backendNodeId", { nodeId });
    }
    return snapshotFromBackend(tabId, backendNodeId, state);
  }

  async function checkedReference(tabId, reference) {
    const state = await ensureAttached(tabId);
    const backendNodeId = snapshotReference(reference, tabId);
    const generation = state.references.get(backendNodeId);
    if (generation === undefined) {
      fail("dom/invalid-reference", "element reference was not issued by this panel", {
        tabId,
        backendNodeId,
      });
    }
    if (generation !== state.generation) {
      fail("dom/navigation-invalidated", "navigation invalidated the element reference", {
        tabId,
        backendNodeId,
      });
    }
    return { backendNodeId, state };
  }

  async function target(tabId) {
    const tab = await tabInfo(tabId);
    return { "tab-id": tabId, url: tab.url ?? "" };
  }

  async function query(tabId, selector) {
    selector = checkedSelector(selector);
    const state = await ensureAttached(tabId);
    const nodeId = await rootNode(tabId, state);
    let response;
    try {
      response = await coordinator.send(tabId, "DOM.querySelector", { nodeId, selector });
    } catch (error) {
      fail("dom/invalid-selector", `invalid CSS selector ${JSON.stringify(selector)}`, {
        selector,
        cause: errorText(error),
      });
    }
    const result = Number(response?.nodeId ?? 0);
    return result > 0 ? snapshotFromNode(tabId, result, state) : null;
  }

  async function queryAll(tabId, selector, rawLimit) {
    selector = checkedSelector(selector);
    const limit = checkedLimit(rawLimit);
    const state = await ensureAttached(tabId);
    const nodeId = await rootNode(tabId, state);
    let response;
    try {
      response = await coordinator.send(tabId, "DOM.querySelectorAll", { nodeId, selector });
    } catch (error) {
      fail("dom/invalid-selector", `invalid CSS selector ${JSON.stringify(selector)}`, {
        selector,
        cause: errorText(error),
      });
    }
    const nodeIds = Array.isArray(response?.nodeIds) ? response.nodeIds : [];
    if (nodeIds.length > limit) {
      fail("dom/result-limit", `selector matched ${nodeIds.length} nodes; limit is ${limit}`, {
        selector,
        count: nodeIds.length,
        limit,
      });
    }
    const values = [];
    for (const resultNodeId of nodeIds) {
      values.push(await snapshotFromNode(tabId, resultNodeId, state));
    }
    return values;
  }

  async function refresh(tabId, reference) {
    const { backendNodeId, state } = await checkedReference(tabId, reference);
    return snapshotFromBackend(tabId, backendNodeId, state);
  }

  async function focus(tabId, reference) {
    const { backendNodeId } = await checkedReference(tabId, reference);
    try {
      await coordinator.send(tabId, "DOM.focus", { backendNodeId });
      return true;
    } catch (error) {
      fail("dom/detached-node", "node cannot be focused because it is detached", {
        backendNodeId,
        cause: errorText(error),
      });
    }
  }

  async function fill(tabId, reference, value) {
    if (typeof value !== "string") fail("dom/invalid-request", "fill value must be a string");
    const { backendNodeId } = await checkedReference(tabId, reference);
    const result = await fixedCall(tabId, backendNodeId, FILL_FUNCTION, [value]);
    if (!result?.ok) {
      fail(result?.code ?? "dom/unsupported-fill-target", "element cannot be filled");
    }
    return true;
  }

  async function click(tabId, reference) {
    const { backendNodeId } = await checkedReference(tabId, reference);
    try {
      await coordinator.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const response = await coordinator.send(tabId, "DOM.getBoxModel", { backendNodeId });
      const quad = response?.model?.content ?? response?.model?.border;
      if (!Array.isArray(quad) || quad.length !== 8) {
        fail("dom/not-interactable", "element has no clickable box", { backendNodeId });
      }
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
      await coordinator.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      });
      await coordinator.send(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await coordinator.send(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      return true;
    } catch (error) {
      if (error instanceof DomError) throw error;
      fail("dom/detached-node", "node cannot be clicked because it is detached", {
        backendNodeId,
        cause: errorText(error),
      });
    }
  }

  async function detach(tabId) {
    const state = states.get(tabId);
    if (state) {
      try {
        await coordinator.send(tabId, "Runtime.releaseObjectGroup", {
          objectGroup: state.objectGroup,
        });
      } catch { /* debugger may already be detached */ }
      state.enabled = false;
      state.rootNodeId = null;
    }
    if (leasedTabs.delete(tabId)) await coordinator.release(tabId, leaseOwner);
    return true;
  }

  async function dispatch(method, args = [], targetMetadata = null) {
    if (closed && method !== "detach") fail("dom/closed", "DOM service has been closed");
    const tabId = targetTabId(targetMetadata);
    switch (method) {
      case "target":
        checkedArguments(method, args, 0);
        return target(tabId);
      case "query":
        checkedArguments(method, args, 1);
        return query(tabId, args[0]);
      case "query-all":
        checkedArguments(method, args, 1, 2);
        return queryAll(tabId, args[0], args[1]);
      case "refresh":
        checkedArguments(method, args, 1);
        return refresh(tabId, args[0]);
      case "focus":
        checkedArguments(method, args, 1);
        return focus(tabId, args[0]);
      case "fill":
        checkedArguments(method, args, 2);
        return fill(tabId, args[0], args[1]);
      case "click":
        checkedArguments(method, args, 1);
        return click(tabId, args[0]);
      case "detach":
        checkedArguments(method, args, 0);
        return detach(tabId);
      default:
        fail("dom/unknown-operation", `unknown hara.dom operation: ${method}`);
    }
  }

  function close() {
    closePromise ??= (async () => {
      if (closed) return;
      closed = true;
      removeEventListener();
      removeDetachListener();
      const failures = [];
      for (const tabId of [...leasedTabs]) {
        try { await detach(tabId); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "hara.dom shutdown failed");
    })();
    return closePromise;
  }

  return {
    dispatch,
    close,
    target,
    query,
    queryAll,
    refresh,
    focus,
    fill,
    click,
    detach,
    _states: states,
  };
}
