import { CHATGPT_SELECTOR_PROFILE, selectorFor } from "./chatgpt-profile.js";

export const CHATGPT_REPL_PROTOCOL = "greenways.chatgpt-web-repl/0-alpha";
export const CHATGPT_INVENTORY_LIMIT = 1000;
export const CHATGPT_SEARCH_LIMIT = 100;
export const CHATGPT_SEARCH_QUERY_LIMIT = 500;

export class ChatgptError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "ChatgptError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = {}) {
  throw new ChatgptError(code, message, data);
}

function checkedArguments(method, args, minimum, maximum = minimum) {
  if (!Array.isArray(args) || args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    fail("chatgpt/invalid-request", `${method} expects ${expected} argument(s)`);
  }
}

function attributes(snapshot) {
  return snapshot?.attributes && typeof snapshot.attributes === "object"
    ? snapshot.attributes
    : {};
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truthyAttribute(value) {
  return ["true", "page", "yes", "1"].includes(String(value ?? "").toLowerCase());
}

function elementReference(snapshot) {
  const tabId = Number(snapshot?.["tab-id"] ?? snapshot?.tabId);
  const backendNodeId = Number(snapshot?.["backend-node-id"] ?? snapshot?.backendNodeId);
  if (!Number.isInteger(tabId) || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("chatgpt/entity-invalid", "DOM snapshot is missing an opaque element reference");
  }
  return {
    "tab-id": tabId,
    "backend-node-id": backendNodeId,
  };
}

function routeFor(rawHref, pageUrl) {
  if (typeof rawHref !== "string" || rawHref.trim().length === 0) return null;
  let parsed;
  let page;
  try {
    page = new URL(pageUrl);
    parsed = new URL(rawHref, page);
  } catch {
    return null;
  }
  if (parsed.origin !== page.origin) return null;
  return {
    href: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    pathname: parsed.pathname,
  };
}

function titleFor(snapshot) {
  const attrs = attributes(snapshot);
  return compactText(
    attrs["data-hara-chatgpt-title"]
      ?? attrs["aria-label"]
      ?? attrs.title
      ?? snapshot?.text,
  );
}

function isChatPath(pathname) {
  return /^\/c\/[^/]+/.test(pathname) || /\/c\/[^/]+/.test(pathname);
}

function navigationScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"]).toLowerCase();
  let score = 0;
  if (truthyAttribute(attrs["data-hara-chatgpt-navigation"])) score += 100;
  if (label.includes("chatgpt")) score += 60;
  if (label.includes("chat")) score += 40;
  if (label.includes("history")) score += 30;
  if (String(attrs.role ?? "").toLowerCase() === "navigation") score += 20;
  if (String(snapshot?.tag ?? "").toLowerCase() === "nav") score += 10;
  return score;
}

function controlScore(snapshot, kind) {
  const attrs = attributes(snapshot);
  const label = compactText(
    attrs["aria-label"]
      ?? attrs.placeholder
      ?? attrs.title
      ?? snapshot?.text,
  ).toLowerCase();
  const tag = String(snapshot?.tag ?? "").toLowerCase();
  const role = String(attrs.role ?? "").toLowerCase();
  let score = 0;
  if (kind === "search-trigger" && attrs["data-hara-chatgpt-action"] === "search") score += 100;
  if (kind === "search-input" && truthyAttribute(attrs["data-hara-chatgpt-search-input"])) score += 100;
  if (label.includes("search chat")) score += 60;
  else if (label.includes("search")) score += 40;
  if (kind === "search-trigger" && (tag === "button" || role === "button")) score += 20;
  if (kind === "search-input" && (tag === "input" || role === "searchbox")) score += 20;
  if (kind === "search-input" && String(attrs.type ?? "").toLowerCase() === "search") score += 10;
  return score;
}

function chooseRanked(candidates, kind, score, { optional = false } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (optional) return null;
    fail("chatgpt/ui-unsupported", `ChatGPT ${kind} was not found`);
  }
  const ranked = candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    fail("chatgpt/ui-unsupported", `ChatGPT ${kind} is ambiguous`, {
      candidates: ranked.length,
      score: ranked[0].score,
    });
  }
  return ranked[0].candidate;
}

function chooseNavigation(candidates) {
  return chooseRanked(candidates, "navigation landmark", navigationScore);
}

function uniqueByKey(values, key, kind) {
  const seen = new Map();
  for (const value of values) {
    const identity = value[key];
    if (seen.has(identity)) {
      fail("chatgpt/duplicate-identity", `duplicate ${kind} identity: ${identity}`, {
        kind,
        id: identity,
      });
    }
    seen.set(identity, value);
  }
  return values;
}

