import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

function fixtureHtml(pathname) {
  const projectOpen = pathname === "/g/g-p-opensource/project";
  const projectChats = projectOpen
    ? `<main data-hara-chatgpt-project-chats="true">
         <a href="/c/historia-issues"
            data-hara-chatgpt-project-chat="true"
            data-chat-id="chat-historia-issues">Historia issue tracking</a>
       </main>`
    : "<main></main>";
  return `<!doctype html>
  <meta charset="utf-8">
  <title>ChatGPT search and project fixture</title>
  <nav aria-label="Chat history" data-hara-chatgpt-navigation="true">
    <button type="button"
            aria-label="Search chats"
            data-hara-chatgpt-action="search">Search chats</button>
    <section aria-label="Chats" data-hara-chatgpt-section="chats">
      <a href="/c/runtime-design"
         data-hara-chatgpt-kind="chat"
         data-chat-id="chat-runtime-design">Runtime design</a>
    </section>
    <section aria-label="Projects" data-hara-chatgpt-section="projects">
      <a href="/g/g-p-opensource/project"
         data-hara-chatgpt-kind="project"
         data-project-id="project-opensource"
         ${projectOpen ? 'aria-current="page"' : ""}>GW Opensource</a>
    </section>
  </nav>
  ${projectChats}
  <script>
    document.querySelector('[data-hara-chatgpt-action="search"]').addEventListener('click', () => {
      if (document.querySelector('[data-hara-chatgpt-search-input="true"]')) return;
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Search chats');
      dialog.innerHTML = '<input type="search" role="searchbox" placeholder="Search chats" data-hara-chatgpt-search-input="true">' +
        '<div data-hara-chatgpt-search-results="true"></div>' +
        '<div data-hara-chatgpt-search-empty="true" hidden>No results</div>';
      document.body.append(dialog);
      const input = dialog.querySelector('input');
      const results = dialog.querySelector('[data-hara-chatgpt-search-results]');
      const empty = dialog.querySelector('[data-hara-chatgpt-search-empty]');
      input.addEventListener('input', () => {
        const matches = input.value.toLowerCase().includes('runtime');
        results.innerHTML = matches
          ? '<a href="/c/runtime-design" data-hara-chatgpt-search-result="true" data-chat-id="chat-runtime-design" data-hara-chatgpt-title="Runtime design" data-hara-chatgpt-snippet="Architecture and runtime notes">Runtime design</a>'
          : '';
        empty.hidden = matches;
      });
    });
  </script>`;
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

test("browser.site.chatgpt searches visible UI and inventories the open project", async () => {
  const runtime = await launchWithExtension();
  await runtime.context.route("https://chatgpt.com/**", async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: fixtureHtml(url.pathname),
    });
  });
  await runtime.targetPage.goto("https://chatgpt.com/?hara-fixture=search", {
    waitUntil: "domcontentloaded",
  });
  const panel = await runtime.openPanel();

  try {
    await evalHara(panel, "(require [browser.site.chatgpt :as chatgpt])");
    const results = await evalHara(panel, '(chatgpt/search-chats "runtime")');
    expect(results.map((result) => ({
      kind: result.kind,
      chatId: result["chat-id"],
      title: result.title,
      snippet: result.snippet,
    }))).toEqual([{
      kind: "chat-search-result",
      chatId: "chat-runtime-design",
      title: "Runtime design",
      snippet: "Architecture and runtime notes",
    }]);

    await evalHara(
      panel,
      "(do (def selected-project (first (chatgpt/projects))) (chatgpt/open-project selected-project))",
    );
    await expect.poll(() => runtime.targetPage.url()).toContain("/g/g-p-opensource/project");

    const projectChats = await evalHara(panel, "(chatgpt/project-chats selected-project)");
    expect(projectChats.map((chat) => ({
      kind: chat.kind,
      id: chat.id,
      title: chat.title,
      projectId: chat["project-id"],
    }))).toEqual([{
      kind: "chat",
      id: "chat-historia-issues",
      title: "Historia issue tracking",
      projectId: "project-opensource",
    }]);
  } finally {
    await runtime.close();
  }
});
