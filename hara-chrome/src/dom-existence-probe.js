function errorText(error) {
  return String(error?.message ?? error ?? "unknown DOM error");
}

export class DomExistenceError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "DomExistenceError";
    this.code = code;
    this.data = data;
  }
}

function checkedTabId(target) {
  const tabId = Number(target?.tabId ?? target?.["tab-id"]);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new DomExistenceError("dom/missing-target", "existence probe requires a live panel-bound tab", {
      tabId: target?.tabId ?? target?.["tab-id"] ?? null,
    });
  }
  return tabId;
}

function checkedSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new DomExistenceError("dom/invalid-selector", "selector must be a non-empty string");
  }
  return selector;
}

/**
 * Narrow CDP existence probe for sensitive login surfaces. It never resolves a
 * node into a Runtime object and therefore never mirrors credential values.
 */
export function createDomExistenceProbe({
  coordinator,
  owner,
} = {}) {
  if (!coordinator || typeof coordinator.acquire !== "function" || typeof coordinator.send !== "function") {
    throw new TypeError("createDomExistenceProbe requires a debugger coordinator");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new TypeError("createDomExistenceProbe requires a non-empty owner");
  }
  const leaseOwner = `${owner}:dom-existence`;
  const leasedTabs = new Set();
  let closed = false;

  async function queryExists(selector, target) {
    if (closed) throw new DomExistenceError("dom/closed", "existence probe has been closed");
    selector = checkedSelector(selector);
    const tabId = checkedTabId(target);
    await coordinator.acquire(tabId, leaseOwner);
    leasedTabs.add(tabId);
    await coordinator.send(tabId, "DOM.enable", { includeWhitespace: "none" });
    const document = await coordinator.send(tabId, "DOM.getDocument", { depth: 0, pierce: false });
    const nodeId = Number(document?.root?.nodeId);
    if (!Number.isInteger(nodeId) || nodeId <= 0) {
      throw new DomExistenceError("dom/protocol", "DOM.getDocument omitted the root node", { tabId });
    }
    try {
      const response = await coordinator.send(tabId, "DOM.querySelector", { nodeId, selector });
      return Number(response?.nodeId ?? 0) > 0;
    } catch (error) {
      throw new DomExistenceError("dom/invalid-selector", `invalid CSS selector ${JSON.stringify(selector)}`, {
        selector,
        cause: errorText(error),
      });
    }
  }

  return {
    async dispatch(method, args = [], target = null) {
      if (method !== "query-exists" || !Array.isArray(args) || args.length !== 1) {
        throw new DomExistenceError("dom/invalid-request", "existence probe accepts query-exists with one selector");
      }
      return queryExists(args[0], target);
    },
    queryExists,
    async close() {
      if (closed) return true;
      closed = true;
      const failures = [];
      for (const tabId of [...leasedTabs]) {
        try { await coordinator.release(tabId, leaseOwner); } catch (error) { failures.push(error); }
      }
      leasedTabs.clear();
      if (failures.length) throw new AggregateError(failures, "DOM existence probe shutdown failed");
      return true;
    },
  };
}
