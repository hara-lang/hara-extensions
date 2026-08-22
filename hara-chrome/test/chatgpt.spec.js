import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

function fixtureHtml(pathname) {
  const active = pathname === "/c/architecture";
  return `<!doctype html>
  <meta charset="utf-8">
  <title>ChatGPT fixture</title>
  <nav aria-label="Chat history" data-hara-chatgpt-navigation="true">
    <section aria-label="Pinned" data-hara-chatgpt-section="pinned">
      <a href="/c/pinned"
         data-hara-chatgpt-kind="chat"
         data-hara-chatgpt-pinned="true"
         data-chat-id="chat-pinned">Pinned ideas</a>
    </section>
    <section aria-label="Chats" data-hara-chatgpt-section="chats">
      <a href="/c/architecture"
         data-hara-chatgpt-kind="chat"
         data-chat-id="chat-architecture"
         ${active ? 'aria-current="page"' : ""}>Architecture notes</a>
    </section>
    <section aria-label="Projects" data-hara-chatgpt-section="projects">
      <a href="/g/g-p-opensource/project"
         data-hara-chatgpt-kind="project"
         data-project-id="project-opensource">GW Opensource</a>
    </section>
  </nav>`;
}

async function evalHara(panel, source) {
  return panel.evaluate(async (text) => {
    const value = await globalThis.hara.evalLocalSource(text);
    const plain = (input) => {
      if (input?.constructor?.name === "HtaKeyword") return input.name;
      if (input instanceof Map) {
        return Object.fromEntries([...input].map(([key, item]) => [key?.name ?? String(key), plain(item)]));
      }
      if (Array.isArray(input)) return input.map(plain);
      if (input instanceof Set) return [...input].map(plain);
      return input;
    };
    return plain(value);
  }, source);
}

test("browser.site.chatgpt inventories and opens the exact panel-bound fixture", async () => {
  const runtime = await launchWithExtension();
  await runtime.context.route("https://chatgpt.com/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: fixtureHtml(url.pathname),
    });
  });
  await runtime.targetPage.goto("https://chatgpt.com/?hara-fixture=1", {
    waitUntil: "domcontentloaded",
  });
  const panel = await runtime.openPanel();

  try {
    await evalHara(panel, "(require [browser.site.chatgpt :as chatgpt])");
    const status = await evalHara(panel, "(chatgpt/status)");
    expect(status).toMatchObject({
      protocol: "greenways.chatgpt-web-repl/0-alpha",
      state: "inventory-ready",
      "signed-in?": true,
      "tab-id": runtime.tabId,
      origin: "https://chatgpt.com",
    });

    const chats = await evalHara(panel, "(chatgpt/chats)");
    expect(chats.map((chat) => ({
      kind: chat.kind,
      id: chat.id,
      title: chat.title,
      pinned: chat["pinned?"],
    }))).toEqual([
      { kind: "chat", id: "chat-pinned", title: "Pinned ideas", pinned: true },
      { kind: "chat", id: "chat-architecture", title: "Architecture notes", pinned: false },
    ]);

    const pinned = await evalHara(panel, "(chatgpt/pinned)");
    expect(pinned.map((chat) => chat.id)).toEqual(["chat-pinned"]);

    const projects = await evalHara(panel, "(chatgpt/projects)");
    expect(projects.map((project) => project.id)).toEqual(["project-opensource"]);

    await evalHara(panel, "(chatgpt/open-chat (first (chatgpt/chats)))");
    await expect.poll(() => runtime.targetPage.url()).toContain("/c/pinned");
  } finally {
    await runtime.close();
  }
});
