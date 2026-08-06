import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createPageTargetClient, flattenPageTargets, pageDispatch } from "../src/page-target.js";

const previous = {
  hara: globalThis.hara,
  registry: globalThis[Symbol.for("hara.devtools.registry.v1")],
};

afterEach(() => {
  if (previous.hara === undefined) delete globalThis.hara;
  else globalThis.hara = previous.hara;
  if (previous.registry === undefined) delete globalThis[Symbol.for("hara.devtools.registry.v1")];
  else globalThis[Symbol.for("hara.devtools.registry.v1")] = previous.registry;
  delete globalThis.__haraDevtoolsRpcV1;
});

function fakeRuntime() {
  const kernels = new Map([["ROOT", {}], ["game", {}]]);
  const pending = new Map([["loading", Promise.resolve()]]);
  return {
    studio: { state: { kernel: "game", space: "home" } },
    broker: {
      kernels,
      pending,
      documents: new Map([["game\0/main.hal", {
        kernel: "game", documentId: "main.hal", generation: 3, moduleId: "anonymous:main.3",
      }]]),
      list: () => [...kernels.keys()],
      eval: async (session, source) => `${session}:${source}`,
      create: async (name) => { kernels.set(name, {}); return name; },
      close: async (name) => { kernels.delete(name); return true; },
    },
  };
}

test("pageDispatch describes and evaluates window.hara kernels", async () => {
  globalThis.hara = fakeRuntime();
  const description = await pageDispatch({ op: "describe" });
  assert.equal(description.brokers[0].activeKernel, "game");
  assert.deepEqual(description.brokers[0].pending, ["loading"]);
  assert.equal(description.brokers[0].documents[0].generation, 3);
  assert.equal(await pageDispatch({ op: "eval", session: "game", source: "(+ 1 2)" }), "game:(+ 1 2)");
  await pageDispatch({ op: "session.new", session: "scratch" });
  assert.ok((await pageDispatch({ op: "session.list" })).includes("scratch"));
});

test("pageDispatch prefers the explicit devtools registry", async () => {
  globalThis.hara = fakeRuntime();
  globalThis[Symbol.for("hara.devtools.registry.v1")] = {
    dispatch: async (request) => ({ registry: true, op: request.op }),
  };
  assert.deepEqual(await pageDispatch({ op: "describe" }), { registry: true, op: "describe" });
});

test("createPageTargetClient settles async page operations through the mailbox", async () => {
  globalThis.hara = fakeRuntime();
  const inspectedWindow = {
    eval(expression, callback) {
      queueMicrotask(() => {
        try { callback((0, eval)(expression), null); }
        catch (error) { callback(undefined, { value: error.message }); }
      });
    },
  };
  const client = createPageTargetClient(inspectedWindow, { timeout: 1000, pollInterval: 1 });
  assert.equal(await client.eval({ session: "ROOT", source: "42" }), "ROOT:42");
  assert.deepEqual(await client.list(), ["ROOT", "game"]);
});

test("flattenPageTargets creates selectable page kernel records", () => {
  const targets = flattenPageTargets({
    page: { title: "Demo", url: "https://example.test" },
    brokers: [{ id: "main", label: "Demo", kernels: [{ name: "ROOT", active: true }] }],
  });
  assert.deepEqual(targets[0], {
    id: "page:main:ROOT",
    environmentId: "page:main",
    kind: "page",
    brokerId: "main",
    kernel: "ROOT",
    label: "Demo · ROOT",
    state: "running",
    active: true,
    page: { title: "Demo", url: "https://example.test" },
  });
});
