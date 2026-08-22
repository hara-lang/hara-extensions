import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normaliseTargetUrl,
  openOrReuseTarget,
  resolveExactChromeTab,
} from "../scripts/browser-target.mjs";

test("target URL defaults, propagates, and reuses one ordinary page", async () => {
  assert.equal(normaliseTargetUrl(), "about:blank");
  const navigations = [];
  const page = {
    current: "about:blank",
    url() { return this.current; },
    async goto(url) { this.current = url; navigations.push(url); },
  };
  const context = {
    pages: () => [
      { url: () => "chrome-extension://abc/src/panel.html" },
      page,
    ],
    newPage: async () => assert.fail("an existing ordinary page should be reused"),
  };
  const target = await openOrReuseTarget(context, { url: "https://example.test/path" });
  assert.equal(target.page, page);
  assert.equal(target.url, "https://example.test/path");
  assert.deepEqual(navigations, ["https://example.test/path"]);
});

test("exact Chrome tab binding uses CDP targetId rather than URL matching", async () => {
  const seen = [];
  const page = { url: () => "https://same.example/" };
  const context = {
    newCDPSession: async (candidate) => {
      assert.equal(candidate, page);
      return {
        send: async (method) => {
          assert.equal(method, "Target.getTargetInfo");
          return { targetInfo: { targetId: "target-exact" } };
        },
        detach: async () => {},
      };
    },
  };
  const serviceWorker = {
    evaluate: async (_fn, targetId) => {
      seen.push(targetId);
      return { tabId: 91, id: targetId, url: "https://same.example/" };
    },
  };
  const result = await resolveExactChromeTab(context, serviceWorker, page, {
    timeout: 50,
    pollInterval: 1,
  });
  assert.deepEqual(result, {
    tabId: 91,
    targetId: "target-exact",
    url: "https://same.example/",
  });
  assert.deepEqual(seen, ["target-exact"]);
});
