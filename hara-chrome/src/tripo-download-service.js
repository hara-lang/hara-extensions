import { selectorFor, TRIPO_SELECTOR_PROFILE } from "./tripo-profile.js";
import { TripoError } from "./tripo-service.js";

export const TRIPO_DOWNLOAD_METHODS = Object.freeze(new Set([
  "export-options",
  "download-asset",
]));

export const TRIPO_EXPORT_SURFACE_TIMEOUT_MS = 5000;

const KNOWN_FORMATS = ["glb", "gltf", "fbx", "obj", "stl", "usdz", "usd", "3mf"];

function fail(code, message, data = {}) {
  throw new TripoError(code, message, data);
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function attributes(snapshot) {
  return snapshot?.attributes && typeof snapshot.attributes === "object"
    ? snapshot.attributes
    : {};
}

function truthy(value) {
  return ["true", "yes", "1", "selected", "checked", "page"].includes(
    String(value ?? "").toLowerCase(),
  );
}

function elementReference(snapshot) {
  const tabId = Number(snapshot?.["tab-id"] ?? snapshot?.tabId);
  const backendNodeId = Number(snapshot?.["backend-node-id"] ?? snapshot?.backendNodeId);
  if (!Number.isInteger(tabId) || tabId <= 0 || !Number.isInteger(backendNodeId) || backendNodeId <= 0) {
    fail("tripo/entity-invalid", "export control is missing an opaque DOM reference");
  }
  return { "tab-id": tabId, "backend-node-id": backendNodeId };
}

function checkedArguments(method, args, minimum, maximum = minimum) {
  if (!Array.isArray(args) || args.length < minimum || args.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    fail("tripo/invalid-request", `${method} expects ${expected} argument(s)`);
  }
}

function checkedAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("tripo/entity-invalid", "asset must be a snapshot map");
  }
  const kind = String(value.kind ?? "").replace(/^:/, "");
  if (kind && kind !== "asset") fail("tripo/entity-invalid", `expected asset, received ${kind}`);
  const id = compactText(value.id);
  const href = compactText(value.href);
  const title = compactText(value.title);
  if (!id || !href) fail("tripo/entity-invalid", "asset download requires exact id and href");
  return {
    id,
    href,
    title: title || id,
    "workspace-id": compactText(value["workspace-id"]) || null,
  };
}

function normaliseFormat(value) {
  const text = compactText(value).toLowerCase().replace(/^:/, "");
  for (const format of KNOWN_FORMATS) {
    const expression = new RegExp(`(?:^|[^a-z0-9])${format}(?:$|[^a-z0-9])`, "i");
    if (expression.test(text)) return format;
  }
  return null;
}

function routePath(rawHref, pageUrl) {
  try {
    const page = new URL(pageUrl);
    const route = new URL(rawHref, page);
    if (route.origin !== page.origin) return null;
    return route.pathname;
  } catch {
    return null;
  }
}

function checkedRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("tripo/invalid-download-request", "download-asset requires a request map");
  }
  const asset = checkedAsset(value.asset);
  const format = normaliseFormat(value.format);
  if (!format) {
    fail("tripo/invalid-export-format", "download request requires a supported visible export format", {
      format: value.format ?? null,
    });
  }
  const confirmed = value["confirm-download?"] ?? value["confirm-download"] ?? value.confirm;
  if (confirmed !== true) {
    fail("tripo/download-confirmation-required", "download requires :confirm-download? true", {
      assetId: asset.id,
      format,
    });
  }
  return {
    asset,
    format,
    directory: value.directory ?? "Greenways/Tripo",
    name: compactText(value.name) || asset.title,
    timeoutMs: value["timeout-ms"] ?? value.timeoutMs,
  };
}

function triggerScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"] ?? attrs.title ?? snapshot?.text).toLowerCase();
  let score = 0;
  if (attrs["data-hara-tripo-action"] === "export") score += 100;
  if (String(attrs["data-testid"] ?? "").toLowerCase().includes("export")) score += 70;
  if (label === "export") score += 60;
  else if (label.includes("export")) score += 40;
  return score;
}

