import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("manifest grants the bounded downloads API permission", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.equal(manifest.permissions.includes("downloads"), true);
});

test("background routes and closes Tripo inventory, login, and download services", async () => {
  const source = await read("src/background.js");
  assert.match(source, /createDownloadBroker/);
  assert.match(source, /createTripoDownloadService/);
  assert.match(source, /service === "hara\.tripo"/);
  assert.match(source, /TRIPO_DOWNLOAD_METHODS\.has\(method\)/);
  for (const close of [
    "tripoDownloadService.close()",
    "tripoLoginService.close()",
    "tripoService.close()",
  ]) {
    assert.match(source, new RegExp(close.replace(/[().]/g, "\\$&")));
  }
});

test("browser.site.tripo exposes explicit export inspection and confirmed download", async () => {
  const source = await read("src/hara/tripo.hal");
  assert.match(source, /\(defn export-options\b/);
  assert.match(source, /\(defn download-asset\b/);
  assert.match(source, /confirm-download/);
  assert.doesNotMatch(source, /signed-url|authorization|cookie/i);
});

test("download implementation monitors page-initiated downloads without replaying URLs", async () => {
  const broker = await read("src/download-broker.js");
  const service = await read("src/tripo-download-service.js");
  assert.match(broker, /Page\.downloadWillBegin/);
  assert.match(broker, /onDeterminingFilename/);
  assert.match(broker, /conflictAction:\s*"uniquify"/);
  assert.doesNotMatch(broker, /downloadsApi\.download\s*\(/);
  assert.doesNotMatch(broker, /"accepted"/);
  assert.doesNotMatch(service, /Runtime\.evaluate|Fetch\.|Network\.|document\.cookie|authorization/i);
  assert.match(service, /download-confirmation-required/);
});

test("download capability policy remains visible-UI and fail-closed", async () => {
  const capabilities = await read("docs/tripo-webapp-capabilities.edn");
  assert.match(capabilities, /:id :export-options/);
  assert.match(capabilities, /:id :download-asset/);
  assert.match(capabilities, /:url-replay :forbidden/);
  assert.match(capabilities, /:relative-path-only true/);
  assert.match(capabilities, /:dangerous-download-acceptance :forbidden/);
  assert.match(capabilities, /:bytes-cross-hara\? false/);
});
