import { TRIPO_SELECTOR_PROFILE, selectorFor } from "./tripo-profile.js";

export const TRIPO_REPL_PROTOCOL = "greenways.tripo-web-repl/0-alpha";
export const TRIPO_INVENTORY_LIMIT = 1000;

export class TripoError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "TripoError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = {}) {
  throw new TripoError(code, message, data);
}

function checkedArguments(method, args, minimum, maximum = minimum) {
  if (!Array.isArray(args) || args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    fail("tripo/invalid-request", `${method} expects ${expected} argument(s)`);
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

function normaliseToken(value) {
  const token = compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return token || null;
}

function truthyAttribute(value) {
  return ["true", "page", "yes", "1", "active", "current"].includes(String(value ?? "").toLowerCase());
}

function elementReference(snapshot) {
  const tabId = Number(snapshot?.["tab-id"] ?? snapshot?.tabId);
  const backendNodeId = Number(snapshot?.["backend-node-id"] ?? snapshot?.backendNodeId);
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("tripo/entity-invalid", "DOM snapshot is missing an opaque element reference");
  }
  return { "tab-id": tabId, "backend-node-id": backendNodeId };
}

function routeFor(rawHref, pageUrl) {
  if (typeof rawHref !== "string" || rawHref.trim().length === 0) return null;
  let page;
  let parsed;
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
    attrs["data-hara-tripo-title"]
      ?? attrs["aria-label"]
      ?? attrs.title
      ?? snapshot?.text,
  );
}

function navigationScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"]).toLowerCase();
  let score = 0;
  if (truthyAttribute(attrs["data-hara-tripo-navigation"])) score += 100;
  if (label.includes("tripo")) score += 60;
  if (label.includes("studio")) score += 50;
  if (String(attrs.role ?? "").toLowerCase() === "navigation") score += 20;
  if (String(snapshot?.tag ?? "").toLowerCase() === "nav") score += 10;
  return score;
}

function workspaceScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"] ?? attrs.title ?? snapshot?.text).toLowerCase();
  let score = 0;
  if (truthyAttribute(attrs["data-hara-tripo-workspace-current"])) score += 100;
  if (attrs["data-workspace-id"]) score += 50;
  if (label.includes("workspace")) score += 40;
  if (label.includes("personal") || label.includes("team")) score += 20;
  return score;
}

function assetsNavScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"] ?? attrs.title ?? snapshot?.text).toLowerCase();
  const href = String(attrs.href ?? "").toLowerCase();
  let score = 0;
  if (attrs["data-hara-tripo-action"] === "assets") score += 100;
  if (href.includes("/assets")) score += 70;
  if (label === "assets") score += 60;
  else if (label.includes("assets")) score += 40;
  return score;
}

function chooseRanked(candidates, kind, score, { optional = false } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (optional) return null;
    fail("tripo/ui-unsupported", `Tripo ${kind} was not found`);
  }
  const ranked = candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort((left, right) => right.score - left.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
    fail("tripo/ui-unsupported", `Tripo ${kind} is ambiguous`, {
      candidates: ranked.length,
      score: ranked[0].score,
    });
  }
  return ranked[0].candidate;
}

function uniqueById(values, kind) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.id)) {
      fail("tripo/duplicate-identity", `duplicate ${kind} identity: ${value.id}`, {
        kind,
        id: value.id,
      });
    }
    seen.add(value.id);
  }
  return values;
}

function workspaceFromSnapshot(snapshot) {
  const attrs = attributes(snapshot);
  const name = compactText(
    attrs["data-hara-tripo-workspace-name"]
      ?? attrs["aria-label"]
      ?? attrs.title
      ?? snapshot?.text,
  );
  const mode = normaliseToken(
    attrs["data-hara-tripo-workspace-mode"]
      ?? attrs["data-workspace-mode"]
      ?? (name.toLowerCase().includes("team") ? "team" : name.toLowerCase().includes("personal") ? "personal" : "unknown"),
  );
  const id = compactText(
    attrs["data-hara-tripo-workspace-id"]
      ?? attrs["data-workspace-id"]
      ?? (mode === "personal" ? "personal" : name),
  );
  if (!id || !name) {
    fail("tripo/workspace-invalid", "workspace candidate is missing a stable identity or name");
  }
  return {
    kind: "workspace",
    id,
    name,
    mode,
    element: elementReference(snapshot),
  };
}

function isAssetPath(pathname) {
  return /\/(?:asset|assets|model|task)\//i.test(pathname);
}

function assetFromSnapshot(snapshot, target) {
  const attrs = attributes(snapshot);
  const route = routeFor(attrs.href, target.url);
  const explicit = String(attrs["data-hara-tripo-kind"] ?? "") === "asset";
  if (!route || (!explicit && !isAssetPath(route.pathname))) return null;
  const id = compactText(
    attrs["data-hara-tripo-id"]
      ?? attrs["data-asset-id"]
      ?? attrs["data-model-id"]
      ?? attrs["data-task-id"]
      ?? route.href,
  );
  const title = titleFor(snapshot);
  if (!id || !title) {
    fail("tripo/entity-invalid", "asset candidate is missing a stable identity or title", {
      href: route.href,
    });
  }
  return {
    kind: "asset",
    id,
    title,
    href: route.href,
    status: normaliseToken(attrs["data-status"] ?? attrs["data-task-status"]),
    visibility: normaliseToken(attrs["data-visibility"]),
    "workspace-id": compactText(attrs["data-workspace-id"]) || null,
    "active?": truthyAttribute(attrs["aria-current"]) || truthyAttribute(attrs["data-active"]),
    element: elementReference(snapshot),
  };
}

