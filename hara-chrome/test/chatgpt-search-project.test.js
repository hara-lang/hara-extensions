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
    value: attributes.value ?? null,
    checked: null,
    disabled: false,
  };
}

const navigation = snapshot({
  backend: 1,
  tag: "nav",
  attributes: {
    "data-hara-chatgpt-navigation": "true",
    "aria-label": "Chat history",
  },
});

const project = snapshot({
  backend: 20,
  text: "GW Opensource",
  attributes: {
    href: "/g/g-p-opensource/project",
    "data-hara-chatgpt-kind": "project",
    "data-project-id": "project-opensource",
  },
});

function fixture({
  url = "https://chatgpt.com/",
  searchInputInitially = false,
  searchResults = [],
  searchEmpty = [],
  searchTriggers = [snapshot({
    backend: 30,
    tag: "button",
    text: "Search chats",
    attributes: {
      "data-hara-chatgpt-action": "search",
      "aria-label": "Search chats",
    },
  })],
  projectChats = [],
  projects = [project],
} = {}) {
  let searchOpen = searchInputInitially;
  let currentResults = [];
  let currentEmpty = [];
  const calls = [];
  const clicks = [];
  const fills = [];
  const focuses = [];
  const searchInput = snapshot({
    backend: 31,
    tag: "input",
    attributes: {
      "data-hara-chatgpt-search-input": "true",
      role: "searchbox",
      placeholder: "Search chats",
      type: "search",
    },
  });
  const selectors = Object.fromEntries(
    Object.keys(CHATGPT_SELECTOR_PROFILE.selectors)
      .map((name) => [name, selectorFor(CHATGPT_SELECTOR_PROFILE, name)]),
  );
  const domService = {
    async dispatch(method, args, target) {
      calls.push({ method, args, target });
      if (method === "target") return { "tab-id": 41, url };
      if (method === "query-all") {
        switch (args[0]) {
          case selectors.signedOut: return [];
          case selectors.navigation: return [navigation];
          case selectors.projects: return projects;
          case selectors.pinned: return [];
          case selectors.chats: return [];
          case selectors.searchTrigger: return searchTriggers;
          case selectors.searchInput: return searchOpen ? [searchInput] : [];
          case selectors.searchResults: return currentResults;
          case selectors.searchEmpty: return currentEmpty;
          case selectors.projectChats: return projectChats;
          default: return [];
        }
      }
      if (method === "click") {
        clicks.push(args[0]);
        if (args[0]?.["backend-node-id"] === 30) searchOpen = true;
        return true;
      }
      if (method === "focus") {
        focuses.push(args[0]);
        return true;
      }
      if (method === "fill") {
        fills.push({ element: args[0], value: args[1] });
        currentResults = searchResults;
        currentEmpty = searchEmpty;
        return true;
      }
      throw new Error(`unexpected DOM operation: ${method}`);
    },
  };
  return { domService, calls, clicks, fills, focuses };
}

const searchResult = snapshot({
  backend: 40,
  text: "Runtime design A short result excerpt",
  attributes: {
    href: "/c/runtime-design",
    "data-hara-chatgpt-search-result": "true",
    "data-chat-id": "chat-runtime-design",
    "data-hara-chatgpt-title": "Runtime design",
    "data-hara-chatgpt-snippet": "A short result excerpt",
  },
});

const projectChat = snapshot({
  backend: 50,
  text: "Historia issue tracking",
  attributes: {
    href: "/c/historia-issues",
    "data-hara-chatgpt-project-chat": "true",
    "data-chat-id": "chat-historia-issues",
  },
});

test("search-chats opens visible search UI, fills the query, and returns bounded result snapshots", async () => {
  const environment = fixture({ searchResults: [searchResult] });
  const service = createChatgptService({ domService: environment.domService });
  const results = await service.dispatch("search-chats", ["runtime design"], { tabId: 41 });
  assert.deepEqual(results, [{
    kind: "chat-search-result",
    "chat-id": "chat-runtime-design",
    title: "Runtime design",
    snippet: "A short result excerpt",
    href: "/c/runtime-design",
    query: "runtime design",
    element: { "tab-id": 41, "backend-node-id": 40 },
  }]);
  assert.deepEqual(environment.clicks, [{ "tab-id": 41, "backend-node-id": 30 }]);
  assert.deepEqual(environment.focuses, [{ "tab-id": 41, "backend-node-id": 31 }]);
  assert.deepEqual(environment.fills, [{
    element: { "tab-id": 41, "backend-node-id": 31 },
    value: "runtime design",
  }]);
});