function confirmScore(snapshot) {
  const attrs = attributes(snapshot);
  const label = compactText(attrs["aria-label"] ?? attrs.title ?? snapshot?.text).toLowerCase();
  let score = 0;
  if (attrs["data-hara-tripo-action"] === "download") score += 100;
  if (String(attrs["data-testid"] ?? "").toLowerCase().includes("download")) score += 70;
  if (label === "download") score += 60;
  else if (label.includes("download")) score += 40;
  if (label === "export") score += 30;
  return score;
}

function chooseRanked(candidates, kind, score) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
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

function formatOption(snapshot) {
  const attrs = attributes(snapshot);
  const format = normaliseFormat(
    attrs["data-hara-tripo-export-format"]
      ?? attrs["data-export-format"]
      ?? attrs.value
      ?? attrs["aria-label"]
      ?? attrs.title
      ?? snapshot?.text,
  );
  if (!format) return null;
  const unavailable = snapshot?.disabled === true
    || Object.hasOwn(attrs, "disabled")
    || truthy(attrs["aria-disabled"])
    || String(attrs["data-available"] ?? "").toLowerCase() === "false";
  const note = compactText(
    attrs["data-hara-tripo-export-note"]
      ?? attrs["data-unavailable-reason"]
      ?? attrs.title,
  ) || null;
  return {
    format,
    label: compactText(attrs["aria-label"] ?? snapshot?.text ?? format) || format.toUpperCase(),
    "available?": !unavailable,
    "selected?": truthy(attrs["aria-checked"])
      || truthy(attrs["aria-selected"])
      || truthy(attrs["data-selected"]),
    note,
    element: elementReference(snapshot),
  };
}