function checkedEntity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("tripo/entity-invalid", "asset must be a snapshot map");
  }
  const kind = String(value.kind ?? "").replace(/^:/, "");
  if (kind && kind !== "asset") fail("tripo/entity-invalid", `expected asset, received ${kind}`);
  const id = compactText(value.id);
  const href = compactText(value.href);
  if (!id && !href) fail("tripo/entity-invalid", "asset snapshot requires id or href");
  return { id, href };
}

export function createTripoService({
  domService,
  profile = TRIPO_SELECTOR_PROFILE,
} = {}) {
  if (!domService || typeof domService.dispatch !== "function") {
    throw new TypeError("createTripoService requires a DOM service");
  }
  let closed = false;

  async function queryAll(group, target, limit = TRIPO_INVENTORY_LIMIT) {
    return domService.dispatch("query-all", [selectorFor(profile, group), limit], target);
  }

  async function verifiedTarget(target) {
    if (closed) fail("tripo/closed", "Tripo service has been closed");
    const info = await domService.dispatch("target", [], target);
    let parsed;
    try {
      parsed = new URL(String(info?.url ?? ""));
    } catch {
      fail("tripo/missing-target", "the panel-bound target has no valid URL");
    }
    if (!profile.origins.includes(parsed.origin)) {
      fail("tripo/unsupported-origin", `unsupported Tripo origin: ${parsed.origin}`, {
        origin: parsed.origin,
        allowed: [...profile.origins],
      });
    }
    const tabId = Number(info?.["tab-id"] ?? info?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      fail("tripo/missing-target", "the panel-bound target has no live Chrome tab ID");
    }
    return { "tab-id": tabId, url: parsed.href, origin: parsed.origin };
  }

  async function status(target) {
    const info = await verifiedTarget(target);
    const [signedOut, signedIn, navigationCandidates] = await Promise.all([
      queryAll("signedOut", target, 20),
      queryAll("signedIn", target, 20),
      queryAll("navigation", target, 20),
    ]);
    if (signedIn.length > 0) {
      const navigation = chooseRanked(navigationCandidates, "navigation landmark", navigationScore, { optional: true });
      return {
        protocol: TRIPO_REPL_PROTOCOL,
        state: "inventory-ready",
        "signed-in?": true,
        ...info,
        profile: { id: profile.id, version: profile.version, locale: profile.locale },
        navigation: navigation ? elementReference(navigation) : null,
      };
    }
    if (signedOut.length > 0) {
      return {
        protocol: TRIPO_REPL_PROTOCOL,
        state: "signed-out",
        "signed-in?": false,
        ...info,
        profile: { id: profile.id, version: profile.version, locale: profile.locale },
        navigation: null,
      };
    }
    return {
      protocol: TRIPO_REPL_PROTOCOL,
      state: "loading",
      "signed-in?": false,
      ...info,
      profile: { id: profile.id, version: profile.version, locale: profile.locale },
      navigation: null,
    };
  }

  async function requireSignedIn(target) {
    const current = await status(target);
    if (!current["signed-in?"]) {
      fail(current.state === "signed-out" ? "tripo/signed-out" : "tripo/ui-unsupported", "the bound Tripo Studio page is not ready for private inventory", {
        state: current.state,
      });
    }
    return current;
  }

  async function workspace(target) {
    await requireSignedIn(target);
    const selected = chooseRanked(await queryAll("workspace", target, 20), "current workspace", workspaceScore);
    return workspaceFromSnapshot(selected);
  }

  async function openAssets(target) {
    await requireSignedIn(target);
    const selected = chooseRanked(await queryAll("assetsNav", target, 20), "Assets navigation", assetsNavScore);
    const clicked = await domService.dispatch("click", [elementReference(selected)], target);
    if (clicked !== true) fail("tripo/action-unverified", "Assets navigation did not activate");
    return { opened: true, kind: "assets" };
  }

  async function assets(target) {
    const current = await requireSignedIn(target);
    const surfaces = await queryAll("assetLibrary", target, 20);
    if (surfaces.length === 0) {
      fail("tripo/assets-not-open", "the visible Tripo Assets library is not open");
    }
    const values = (await queryAll("assets", target))
      .map((snapshot) => assetFromSnapshot(snapshot, current))
      .filter(Boolean);
    return uniqueById(values, "asset");
  }

  async function openAsset(input, target) {
    const identity = checkedEntity(input);
    const values = await assets(target);
    const matches = values.filter((value) => {
      if (identity.id && value.id !== identity.id) return false;
      if (identity.href && value.href !== identity.href) return false;
      return true;
    });
    if (matches.length === 0) fail("tripo/entity-not-found", "asset is no longer present in the visible library", identity);
    if (matches.length > 1) fail("tripo/duplicate-identity", "asset identity resolved more than once", identity);
    const selected = matches[0];
    const clicked = await domService.dispatch("click", [selected.element], target);
    if (clicked !== true) fail("tripo/action-unverified", "asset navigation did not complete", identity);
    return { opened: true, kind: "asset", id: selected.id, href: selected.href };
  }

  async function dispatch(method, args = [], target = null) {
    switch (method) {
      case "status":
        checkedArguments(method, args, 0);
        return status(target);
      case "workspace":
        checkedArguments(method, args, 0);
        return workspace(target);
      case "open-assets":
        checkedArguments(method, args, 0);
        return openAssets(target);
      case "assets":
        checkedArguments(method, args, 0);
        return assets(target);
      case "open-asset":
        checkedArguments(method, args, 1);
        return openAsset(args[0], target);
      default:
        fail("tripo/operation-unsupported", `unsupported Tripo operation: ${method}`);
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
