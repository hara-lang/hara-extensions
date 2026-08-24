import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

test("remote language-host modules do not import the trusted browser runtime", async () => {
  const owned = await Promise.all([
    "remote-host-protocol.js",
    "remote-host-client.js",
    "remote-sandbox-executor.js",
    "remote-language-host-core.js",
  ].map(source));
  const combined = owned.join("\n");
  for (const forbidden of [
    "createBrowserBroker",
    "runtime-host-core",
    "host-bridge",
    "resp-client",
    "HOST_CALL_PORT",
    "browser.dom",
    "browser.site.chatgpt",
    "browser.site.tripo",
    "chrome.api",
    "IndexedDB",
    "broker.eval",
    "const ROOT",
  ]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});

test("offscreen bootstrap imports only the canonical Hara sandbox and remote host core", async () => {
  const bootstrap = await source("remote-language-host.js");
  const imports = [...bootstrap.matchAll(/^import[\s\S]*?from\s+"([^"]+)";/gmu)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    "../vendor/packages/hta/sandbox.js",
    "./remote-language-host-core.js",
  ]);
  assert.equal(bootstrap.includes("haraRuntimeHost"), false);
  assert.equal(bootstrap.includes("ROOT"), false);
  assert.equal(bootstrap.includes("hostCalls"), false);
  assert.equal(bootstrap.includes("filesystemHost"), false);
});