function uniqueFormats(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value.format)) {
      fail("tripo/ui-unsupported", `Tripo export format is ambiguous: ${value.format}`);
    }
    seen.add(value.format);
  }
  return values;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createTripoDownloadService({
  domService,
  tripoService,
  downloadBroker,
  owner,
  profile = TRIPO_SELECTOR_PROFILE,
  exportSurfaceTimeoutMs = TRIPO_EXPORT_SURFACE_TIMEOUT_MS,
  pollIntervalMs = 50,
} = {}) {
  if (!domService || typeof domService.dispatch !== "function") {
    throw new TypeError("createTripoDownloadService requires a DOM service");
  }
  if (!tripoService || typeof tripoService.dispatch !== "function") {
    throw new TypeError("createTripoDownloadService requires a Tripo service");
  }
  if (!downloadBroker || typeof downloadBroker.capture !== "function") {
    throw new TypeError("createTripoDownloadService requires a download broker");
  }
  if (typeof owner !== "string" || owner.length === 0) {
    throw new TypeError("createTripoDownloadService requires a non-empty owner");
  }
  let closed = false;

  async function queryAll(group, target, limit = 20) {
    return domService.dispatch("query-all", [selectorFor(profile, group), limit], target);
  }

  async function requireOpenAsset(asset, target) {
    if (closed) fail("tripo/closed", "Tripo download service has been closed");
    const current = await tripoService.dispatch("status", [], target);
    if (current?.["signed-in?"] !== true) {
      fail("tripo/signed-out", "Tripo Studio must be signed in before exporting an asset", {
        state: current?.state ?? null,
      });
    }
    const actualPath = routePath(current.url, current.url);
    const expectedPath = routePath(asset.href, current.url);
    if (!actualPath || !expectedPath || actualPath !== expectedPath) {
      fail("tripo/asset-not-open", "the requested asset must be open before export", {
        assetId: asset.id,
        expectedPath,
        actualPath,
      });
    }
    const details = await queryAll("assetDetail", target, 20);
    if (details.length === 0) {
      fail("tripo/asset-not-open", "the visible Tripo asset detail surface was not found", {
        assetId: asset.id,
      });
    }
    return current;
  }

  async function blockedReason(target) {
    const blocked = await queryAll("exportBlocked", target, 20);
    return compactText(blocked[0]?.text ?? attributes(blocked[0])?.["aria-label"] ?? "") || null;
  }

  async function openExportSurface(target) {
    let surface = await queryAll("exportSurface", target, 20);
    if (surface.length > 0) return surface;

    const trigger = chooseRanked(
      await queryAll("exportTrigger", target, 20),
      "export control",
      triggerScore,
    );
    const clicked = await domService.dispatch("click", [elementReference(trigger)], target);
    if (clicked !== true) fail("tripo/action-unverified", "Tripo export control did not activate");

    const deadline = Date.now() + exportSurfaceTimeoutMs;
    do {
      surface = await queryAll("exportSurface", target, 20);
      if (surface.length > 0) return surface;
      const reason = await blockedReason(target);
      if (reason) fail("tripo/download-unavailable", reason);
      if (Date.now() >= deadline) break;
      await sleep(pollIntervalMs);
    } while (true);

    fail("tripo/export-timeout", "Tripo export surface did not become visible", {
      timeoutMs: exportSurfaceTimeoutMs,
    });
  }

  async function optionsFor(asset, target) {
    await requireOpenAsset(asset, target);
    await openExportSurface(target);
    const options = uniqueFormats(
      (await queryAll("exportFormats", target, 100))
        .map(formatOption)
        .filter(Boolean),
    );
    if (options.length === 0) {
      const reason = await blockedReason(target);
      fail(
        reason ? "tripo/download-unavailable" : "tripo/ui-unsupported",
        reason ?? "Tripo export surface did not expose supported format choices",
      );
    }
    return options;
  }

  async function exportOptions(input, target) {
    return optionsFor(checkedAsset(input), target);
  }

  async function downloadAsset(input, target) {
    const request = checkedRequest(input);
    const current = await requireOpenAsset(request.asset, target);
    const options = await optionsFor(request.asset, target);
    const selected = options.find((option) => option.format === request.format);
    if (!selected) {
      fail("tripo/export-format-unavailable", "requested format is not visible in Tripo's export surface", {
        format: request.format,
        available: options.map((option) => option.format),
      });
    }
    if (!selected["available?"]) {
      fail("tripo/download-unavailable", selected.note ?? `Tripo export format ${request.format} is unavailable`, {
        format: request.format,
      });
    }
    if (!selected["selected?"]) {
      const clicked = await domService.dispatch("click", [selected.element], target);
      if (clicked !== true) fail("tripo/action-unverified", "Tripo export format did not activate", {
        format: request.format,
      });
    }

    const confirm = chooseRanked(
      await queryAll("exportConfirm", target, 20),
      "download control",
      confirmScore,
    );
    const receipt = await downloadBroker.capture({
      owner,
      tabId: current["tab-id"],
      origin: current.origin,
      directory: request.directory,
      name: request.name,
      format: request.format,
      timeoutMs: request.timeoutMs,
    }, () => domService.dispatch("click", [elementReference(confirm)], target));

    return {
      kind: "asset-download",
      "asset-id": request.asset.id,
      "workspace-id": request.asset["workspace-id"],
      format: request.format,
      ...receipt,
    };
  }

  async function dispatch(method, args = [], target = null) {
    switch (method) {
      case "export-options":
        checkedArguments(method, args, 1);
        return exportOptions(args[0], target);
      case "download-asset":
        checkedArguments(method, args, 1);
        return downloadAsset(args[0], target);
      default:
        fail("tripo/operation-unsupported", `unsupported Tripo download operation: ${method}`);
    }
  }

  return {
    dispatch,
    async close() {
      if (closed) return true;
      closed = true;
      downloadBroker.cancelOwner(owner);
      return true;
    },
  };
}
