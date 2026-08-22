function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normaliseTargetUrl(value = "about:blank") {
  const source = String(value ?? "").trim() || "about:blank";
  try {
    return new URL(source).href;
  } catch (error) {
    throw new Error(`invalid target URL ${JSON.stringify(source)}: ${error.message}`);
  }
}

function ordinaryPage(page) {
  return !page.url().startsWith("chrome-extension://");
}

/** Reuse an existing ordinary page where possible, otherwise open exactly one. */
export async function openOrReuseTarget(context, {
  url = "about:blank",
  timeout = 60000,
} = {}) {
  const requestedUrl = normaliseTargetUrl(url);
  const pages = context.pages().filter(ordinaryPage);
  const page = pages.find((candidate) => candidate.url() === requestedUrl)
    ?? pages[0]
    ?? await context.newPage();

  if (page.url() !== requestedUrl) {
    await page.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout,
    });
  }
  return { page, url: page.url() };
}

async function pageTargetId(context, page) {
  const session = await context.newCDPSession(page);
  try {
    const result = await session.send("Target.getTargetInfo");
    const targetId = result?.targetInfo?.targetId;
    if (!targetId) throw new Error("Target.getTargetInfo omitted targetId");
    return targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * Map the Playwright page's exact CDP targetId to Chrome's exact tabId. URL
 * matching is intentionally not used because persistent profiles may contain
 * several tabs with the same URL.
 */
export async function resolveExactChromeTab(context, serviceWorker, page, {
  timeout = 60000,
  pollInterval = 50,
} = {}) {
  const targetId = await pageTargetId(context, page);
  const deadline = Date.now() + timeout;
  do {
    const target = await serviceWorker.evaluate(async (expectedTargetId) => {
      const targets = await chrome.debugger.getTargets();
      return targets.find((candidate) =>
        candidate.id === expectedTargetId
        && Number.isInteger(candidate.tabId)
      ) ?? null;
    }, targetId);
    if (target && Number.isInteger(target.tabId) && target.tabId > 0) {
      return {
        tabId: target.tabId,
        targetId,
        url: page.url(),
      };
    }
    await delay(pollInterval);
  } while (Date.now() < deadline);
  throw new Error(`unable to resolve Chrome tab for CDP target ${targetId}`);
}