function chatFromSnapshot(snapshot, target, pinnedIds, pinnedHrefs) {
  const attrs = attributes(snapshot);
  const route = routeFor(attrs.href, target.url);
  const explicit = String(attrs["data-hara-chatgpt-kind"] ?? "") === "chat";
  if (!route || (!explicit && !isChatPath(route.pathname))) return null;
  const id = compactText(
    attrs["data-hara-chatgpt-id"]
      ?? attrs["data-chat-id"]
      ?? route.href,
  );
  const title = titleFor(snapshot);
  if (!id || !title) {
    fail("chatgpt/entity-invalid", "chat candidate is missing a stable identity or title", {
      href: route.href,
    });
  }
  return {
    kind: "chat",
    id,
    title,
    href: route.href,
    "pinned?": truthyAttribute(attrs["data-hara-chatgpt-pinned"])
      || pinnedIds.has(id)
      || pinnedHrefs.has(route.href),
    "project-id": compactText(attrs["data-project-id"]) || null,
    "active?": truthyAttribute(attrs["aria-current"])
      || truthyAttribute(attrs["data-active"]),
    element: elementReference(snapshot),
  };
}

function projectFromSnapshot(snapshot, target) {
  const attrs = attributes(snapshot);
  const route = routeFor(attrs.href, target.url);
  if (!route || isChatPath(route.pathname) || route.pathname === "/") return null;
  const id = compactText(
    attrs["data-hara-chatgpt-id"]
      ?? attrs["data-project-id"]
      ?? route.href,
  );
  const title = titleFor(snapshot);
  if (!id || !title) {
    fail("chatgpt/entity-invalid", "project candidate is missing a stable identity or title", {
      href: route.href,
    });
  }
  return {
    kind: "project",
    id,
    title,
    href: route.href,
    "active?": truthyAttribute(attrs["aria-current"])
      || truthyAttribute(attrs["data-active"]),
    element: elementReference(snapshot),
  };
}

function searchResultFromSnapshot(snapshot, target, query) {
  const attrs = attributes(snapshot);
  const route = routeFor(attrs.href, target.url);
  if (!route || !isChatPath(route.pathname)) return null;
  const chatId = compactText(
    attrs["data-hara-chatgpt-id"]
      ?? attrs["data-chat-id"]
      ?? route.href,
  );
  const title = titleFor(snapshot);
  if (!chatId || !title) {
    fail("chatgpt/entity-invalid", "search result is missing chat identity or title", {
      href: route.href,
    });
  }
  const rawSnippet = compactText(
    attrs["data-hara-chatgpt-snippet"]
      ?? attrs["data-snippet"]
      ?? snapshot?.text,
  );
  const snippet = rawSnippet === title
    ? ""
    : compactText(rawSnippet.startsWith(title) ? rawSnippet.slice(title.length) : rawSnippet);
  return {
    kind: "chat-search-result",
    "chat-id": chatId,
    title,
    snippet,
    href: route.href,
    query,
    element: elementReference(snapshot),
  };
}

function checkedEntity(value, expectedKind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("chatgpt/entity-invalid", `${expectedKind} must be a snapshot map`);
  }
  const suppliedKind = String(value.kind ?? "").replace(/^:/, "");
  if (suppliedKind && suppliedKind !== expectedKind) {
    fail("chatgpt/entity-invalid", `expected ${expectedKind}, received ${suppliedKind}`);
  }
  const id = compactText(value.id);
  const href = compactText(value.href);
  if (!id && !href) {
    fail("chatgpt/entity-invalid", `${expectedKind} snapshot requires id or href`);
  }
  return { id, href };
}

function checkedSearchQuery(value) {
  if (typeof value !== "string") {
    fail("chatgpt/invalid-search-query", "search query must be a string");
  }
  const query = compactText(value);
  if (query.length === 0 || query.length > CHATGPT_SEARCH_QUERY_LIMIT) {
    fail(
      "chatgpt/invalid-search-query",
      `search query must contain 1-${CHATGPT_SEARCH_QUERY_LIMIT} characters`,
      { length: query.length },
    );
  }
  return query;
}

function visibleEmptyState(snapshot) {
  const attrs = attributes(snapshot);
  return !("hidden" in attrs)
    && !truthyAttribute(attrs["aria-hidden"])
    && String(attrs.style ?? "").replace(/\s+/g, "").toLowerCase() !== "display:none";
}

