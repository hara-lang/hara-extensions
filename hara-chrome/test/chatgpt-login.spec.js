import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

function fixtureHtml() {
  return `<!doctype html>
  <meta charset="utf-8">
  <title>ChatGPT login fixture</title>
  <main id="app" data-hara-chatgpt-signed-in="false">
    <button type="button"
            data-hara-chatgpt-action="login"
            aria-label="Log in">Log in</button>
  </main>
  <script>
    document.querySelector('[data-hara-chatgpt-action="login"]').addEventListener('click', () => {
      history.pushState({}, '', '/auth/login?state=fixture-secret');
      document.querySelector('#app').innerHTML =
        '<form action="/auth/login" data-hara-chatgpt-auth-state="credentials">' +
        '<input type="email" autocomplete="username" aria-label="Email">' +
        '</form>';
      document.querySelector('#app').removeAttribute('data-hara-chatgpt-signed-in');
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

test("browser.site.chatgpt checks login and waits for user-controlled completion", async () => {
  const runtime = await launchWithExtension();
  await runtime.context.route("https://chatgpt.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: fixtureHtml(),
    });
  });
  await runtime.targetPage.goto("https://chatgpt.com/?hara-fixture=login", {
    waitUntil: "domcontentloaded",
  });
  const panel = await runtime.openPanel();

  try {
    await evalHara(panel, "(require [browser.site.chatgpt :as chatgpt])");
    const signedOut = await evalHara(panel, "(chatgpt/login-status)");
    expect(signedOut).toMatchObject({
      state: "signed-out",
      "signed-in?": false,
      "credential-handling": "browser-only",
    });

    const started = await evalHara(panel, "(chatgpt/login-start)");
    expect(started).toMatchObject({
      state: "authentication-required",
      started: true,
      "user-action-required?": true,
    });
    expect(started.url).toBe("https://chatgpt.com/auth/login");
    expect(started.url).not.toContain("fixture-secret");

    await runtime.targetPage.evaluate(() => {
      setTimeout(() => {
        history.pushState({}, "", "/");
        document.body.innerHTML =
          '<nav aria-label="Chat history" data-hara-chatgpt-navigation="true"></nav>';
      }, 50);
    });
    const signedIn = await evalHara(panel, "(chatgpt/login-wait 5000)");
    expect(signedIn).toMatchObject({
      state: "signed-in",
      "signed-in?": true,
      "user-action-required?": false,
    });
  } finally {
    await runtime.close();
  }
});
