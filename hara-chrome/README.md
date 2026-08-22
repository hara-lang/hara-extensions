# hara-chrome

Chrome (MV3) DevTools extension for inspecting live Hara browser kernels and
bridging them to Emacs or VS Code over Hara RESP protocol 4.

The panel contains its own shared Studio environment, and its toolbar scans the
inspected page for every kernel exposed through either:

- `globalThis[Symbol.for("hara.devtools.registry.v1")]`, the preferred stable
  page debugging contract; or
- `window.hara = { broker, ... }`, the compatibility adapter used by existing
  Hara browser applications.

Selecting a page kernel makes it the target used by the RESP bridge and by
`window.hara.evalSource`. Local DevTools kernels remain available under
**DevTools Local**.

## Meta-workspace layout

The build resolves Hara from the Greenways meta-workspace rather than from the
standalone Greenways OS repository:

```text
$HARA_WORKSPACE_ROOT/
  extensions/hara-chrome
  technology/hara
```

`HARA_WORKSPACE_ROOT` is detected by walking up from this directory. Set it
explicitly when invoking the extension from another checkout layout.

## Long-lived headless development runtime

From `extensions/hara-chrome`:

```sh
make dev
```

This command:

1. installs missing npm dependencies and Playwright's bundled full Chromium;
2. builds the VM WASM artifact with
   `technology/hara/scripts/runtime/build-hara-wasm-raw`;
3. stages the browser runtime with the native `scripts/sync-runtime.hal`
   workflow;
4. starts the loopback RESP and token-protected WebSocket bridge;
5. launches the unpacked extension in a persistent, full headless Chromium
   context;
6. opens or reuses the configured target URL, resolves that page's exact CDP
   target to its Chrome tab ID, and opens the panel bound to that tab; and
7. verifies both `(+ 40 2)` and `browser.dom/target` through protocol 4, logs
   the final target URL and tab ID, then prints the RESP readiness line.

The default profile is disposable. Supply `PROFILE_DIR` only when browser state
must survive between runs:

```sh
make dev RESP_PORT=7355 WS_PORT=7356 PROFILE_DIR="$HOME/.hara-chrome-profile"
```

Bind the runtime to a page with `URL` (default `about:blank`):

```sh
make dev URL=https://example.test/editor
```

Readiness is emitted in this order, after the exact tab binding and DOM smoke:

```text
HARA TARGET https://example.test/editor TAB 73
HARA RESP 127.0.0.1:7355
```

Other supported overrides are:

```sh
make dev HARA_WORKSPACE_ROOT=/path/to/greenways-workspace
make dev RESP_PORT=17355 WS_PORT=17356
```

`make dev` builds once. File watching and automatic extension reload are not
part of this workflow.

## Build

```sh
make build
```

`npm run build` delegates to the same Makefile-owned build. To stage assets
without rebuilding WASM, use `make sync` or `npm run sync`.

The native sync copies the current HTA package tree, host support, Studio tree,
VM WASM artifact, and versioned Hara UI files. This preserves current relative
module imports such as `hta.js -> packages/hta/index.js` and
`studio/broker.js -> host/broker.js`.

## Load manually

`chrome://extensions` -> developer mode -> **Load unpacked** -> select this
directory. Open DevTools and choose the **hara** panel.

## Emacs connection

No `hara-emacs` changes are needed. Configure the external browser runtime:

```elisp
(setq hara-host "127.0.0.1"
      hara-port 7355
      hara-auto-start nil)
```

`hara-mode` negotiates `HELLO 4`, attaches to the browser's `ROOT` session, and
uses the existing `EVAL`, `SESSION`, `DOC`, and `COMPLETE` commands.

## Headless DOM access

The panel registers a closed `browser.dom` Hara module alongside `chrome.api`:

```clojure
(require [browser.dom :as dom])
(dom/target)
(dom/query "#save")
(dom/query-all ".row")
(dom/query-all ".row" 250)
(dom/refresh element)
(dom/focus element)
(dom/fill element "new value")
(dom/click element)
(dom/detach)
```

Element values are serializable snapshots containing an opaque
`backend-node-id`; no live page object crosses the bridge. `query-all` defaults
to 100 results, accepts at most 1,000, and raises `dom/result-limit` rather than
truncating. Version one stays within the top-level document. Iframe and shadow
root traversal are intentionally deferred.

