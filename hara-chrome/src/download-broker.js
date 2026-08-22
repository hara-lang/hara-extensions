export const DOWNLOAD_RECEIPT_PROTOCOL = "greenways.browser-download/0-alpha";
export const DOWNLOAD_DEFAULT_TIMEOUT_MS = 120000;
export const DOWNLOAD_MAX_TIMEOUT_MS = 1800000;

const SAFE_DANGER_STATES = new Set([
  "safe",
  "allowlistedByPolicy",
  "deepScannedSafe",
]);

export class DownloadBrokerError extends Error {
  constructor(code, message, data = {}) {
    super(`${code}: ${message}`);
    this.name = "DownloadBrokerError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = {}) {
  throw new DownloadBrokerError(code, message, data);
}

function compactText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function safeUrl(rawValue) {
  try {
    const value = new URL(String(rawValue ?? ""));
    return {
      origin: value.origin,
      pathname: value.pathname,
    };
  } catch {
    return null;
  }
}

function originFor(rawValue) {
  return safeUrl(rawValue)?.origin ?? null;
}

function checkedTimeout(value) {
  const timeoutMs = value === undefined || value === null
    ? DOWNLOAD_DEFAULT_TIMEOUT_MS
    : Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > DOWNLOAD_MAX_TIMEOUT_MS) {
    fail(
      "download/invalid-timeout",
      `download timeout must be an integer from 1000 to ${DOWNLOAD_MAX_TIMEOUT_MS} milliseconds`,
      { timeoutMs: value },
    );
  }
  return timeoutMs;
}

function checkedDirectory(value) {
  const directory = compactText(value ?? "Greenways/Tripo").replaceAll("\\", "/");
  if (
    directory.length === 0
    || directory.startsWith("/")
    || /^[a-z]:\//i.test(directory)
    || directory.includes("\0")
  ) {
    fail("download/invalid-destination", "destination must be relative to the Downloads directory", {
      directory: value,
    });
  }
  const parts = directory.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    fail("download/invalid-destination", "destination cannot contain '.' or '..' path components", {
      directory: value,
    });
  }
  return parts.map((part) => sanitizeSegment(part, "download")).join("/");
}

function sanitizeSegment(value, fallback) {
  const segment = compactText(value)
    .replace(/\s+/g, "-")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/-+/g, "-")
    .trim();
  return segment || fallback;
}

