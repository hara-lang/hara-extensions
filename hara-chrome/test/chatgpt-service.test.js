import assert from "node:assert/strict";
import { test } from "node:test";
import { CHATGPT_SELECTOR_PROFILE, selectorFor } from "../src/chatgpt-profile.js";
import { createChatgptService } from "../src/chatgpt-service.js";

function snapshot({
  backend,
  tag = "a",
  text = "",
  attributes = {},
  tabId = 41,
}) {
  return {
    "tab-id": tabId,
    "backend-node-id": backend,
    tag,
    text,
    attributes,
    value: null,
    checked: null,
    disabled: false,
  };
}

function fixture({
  url = "https://chatgpt.com/",
  navigation = [snapshot({
    backend: 1,
    tag: "nav",
    attributes: {
      "data-hara-chatgpt-navigation": "true",
      "aria-label": "Chat history",
    },
  })],
  signedOut = [],
  chats = [],
  pinned = [],
  projects = [],
} = {}) {
  const calls = [];
  const clicks = [];
  const answers = new Map([
    [selectorFor(CHATGPT_SELECTOR_PROFILE, "navigation"), navigation],
    [selectorFor(CHATGPT_SELECTOR_PROFILE, "signedOut"), signedOut],
    [selectorFor(CHATGPT_SELECTOR_PROFILE, "chats"), chats],
    [selectorFor(CHATGPT_SELECTOR_PROFILE, "pinned"), pinned],
    [selectorFor(CHATGPT_SELECTOR_PROFILE, "projects"), projects],
  ]);
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "target") return { "tab-id": 41, url };
      if (method === "query-all") return answers.get(args[0]) ?? [];
      if (method === "click") {
        clicks.push(args[0]);
        return true;
      }
      throw new Error(`unexpected DOM operation: ${method}`);
    },
  };
  return { domService, calls, clicks };
}

const chatA = snapshot({
  backend: 10,
  text: "Architecture notes",
  attributes: {
    href: "/c/architecture",
    "data-hara-chatgpt-kind": "chat",
    "data-chat-id": "chat-architecture",
    "aria-current": "page",
  },
});

const chatB = snapshot({
  backend: 11,
  text: "Pinned ideas",
  attributes: {
    href: "/c/pinned",
    "data-hara-chatgpt-kind": "chat",
    "data-chat-id": "chat-pinned",
  },
});

const projectA = snapshot({
  backend: 20,
  text: "GW Opensource",
  attributes: {
    href: "/g/g-p-opensource/project",
    "data-hara-chatgpt-kind": "project",
    "data-project-id": "project-opensource",
  },
});

test("status verifies the bound ChatGPT target and selector profile", async () => {
  const environment = fixture();
  const service = createChatgptService({ domService: environment.domService });
  const value = await service.dispatch("status", [], { tabId: 41 });
  assert.deepEqual(value, {
    protocol: "greenways.chatgpt-web-repl/0-alpha",
    state: "inventory-ready",
    "signed-in?": true,
    "tab-id": 41,
    url: "https://chatgpt.com/",
    origin: "https://chatgpt.com",
    profile: { id: "chatgpt-web/en/1", version: 1, locale: "en" },
    navigation: { "tab-id": 41, "backend-node-id": 1 },
  });
});

test("unsupported target origins fail before inventory discovery", async () => {
  const environment = fixture({ url: "https://example.com/" });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("status", [], { tabId: 41 }),
    (error) => error.code === "chatgpt/unsupported-origin",
  );
  assert.equal(environment.calls.filter((call) => call.method === "query-all").length, 0);
});

test("chat, pinned, and project inventories are bounded logical snapshots", async () => {
  const environment = fixture({
    chats: [chatA, chatB],
    pinned: [snapshot({
      backend: 11,
      text: "Pinned ideas",
      attributes: {
        href: "/c/pinned",
        "data-chat-id": "chat-pinned",
        "data-hara-chatgpt-pinned": "true",
      },
    })],
    projects: [projectA],
  });
  const service = createChatgptService({ domService: environment.domService });
  const chats = await service.dispatch("chats", [], { tabId: 41 });
  assert.deepEqual(chats, [
    {
      kind: "chat",
      id: "chat-architecture",
      title: "Architecture notes",
      href: "/c/architecture",
      "pinned?": false,
      "project-id": null,
      "active?": true,
      element: { "tab-id": 41, "backend-node-id": 10 },
    },
    {
      kind: "chat",
      id: "chat-pinned",
      title: "Pinned ideas",
      href: "/c/pinned",
      "pinned?": true,
      "project-id": null,
      "active?": false,
      element: { "tab-id": 41, "backend-node-id": 11 },
    },
  ]);
  assert.deepEqual(await service.dispatch("pinned", [], { tabId: 41 }), [chats[1]]);
  assert.deepEqual(await service.dispatch("projects", [], { tabId: 41 }), [{
    kind: "project",
    id: "project-opensource",
    title: "GW Opensource",
    href: "/g/g-p-opensource/project",
    "active?": false,
    element: { "tab-id": 41, "backend-node-id": 20 },
  }]);
});

test("ambiguous navigation landmarks fail closed", async () => {
  const environment = fixture({
    navigation: [
      snapshot({ backend: 1, tag: "nav", attributes: { role: "navigation" } }),
      snapshot({ backend: 2, tag: "nav", attributes: { role: "navigation" } }),
    ],
  });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("chats", [], { tabId: 41 }),
    (error) => error.code === "chatgpt/ui-unsupported",
  );
});

test("duplicate logical chat identities fail closed", async () => {
  const environment = fixture({
    chats: [
      chatA,
      snapshot({
        backend: 12,
        text: "Architecture duplicate",
        attributes: {
          href: "/c/architecture",
          "data-hara-chatgpt-kind": "chat",
          "data-chat-id": "chat-architecture",
        },
      }),
    ],
  });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("chats", [], { tabId: 41 }),
    (error) => error.code === "chatgpt/duplicate-identity",
  );
});

test("open-chat re-resolves logical identity and never clicks a stale supplied element", async () => {
  const environment = fixture({ chats: [chatA] });
  const service = createChatgptService({ domService: environment.domService });
  const result = await service.dispatch("open-chat", [{
    kind: ":chat",
    id: "chat-architecture",
    href: "/c/architecture",
    element: { "tab-id": 41, "backend-node-id": 999 },
  }], { tabId: 41 });
  assert.deepEqual(result, {
    opened: true,
    kind: "chat",
    id: "chat-architecture",
    href: "/c/architecture",
  });
  assert.deepEqual(environment.clicks, [{ "tab-id": 41, "backend-node-id": 10 }]);
});

test("open-project rejects missing entities without clicking", async () => {
  const environment = fixture({ projects: [projectA] });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("open-project", [{ kind: ":project", id: "missing" }], { tabId: 41 }),
    (error) => error.code === "chatgpt/entity-not-found",
  );
  assert.deepEqual(environment.clicks, []);
});