The service automatically owns a reference-counted `chrome.debugger` lease,
uses fixed CDP DOM/Input operations, invalidates references after navigation,
and detaches when the panel disconnects. It does not add `chrome.userScripts`,
content-script injection, or another caller-supplied JavaScript interface.

Distinct failures include `dom/invalid-selector`, `dom/missing-target`,
`dom/detached-node`, `dom/navigation-invalidated`, `dom/invalid-reference`,
`dom/invalid-limit`, and `dom/result-limit`.

## Test

```sh
make test
make test-fast
make test-sync
make test-browser
```

`make test` is clean-checkout capable: it builds and stages runtime assets
before any Node test imports `vendor/`. `make test-fast` keeps a focused suite
for protocol, launcher, DOM validation, and cleanup code that does not require
runtime assets. `make test-sync` uses separate Hara processes to evaluate the
native sync candidate, execute the written workflow, and validate focused
staged assets.
`make test-browser` builds first, installs full Chromium when absent, and runs
the Playwright suite directly in unified headless mode; Xvfb is not required.

The page-target and protocol tests can still run without built WASM vendor
files:

```sh
node --test test/page-target.test.js test/resp-protocol.test.js
```

Browser integration covers a real unpacked extension on isolated bridge ports,
protocol-4 negotiation, `ROOT` attachment, and an Emacs-framed
`(+ 40 2) -> 42` evaluation. The launcher lifecycle test terminates the
long-lived process and checks that Chromium cleanup has completed and both
listener ports are closed.

## Kernel inspection contract

A page can expose multiple brokers through a registry:

```js
const key = Symbol.for("hara.devtools.registry.v1");
globalThis[key] = {
  describe: async () => ({
    version: 1,
    brokers: [{
      id: "app",
      label: "My Hara app",
      activeKernel: "ROOT",
      kernels: [{ name: "ROOT", state: "running", active: true }],
      documents: [],
    }],
  }),
  eval: ({ brokerId, session, source }) => appBroker.eval(session, source),
  listKernels: ({ brokerId }) => appBroker.list(),
  inspectKernel: ({ session }) => ({ name: session }),
  createKernel: ({ session }) => appBroker.create(session),
  closeKernel: ({ session }) => appBroker.close(session),
};
```

For a single broker, exposing `window.hara.broker` is enough for discovery,
evaluation, creation and closure. The explicit registry is recommended because
it can provide richer telemetry, documentation, completion and multiple broker
identities without exposing internal objects.

## RESP bridge

The development launcher owns the bridge automatically. It can also be started
on its own:

```sh
node bridge/resp-bridge.mjs
```

Defaults:

- RESP: `127.0.0.1:7355`
- extension WebSocket: `127.0.0.1:7356`

The bridge implements Hara protocol 4 framing used by `hara-mode`, including
`HELLO`, `INFO`, `TARGET`, `SESSION`, `EVAL`, `LOAD`, `DOC`, `COMPLETE`, `PING`
and `QUIT`. It also keeps legacy `EVAL <session> <source>`, `SESSION CREATE` and
`SESSION DELETE` aliases for the current VS Code client.

Typical protocol flow:

```text
HELLO 4 CLIENT EMACS
TARGET LIST
TARGET ATTACH page:app
SESSION LIST
SESSION ATTACH game
EVAL REQ-1 "(+ 1 2)"
```

### Bridge token

`make dev` generates an ephemeral WebSocket token and places it only in the
panel URL. For a manually launched bridge, set `HARA_BRIDGE_TOKEN` and include
the same token in the toolbar URL:

```sh
HARA_BRIDGE_TOKEN=secret node bridge/resp-bridge.mjs
```

```text
ws://127.0.0.1:7356/?token=secret
```

## Home directory

The panel can load `.hal` sources from a local directory:

- **choose home** picks a directory and restores it when permission remains.
- `project.edn` or `project.hal` supplies `:source-paths`.
- **run .hal file** evaluates the file in the selected page or local kernel.
- Namespace preloading from the chosen home applies to local DevTools kernels;
  page kernels resolve resources using the page application's own loader.

## Trust boundaries

Both listeners bind to `127.0.0.1`. A connected editor can evaluate code in the
selected Hara kernel, and a local DevTools kernel can use the extension's
privileged Chrome host calls. Page inspection uses
`chrome.devtools.inspectedWindow.eval`, so the extension does not request broad
page host permissions.

Targets are rescanned after navigation. A pending request fails with
`HARA_PAGE_RELOADED` when the inspected document changes before it completes.