function samePath(pageUrl, routeHref) {
  try {
    return new URL(pageUrl).pathname === new URL(routeHref, pageUrl).pathname;
  } catch {
    return false;
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createChatgptService({
  domService,
  profile = CHATGPT_SELECTOR_PROFILE,
  sleep = defaultSleep,
  now = () => Date.now(),
  searchTimeoutMs = 5000,
  pollIntervalMs = 50,
} = {}) {
  if (!domService || typeof domService.dispatch !== "function") {
    throw new TypeError("createChatgptService requires a DOM service");
  }
  let closed = false;

  async function queryAll(group, target, limit = CHATGPT_INVENTORY_LIMIT) {
    return domService.dispatch(
      "query-all",
      [selectorFor(profile, group), limit],
      target,
    );
  }

  async function verifiedTarget(target) {
    if (closed) fail("chatgpt/closed", "ChatGPT service has been closed");
    const info = await domService.dispatch("target", [], target);
    let parsed;
    try {
      parsed = new URL(String(info?.url ?? ""));
    } catch {
      fail("chatgpt/missing-target", "the panel-bound target has no valid URL");
    }
    if (!profile.origins.includes(parsed.origin)) {
      fail("chatgpt/unsupported-origin", `unsupported ChatGPT origin: ${parsed.origin}`, {
        origin: parsed.origin,
        allowed: [...profile.origins],
      });
    }
    const tabId = Number(info?.["tab-id"] ?? info?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      fail("chatgpt/missing-target", "the panel-bound target has no live Chrome tab ID", {
        tabId: info?.["tab-id"] ?? info?.tabId ?? null,
      });
    }
    return {
      "tab-id": tabId,
      url: parsed.href,
      origin: parsed.origin,
    };
  }

  async function status(target) {
    const info = await verifiedTarget(target);
    const signedOut = await queryAll("signedOut", target, 20);
    if (signedOut.length > 0) {
      return {
        protocol: CHATGPT_REPL_PROTOCOL,
        state: "signed-out",
        "signed-in?": false,
        ...info,
        profile: {
          id: profile.id,
          version: profile.version,
          locale: profile.locale,
        },
        navigation: null,
      };
    }
    const navigation = chooseNavigation(await queryAll("navigation", target, 20));
    return {
      protocol: CHATGPT_REPL_PROTOCOL,
      state: "inventory-ready",
      "signed-in?": true,
      ...info,
      profile: {
        id: profile.id,
        version: profile.version,
        locale: profile.locale,
      },
      navigation: elementReference(navigation),
    };
  }

  async function requireInventoryTarget(target) {
    const current = await status(target);
    if (!current["signed-in?"]) {
      fail("chatgpt/signed-out", "the bound ChatGPT page is not signed in");
    }
    return current;
  }

  async function chats(target) {
    const current = await requireInventoryTarget(target);
    const pinnedSnapshots = await queryAll("pinned", target);
    const pinnedIds = new Set();
    const pinnedHrefs = new Set();
    for (const snapshot of pinnedSnapshots) {
      const attrs = attributes(snapshot);
      const route = routeFor(attrs.href, current.url);
      if (!route) continue;
      pinnedHrefs.add(route.href);
      const id = compactText(
        attrs["data-hara-chatgpt-id"]
          ?? attrs["data-chat-id"]
          ?? route.href,
      );
      if (id) pinnedIds.add(id);
    }
    const values = (await queryAll("chats", target))
      .map((snapshot) => chatFromSnapshot(snapshot, current, pinnedIds, pinnedHrefs))
      .filter(Boolean);
    return uniqueByKey(values, "id", "chat");
  }

  async function pinned(target) {
    return (await chats(target)).filter((chat) => chat["pinned?"] === true);
  }

  async function projects(target) {
    const current = await requireInventoryTarget(target);
    const values = (await queryAll("projects", target))
      .map((snapshot) => projectFromSnapshot(snapshot, current))
      .filter(Boolean);
    return uniqueByKey(values, "id", "project");
  }

  async function resolveEntity(kind, input, target) {
    const identity = checkedEntity(input, kind);
    const values = kind === "chat" ? await chats(target) : await projects(target);
    const matches = values.filter((value) => {
      if (identity.id && value.id !== identity.id) return false;
      if (identity.href && value.href !== identity.href) return false;
      return true;
    });
    if (matches.length === 0) {
      fail("chatgpt/entity-not-found", `${kind} is no longer present in the visible inventory`, identity);
    }
    if (matches.length > 1) {
      fail("chatgpt/duplicate-identity", `${kind} identity resolved more than once`, identity);
    }
    return matches[0];
  }

  async function open(kind, input, target) {
    const selected = await resolveEntity(kind, input, target);
    const clicked = await domService.dispatch("click", [selected.element], target);
    if (clicked !== true) {
      fail("chatgpt/action-unverified", `${kind} navigation did not complete`, {
        id: selected.id,
        href: selected.href,
      });
    }
    return {
      opened: true,
      kind,
      id: selected.id,
      href: selected.href,
    };
  }

  async function searchControl(group, kind, target, { optional = false } = {}) {
    return chooseRanked(
      await queryAll(group, target, 20),
      kind,
      (snapshot) => controlScore(snapshot, kind),
      { optional },
    );
  }

  async function waitForSearchInput(target) {
    const deadline = now() + searchTimeoutMs;
    do {
      const input = await searchControl("searchInput", "search-input", target, { optional: true });
      if (input) return input;
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    } while (true);
    fail("chatgpt/search-timeout", "ChatGPT search input did not become available", {
      timeoutMs: searchTimeoutMs,
    });
  }

  async function waitForSearchResults(query, current, target) {
    const deadline = now() + searchTimeoutMs;
    do {
      const snapshots = await queryAll("searchResults", target, CHATGPT_SEARCH_LIMIT);
      const values = snapshots
        .map((snapshot) => searchResultFromSnapshot(snapshot, current, query))
        .filter(Boolean);
      if (values.length > 0) {
        return uniqueByKey(values, "chat-id", "chat search result");
      }
      if ((await queryAll("searchEmpty", target, 20)).some(visibleEmptyState)) return [];
      if (now() >= deadline) break;
      await sleep(pollIntervalMs);
    } while (true);
    fail("chatgpt/search-timeout", "ChatGPT search results did not settle", {
      query,
      timeoutMs: searchTimeoutMs,
    });
  }

  async function searchChats(rawQuery, target) {
    const query = checkedSearchQuery(rawQuery);
    const current = await requireInventoryTarget(target);
    let input = await searchControl("searchInput", "search-input", target, { optional: true });
    if (!input) {
      const trigger = await searchControl("searchTrigger", "search-trigger", target);
      const clicked = await domService.dispatch("click", [elementReference(trigger)], target);
      if (clicked !== true) {
        fail("chatgpt/action-unverified", "ChatGPT search control did not open");
      }
      input = await waitForSearchInput(target);
    }
    const reference = elementReference(input);
    if (await domService.dispatch("focus", [reference], target) !== true) {
      fail("chatgpt/action-unverified", "ChatGPT search input could not be focused");
    }
    if (await domService.dispatch("fill", [reference, query], target) !== true) {
      fail("chatgpt/action-unverified", "ChatGPT search input could not be filled", { query });
    }
    return waitForSearchResults(query, current, target);
  }

  async function projectChats(input, target) {
    const current = await requireInventoryTarget(target);
    const selected = await resolveEntity("project", input, target);
    if (!samePath(current.url, selected.href)) {
      fail("chatgpt/project-not-open", "project-chats requires the selected project to be open", {
        id: selected.id,
        href: selected.href,
        currentUrl: current.url,
      });
    }
    const values = (await queryAll("projectChats", target))
      .map((snapshot) => chatFromSnapshot(snapshot, current, new Set(), new Set()))
      .filter(Boolean)
      .map((chat) => ({ ...chat, "project-id": selected.id }));
    return uniqueByKey(values, "id", "project chat");
  }

  async function dispatch(method, args = [], target = null) {
    switch (method) {
      case "status":
        checkedArguments(method, args, 0);
        return status(target);
      case "chats":
        checkedArguments(method, args, 0);
        return chats(target);
      case "pinned":
        checkedArguments(method, args, 0);
        return pinned(target);
      case "projects":
        checkedArguments(method, args, 0);
        return projects(target);
      case "search-chats":
        checkedArguments(method, args, 1);
        return searchChats(args[0], target);
      case "project-chats":
        checkedArguments(method, args, 1);
        return projectChats(args[0], target);
      case "open-chat":
        checkedArguments(method, args, 1);
        return open("chat", args[0], target);
      case "open-project":
        checkedArguments(method, args, 1);
        return open("project", args[0], target);
      default:
        fail("chatgpt/operation-unsupported", `unsupported ChatGPT operation: ${method}`);
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
