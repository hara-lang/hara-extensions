export const CHATGPT_PROFILE_PROTOCOL = "greenways.chatgpt-selector-profile/0-alpha";

const freezeList = (values) => Object.freeze([...values]);

export const CHATGPT_SELECTOR_PROFILE = Object.freeze({
  protocol: CHATGPT_PROFILE_PROTOCOL,
  id: "chatgpt-web/en/1",
  version: 1,
  locale: "en",
  origins: freezeList(["https://chatgpt.com"]),
  selectors: Object.freeze({
    navigation: freezeList([
      '[data-hara-chatgpt-navigation="true"]',
      'nav[aria-label*="Chat" i]',
      '[role="navigation"][aria-label*="Chat" i]',
      "nav",
      '[role="navigation"]',
    ]),
    signedOut: freezeList([
      '[data-hara-chatgpt-signed-in="false"]',
      'a[href*="/auth/login"]',
      'button[data-testid="login-button"]',
      'button[aria-label*="Log in" i]',
      'a[aria-label*="Log in" i]',
    ]),
    chats: freezeList([
      'a[data-hara-chatgpt-kind="chat"][href]',
      '[data-hara-chatgpt-navigation="true"] a[href^="/c/"]',
      'nav a[href^="/c/"]',
      '[role="navigation"] a[href^="/c/"]',
    ]),
    pinned: freezeList([
      'a[data-hara-chatgpt-pinned="true"][href]',
      '[data-hara-chatgpt-section="pinned"] a[href]',
      '[aria-label*="Pinned" i] a[href]',
    ]),
    projects: freezeList([
      'a[data-hara-chatgpt-kind="project"][href]',
      '[data-hara-chatgpt-section="projects"] a[href]',
      '[aria-label*="Projects" i] a[href]',
    ]),
    searchTrigger: freezeList([
      '[data-hara-chatgpt-action="search"]',
      'button[data-testid*="search" i]',
      'button[aria-label*="Search" i]',
      '[role="button"][aria-label*="Search" i]',
    ]),
    searchInput: freezeList([
      'input[data-hara-chatgpt-search-input="true"]',
      '[role="dialog"] input[role="searchbox"]',
      '[role="dialog"] input[placeholder*="Search" i]',
      'input[type="search"][placeholder*="Search" i]',
    ]),
    searchResults: freezeList([
      'a[data-hara-chatgpt-search-result="true"][href]',
      '[data-hara-chatgpt-search-results="true"] a[href]',
      '[role="dialog"] a[href^="/c/"]',
    ]),
    searchEmpty: freezeList([
      '[data-hara-chatgpt-search-empty="true"]',
      '[role="dialog"] [data-empty="true"]',
      '[role="dialog"] [aria-label*="No results" i]',
    ]),
    projectChats: freezeList([
      'a[data-hara-chatgpt-project-chat="true"][href]',
      '[data-hara-chatgpt-project-chats="true"] a[href]',
      'main [data-project-id] a[href^="/c/"]',
    ]),
  }),
});

export function selectorFor(profile, name) {
  const values = profile?.selectors?.[name];
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError(`ChatGPT selector group is missing: ${name}`);
  }
  return values.join(", ");
}
