import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../src/hara/chatgpt.hal", import.meta.url), "utf8");

test("browser.site.chatgpt completes the read-only phase-one surface", () => {
  for (const operation of [
    "status",
    "chats",
    "pinned",
    "projects",
    "search-chats",
    "project-chats",
    "open-chat",
    "open-project",
  ]) {
    assert.match(source, new RegExp(`\\(defn ${operation.replaceAll("-", "\\-")}\\b`));
  }
});

test("phase-one Hara surface still excludes writes and private page execution", () => {
  for (const deferred of [
    "new-chat",
    "fill-composer",
    "send",
    "pin",
    "unpin",
    "move-to-project",
    "archive",
    "delete-chat",
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\(defn ${deferred.replaceAll("-", "\\-")}\\b`));
  }
  assert.doesNotMatch(source, /Runtime\.evaluate|Fetch\.|Network\.|cookie|authorization/i);
});
