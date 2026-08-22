import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("browser.site.tripo exposes auth and read-only inventory only", async () => {
  const source = await read("../src/hara/tripo.hal");
  for (const operation of [
    "login-status",
    "login-start",
    "login-wait",
    "login",
    "status",
    "workspace",
    "open-assets",
    "assets",
    "open-asset",
  ]) {
    assert.match(source, new RegExp(`\\(defn ${operation.replaceAll("-", "\\-")}\\b`));
  }
  for (const deferred of ["generate", "generate-text", "generate-image", "export", "delete-asset", "invite-member", "buy-credits"]) {
    assert.doesNotMatch(source, new RegExp(`\\(defn ${deferred.replaceAll("-", "\\-")}\\b`));
  }
});

test("Tripo services exclude private endpoints, credential values, and arbitrary page execution", async () => {
  const source = [
    await read("../src/tripo-profile.js"),
    await read("../src/tripo-service.js"),
    await read("../src/tripo-login-service.js"),
  ].join("\n");
  assert.doesNotMatch(source, /Runtime\.evaluate|Fetch\.|Network\.|document\.cookie|authorization|api\.tripo3d\.ai|\/v2\/openapi/i);
  assert.doesNotMatch(source, /dispatch\(["']fill["']/);
});