function extensionFor(...values) {
  for (const value of values) {
    const text = String(value ?? "").split(/[?#]/, 1)[0];
    const match = text.match(/(\.[a-z0-9]{1,10})$/i);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

function filenameFor(item, pending) {
  const suggested = pending.pageEvent?.suggestedFilename
    ?? String(item.filename ?? "").split(/[\\/]/).pop()
    ?? "";
  const extension = extensionFor(suggested, pending.pageEvent?.url, item.finalUrl, item.url)
    || (pending.format ? `.${pending.format}` : "");
  const originalStem = suggested.replace(/\.[a-z0-9]{1,10}$/i, "");
  const stem = sanitizeSegment(pending.name ?? originalStem, "tripo-asset");
  return `${pending.directory}/${stem}${extension}`;
}

function candidateMatches(item, pending) {
  const startedAt = Date.parse(item?.startTime ?? "");
  if (Number.isFinite(startedAt) && startedAt < pending.startedAt - 1000) return false;

  if (pending.pageEvent?.url) {
    if (item?.url === pending.pageEvent.url || item?.finalUrl === pending.pageEvent.url) return true;
  }

  return originFor(item?.referrer) === pending.origin;
}

function receiptFor(item, pending) {
  const bytes = Number(item.fileSize) >= 0
    ? Number(item.fileSize)
    : Number(item.totalBytes) >= 0
      ? Number(item.totalBytes)
      : null;
  return {
    protocol: DOWNLOAD_RECEIPT_PROTOCOL,
    id: Number(item.id),
    state: item.state,
    path: item.filename,
    "relative-path": pending.relativePath ?? null,
    mime: item.mime || null,
    bytes,
    danger: item.danger || null,
    "exists?": item.exists === true,
    "started-at": item.startTime || null,
    "ended-at": item.endTime || null,
    source: safeUrl(item.finalUrl || item.url),
  };
}

export function createDownloadBroker({
  downloadsApi,
  coordinator,
  now = () => Date.now(),
} = {}) {
  if (!downloadsApi?.onCreated || !downloadsApi?.onChanged || !downloadsApi?.onDeterminingFilename) {
    throw new TypeError("createDownloadBroker requires chrome.downloads");
  }
  if (!coordinator || typeof coordinator.acquire !== "function" || typeof coordinator.send !== "function") {
    throw new TypeError("createDownloadBroker requires a debugger coordinator");
  }

  let pending = null;
  let closed = false;
  const recentCreated = [];

  function clearPending(expected, outcome, value) {
    if (pending !== expected) return;
    pending = null;
    clearTimeout(expected.timer);
    if (outcome === "resolve") expected.resolve(value);
    else expected.reject(value);
  }

  function failPending(expected, code, message, data = {}) {
    clearPending(expected, "reject", new DownloadBrokerError(code, message, data));
  }

  function bindItem(item) {
    const current = pending;
    if (!current || !candidateMatches(item, current)) return false;
    if (current.downloadId !== null && current.downloadId !== item.id) {
      failPending(current, "download/ambiguous", "more than one download matched the explicit export operation", {
        firstDownloadId: current.downloadId,
        secondDownloadId: item.id,
      });
      return false;
    }
    current.downloadId = item.id;
    current.item = item;
    return true;
  }

  async function finish(itemId) {
    const current = pending;
    if (!current || current.downloadId !== itemId || current.finishing) return;
    current.finishing = true;
    try {
      const items = await downloadsApi.search({ id: itemId });
      const item = items?.[0];
      if (!item) {
        failPending(current, "download/not-found", "completed browser download could not be read back", {
          downloadId: itemId,
        });
        return;
      }
      if (item.state === "interrupted") {
        failPending(current, "download/interrupted", "browser download was interrupted", {
          downloadId: itemId,
          reason: item.error ?? null,
        });
        return;
      }
      if (item.state !== "complete") {
        current.finishing = false;
        return;
      }
      if (!SAFE_DANGER_STATES.has(item.danger)) {
        failPending(current, "download/dangerous", "Chrome did not classify the completed download as safe", {
          downloadId: itemId,
          danger: item.danger ?? null,
        });
        return;
      }
      clearPending(current, "resolve", receiptFor(item, current));
    } catch (error) {
      failPending(current, "download/readback-failed", "browser download metadata could not be read back", {
        downloadId: itemId,
        cause: String(error?.message ?? error),
      });
    }
  }

  const onCreated = (item) => {
    recentCreated.push(item);
    const cutoff = now() - 10000;
    while (recentCreated.length && Date.parse(recentCreated[0]?.startTime ?? "") < cutoff) recentCreated.shift();
    if (bindItem(item) && (item.state === "complete" || item.state === "interrupted")) {
      void finish(item.id);
    }
  };

  const onChanged = (delta) => {
    const current = pending;
    if (!current || current.downloadId !== delta?.id) return;
    if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
      void finish(delta.id);
    }
  };

  const onDeterminingFilename = (item, suggest) => {
    const current = pending;
    if (!current || !candidateMatches(item, current)) {
      suggest();
      return;
    }
    bindItem(item);
    if (pending !== current) {
      suggest();
      return;
    }
    const relativePath = filenameFor(item, current);
    current.relativePath = relativePath;
    suggest({ filename: relativePath, conflictAction: "uniquify" });
  };

  const stopCoordinatorEvents = coordinator.onEvent((source, method, params) => {
    const current = pending;
    if (!current || source?.tabId !== current.tabId || method !== "Page.downloadWillBegin") return;
    current.pageEvent = {
      guid: params?.guid ?? null,
      url: params?.url ?? null,
      suggestedFilename: params?.suggestedFilename ?? null,
    };
    for (const item of recentCreated) {
      if (bindItem(item)) break;
    }
  });

  downloadsApi.onCreated.addListener(onCreated);
  downloadsApi.onChanged.addListener(onChanged);
  downloadsApi.onDeterminingFilename.addListener(onDeterminingFilename);

  async function capture({
    owner,
    tabId,
    origin,
    directory = "Greenways/Tripo",
    name = null,
    format = null,
    timeoutMs = DOWNLOAD_DEFAULT_TIMEOUT_MS,
  } = {}, trigger) {
    if (closed) fail("download/closed", "download broker has been closed");
    if (pending) fail("download/busy", "another explicit browser download is already pending");
    if (typeof owner !== "string" || owner.length === 0) throw new TypeError("download owner must be a non-empty string");
    const checkedTabId = Number(tabId);
    if (!Number.isInteger(checkedTabId) || checkedTabId <= 0) fail("download/missing-target", "download requires a live bound tab");
    const checkedOrigin = originFor(origin);
    if (!checkedOrigin) fail("download/invalid-origin", "download requires a valid source origin", { origin });
    if (typeof trigger !== "function") throw new TypeError("download capture requires a trigger function");

    const checkedTimeoutMs = checkedTimeout(timeoutMs);
    const checkedDestination = checkedDirectory(directory);
    const checkedName = name ? sanitizeSegment(name, "tripo-asset") : null;
    const checkedFormat = compactText(format).toLowerCase().replace(/^:/, "") || null;
    const captureOwner = `${owner}:download`;
    await coordinator.acquire(checkedTabId, captureOwner);
    try {
      await coordinator.send(checkedTabId, "Page.enable", {});
      const completion = new Promise((resolve, reject) => {
        const value = {
          owner,
          captureOwner,
          tabId: checkedTabId,
          origin: checkedOrigin,
          directory: checkedDestination,
          name: checkedName,
          format: checkedFormat,
          startedAt: now(),
          downloadId: null,
          item: null,
          pageEvent: null,
          relativePath: null,
          finishing: false,
          resolve,
          reject,
          timer: null,
        };
        value.timer = setTimeout(() => {
          failPending(value, "download/timeout", "browser download did not complete before the timeout", {
            timeoutMs: checkedTimeoutMs,
            downloadId: value.downloadId,
          });
        }, checkedTimeoutMs);
        pending = value;
      });

      try {
        const triggered = await trigger();
        if (triggered !== true) {
          const current = pending;
          if (current) failPending(current, "download/action-unverified", "visible export control did not activate");
        }
      } catch (error) {
        const current = pending;
        if (current) failPending(current, "download/action-failed", "visible export control failed", {
          cause: String(error?.message ?? error),
        });
      }

      return await completion;
    } finally {
      await coordinator.release(checkedTabId, captureOwner);
    }
  }

  return {
    capture,
    cancelOwner(owner) {
      const current = pending;
      if (current?.owner === owner) {
        failPending(current, "download/canceled", "download capture owner disconnected");
      }
      return true;
    },
    async close() {
      if (closed) return true;
      closed = true;
      const current = pending;
      if (current) failPending(current, "download/closed", "download broker closed while capture was pending");
      downloadsApi.onCreated.removeListener?.(onCreated);
      downloadsApi.onChanged.removeListener?.(onChanged);
      downloadsApi.onDeterminingFilename.removeListener?.(onDeterminingFilename);
      stopCoordinatorEvents?.();
      return true;
    },
    _pending: () => pending,
  };
}
