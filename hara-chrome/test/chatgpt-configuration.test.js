import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("panel and background register the closed ChatGPT REPL adapter", async () => {
  const panel = await read("../src/panel.js");
  const background = await read("../src/background.js");
  assert.match(
    panel,
    /["']browser\.site\.chatgpt["']\s*:\s*await fetchText\(["']src\/hara\/chatgpt\.hal["']\)/,
  );
  assert.match(background, /createChatgptService/);
  assert.match(background, /service === ["']hara\.chatgpt["']/);
});

test("browser.site.chatgpt exposes only the initial read-only and navigation surface", async () => {
  const source = await read("../src/hara/chatgpt.hal");
  for (const operation of ["status", "chats", "pinned", "projects", "open-chat", "open-project"]) {
    assert.match(source, new RegExp(`\\(defn ${operation.replace("-", "\\-")}\\b`));
  }
  for (const deferred of ["send", "pin", "archive", "delete-chat", "move-to-project"]) {
    assert.doesNotMatch(source, new RegExp(`\\(defn ${deferred.replace("-", "\\-")}\\b`));
  }
  assert.doesNotMatch(source, /Runtime\.evaluate|Fetch\.|Network\.|cookie|authorization/i);
});

test("ChatGPT selector profile is data-owned and rejects private API authority", async () => {
  const profile = await read("../src/chatgpt-profile.js");
  const service = await read("../src/chatgpt-service.js");
  assert.match(profile, /chatgpt-web\/en\/1/);
  assert.match(profile, /https:\/\/chatgpt\.com/);
  assert.match(profile, /aria-label/);
  assert.doesNotMatch(profile, /\/backend-api\//);
  assert.doesNotMatch(profile, /class(?:Name)?[=*]/);
  assert.doesNotMatch(service, /Runtime\.evaluate|Fetch\.|Network\.|document\.cookie|authorization/i);
});