test("search-chats reuses an already visible search input without clicking a trigger", async () => {
  const environment = fixture({
    searchInputInitially: true,
    searchResults: [searchResult],
  });
  const service = createChatgptService({ domService: environment.domService });
  await service.dispatch("search-chats", ["runtime"], { tabId: 41 });
  assert.deepEqual(environment.clicks, []);
  assert.equal(environment.fills[0].value, "runtime");
});

test("search-chats returns an empty vector only after a visible empty state", async () => {
  const environment = fixture({
    searchEmpty: [snapshot({
      backend: 41,
      tag: "div",
      text: "No results",
      attributes: { "data-hara-chatgpt-search-empty": "true" },
    })],
  });
  const service = createChatgptService({ domService: environment.domService });
  assert.deepEqual(
    await service.dispatch("search-chats", ["no-such-chat"], { tabId: 41 }),
    [],
  );
});

test("invalid search queries fail before opening visible UI", async () => {
  const environment = fixture({ searchResults: [searchResult] });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("search-chats", ["   "], { tabId: 41 }),
    (error) => error.code === "chatgpt/invalid-search-query",
  );
  assert.deepEqual(environment.calls, []);
});

test("ambiguous search triggers fail closed without clicking", async () => {
  const environment = fixture({
    searchTriggers: [
      snapshot({ backend: 30, tag: "button", attributes: { "aria-label": "Search" } }),
      snapshot({ backend: 32, tag: "button", attributes: { "aria-label": "Search" } }),
    ],
  });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("search-chats", ["runtime"], { tabId: 41 }),
    (error) => error.code === "chatgpt/ui-unsupported",
  );
  assert.deepEqual(environment.clicks, []);
});

test("unsettled search results fail with a distinct timeout", async () => {
  const environment = fixture({ searchInputInitially: true });
  const service = createChatgptService({
    domService: environment.domService,
    searchTimeoutMs: 0,
  });
  await assert.rejects(
    service.dispatch("search-chats", ["runtime"], { tabId: 41 }),
    (error) => error.code === "chatgpt/search-timeout",
  );
});

test("project-chats lists chats only for the already open project", async () => {
  const environment = fixture({
    url: "https://chatgpt.com/g/g-p-opensource/project",
    projectChats: [projectChat],
  });
  const service = createChatgptService({ domService: environment.domService });
  const values = await service.dispatch("project-chats", [{
    kind: ":project",
    id: "project-opensource",
    href: "/g/g-p-opensource/project",
  }], { tabId: 41 });
  assert.deepEqual(values, [{
    kind: "chat",
    id: "chat-historia-issues",
    title: "Historia issue tracking",
    href: "/c/historia-issues",
    "pinned?": false,
    "project-id": "project-opensource",
    "active?": false,
    element: { "tab-id": 41, "backend-node-id": 50 },
  }]);
});

test("project-chats fails before reading project content when another page is open", async () => {
  const environment = fixture({
    url: "https://chatgpt.com/",
    projectChats: [projectChat],
  });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("project-chats", [{
      kind: ":project",
      id: "project-opensource",
      href: "/g/g-p-opensource/project",
    }], { tabId: 41 }),
    (error) => error.code === "chatgpt/project-not-open",
  );
  const projectChatSelector = selectorFor(CHATGPT_SELECTOR_PROFILE, "projectChats");
  assert.equal(
    environment.calls.filter((call) => call.method === "query-all" && call.args[0] === projectChatSelector).length,
    0,
  );
});

test("duplicate search-result identities fail closed", async () => {
  const environment = fixture({
    searchResults: [
      searchResult,
      snapshot({
        backend: 42,
        text: "Duplicate",
        attributes: {
          href: "/c/runtime-design",
          "data-hara-chatgpt-search-result": "true",
          "data-chat-id": "chat-runtime-design",
          "data-hara-chatgpt-title": "Duplicate",
        },
      }),
    ],
  });
  const service = createChatgptService({ domService: environment.domService });
  await assert.rejects(
    service.dispatch("search-chats", ["runtime"], { tabId: 41 }),
    (error) => error.code === "chatgpt/duplicate-identity",
  );
});

test("hidden empty-state markers do not settle search prematurely", async () => {
  const environment = fixture({
    searchInputInitially: true,
    searchEmpty: [snapshot({
      backend: 43,
      tag: "div",
      text: "No results",
      attributes: {
        hidden: "",
        "data-hara-chatgpt-search-empty": "true",
      },
    })],
  });
  const service = createChatgptService({
    domService: environment.domService,
    searchTimeoutMs: 0,
  });
  await assert.rejects(
    service.dispatch("search-chats", ["runtime"], { tabId: 41 }),
    (error) => error.code === "chatgpt/search-timeout",
  );
});
