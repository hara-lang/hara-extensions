import http from "node:http";
import { test, expect } from "@playwright/test";
import { launchWithExtension } from "./extension.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function pageHtml(title) {
  return `<!doctype html>
  <meta charset="utf-8">
  <title>${title}</title>
  <ul>
    <li class="row">one</li>
    <li class="row">two</li>
    <li class="row">three</li>
  </ul>
  <label>Name <input id="name" value="old"></label>
  <textarea id="notes">old notes</textarea>
  <select id="choice"><option value="a">A</option><option value="b">B</option></select>
  <div id="editable" contenteditable="true">before</div>
  <button id="save" data-kind="primary">Save</button>
  <script>
    globalThis.haraDomEvents = [];
    globalThis.haraDomClicks = 0;
    for (const type of ["input", "change"]) {
      document.querySelector("#name").addEventListener(type, (event) => {
        globalThis.haraDomEvents.push([event.type, event.bubbles, event.target.value]);
      });
    }
    document.querySelector("#save").addEventListener("click", () => {
      globalThis.haraDomClicks += 1;
    });
  </script>`;
}

async function evalHara(panel, source) {
  return panel.evaluate(async (text) => {
    const value = await globalThis.hara.evalLocalSource(text);
    const plain = (input) => {
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

test("browser.dom mirrors and interacts with the exact bound top-level target", async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pageHtml(request.url === "/next" ? "next" : "DOM fixture"));
  });
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}/`;
  const runtime = await launchWithExtension({ url: origin });
  const panel = await runtime.openPanel();

  try {
    await evalHara(panel, "(require [browser.dom :as dom])");
    const target = await evalHara(panel, "(dom/target)");
    expect(target["tab-id"]).toBe(runtime.tabId);
    expect(target.url).toBe(origin);

    const save = await evalHara(panel, '(dom/query "#save")');
    expect(save).toMatchObject({
      "tab-id": runtime.tabId,
      tag: "button",
      text: "Save",
      attributes: { id: "save", "data-kind": "primary" },
      disabled: false,
    });
    expect(Number.isInteger(save["backend-node-id"])).toBe(true);

    const refreshedSave = await evalHara(panel, "(dom/refresh (dom/query \"#save\"))");
    expect(refreshedSave["backend-node-id"]).toBe(save["backend-node-id"]);

    const rows = await evalHara(panel, '(dom/query-all ".row")');
    expect(rows.map((row) => row.text)).toEqual(["one", "two", "three"]);
    expect(await evalHara(panel, '(dom/query ".not-present")')).toBeNull();
    await expect(evalHara(panel, '(dom/query "[")'))
      .rejects.toThrow(/dom\/invalid-selector/);

    await evalHara(panel, '(def field (dom/query "#name"))');
    expect(await evalHara(panel, "(dom/focus field)")).toBe(true);
    expect(await evalHara(panel, '(dom/fill field "new value")')).toBe(true);
    expect(await runtime.targetPage.evaluate(() => ({
      active: document.activeElement.id,
      value: document.querySelector("#name").value,
      events: globalThis.haraDomEvents,
    }))).toEqual({
      active: "name",
      value: "new value",
      events: [
        ["input", true, "new value"],
        ["change", true, "new value"],
      ],
    });

    await evalHara(panel, '(dom/fill (dom/query "#notes") "new notes")');
    await evalHara(panel, '(dom/fill (dom/query "#choice") "b")');
    await evalHara(panel, '(dom/fill (dom/query "#editable") "after")');
    expect(await runtime.targetPage.evaluate(() => ({
      notes: document.querySelector("#notes").value,
      choice: document.querySelector("#choice").value,
      editable: document.querySelector("#editable").textContent,
    }))).toEqual({ notes: "new notes", choice: "b", editable: "after" });

    await evalHara(panel, '(def save-button (dom/query "#save"))');
    expect(await evalHara(panel, "(dom/click save-button)")).toBe(true);
    await expect.poll(() => runtime.targetPage.evaluate(() => globalThis.haraDomClicks)).toBe(1);

    await expect(evalHara(panel, '(dom/query-all ".row" 2)'))
      .rejects.toThrow(/dom\/result-limit/);

    await evalHara(panel, '(def notes-field (dom/query "#notes"))');
    await runtime.targetPage.evaluate(() => document.querySelector("#notes").remove());
    await expect(evalHara(panel, "(dom/refresh notes-field)"))
      .rejects.toThrow(/dom\/detached-node/);

    await runtime.targetPage.goto(`${origin}next`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => {
      try {
        await evalHara(panel, "(dom/refresh save-button)");
        return "";
      } catch (error) {
        return String(error?.message ?? error);
      }
    }).toContain("dom/navigation-invalidated");
    expect(await evalHara(panel, "(dom/detach)")).toBe(true);
  } finally {
    await runtime.close();
    await closeServer(server);
  }
});
