import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("browser.site.chatgpt exposes a user-controlled login sequence", async () => {
  const source = await read("../src/hara/chatgpt.hal");
  for (const operation of ["login-status", "login-start", "login-wait", "login"]) {
    assert.match(source, new RegExp(`\\(defn ${operation.replaceAll("-", "\\-")}\\b`));
  }
  for (const forbidden of ["password", "one-time-code", "otp", "cookie", "token", "authorization"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "i"));
  }
});

test("login service never fills credentials or captures authentication traffic", async () => {
  const service = await read("../src/chatgpt-login-service.js");
  assert.match(service, /credential-handling["']:\s*["']browser-only/);
  assert.doesNotMatch(service, /Runtime\.evaluate|Fetch\.|Network\.|document\.cookie|authorization|responseBody/i);
  assert.doesNotMatch(service, /dispatch\(["']fill["']/);
  assert.match(service, /["']query-exists["']/);
  assert.doesNotMatch(service, /queryLoginSnapshots\(["'](?:authSurface|verificationSurface)["']/);
});

test("Makefile provides a headed persistent-profile ChatGPT login bootstrap", async () => {
  const makefile = await read("../Makefile");
  assert.match(makefile, /^HEADLESS \?= true$/m);
  assert.match(makefile, /^CHATGPT_PROFILE_DIR \?=/m);
  assert.match(makefile, /^chatgpt-login:/m);
  assert.match(makefile, /HEADLESS=false/);
  assert.match(makefile, /PROFILE_DIR="\$\(CHATGPT_PROFILE_DIR\)"/);
  assert.match(makefile, /chmod 700 "\$\(CHATGPT_PROFILE_DIR\)"/);
  assert.match(makefile, /URL=https:\/\/chatgpt\.com/);
});

test("capability manifest records browser-only authentication operations", async () => {
  const manifest = await read("../docs/chatgpt-webapp-capabilities.edn");
  for (const operation of [":login-status", ":login-start", ":login-wait", ":login"]) {
    assert.match(manifest, new RegExp(operation));
  }
  assert.match(manifest, /:credential-handling :browser-only/);
  assert.match(manifest, /:provider-pages :do-not-inspect/);
  assert.match(manifest, /:credential-value-snapshots :forbidden/);
  assert.match(manifest, /:profile-storage :owner-only/);
});
