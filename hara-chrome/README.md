# hara-chrome

Chrome (MV3) DevTools extension for inspecting live Hara browser kernels and
bridging them to Emacs or VS Code over Hara RESP protocol 4.

The panel still contains its own shared Studio environment, but the toolbar now
scans the inspected page and lists every kernel exposed through either:

- `globalThis[Symbol.for("hara.devtools.registry.v1")]`, the preferred stable
  page debugging contract; or
- `window.hara = { broker, ... }`, the compatibility adapter used by existing
  Hara browser applications.

Selecting a page kernel makes it the target used by the RESP bridge and by
`window.hara.evalSource`. Local DevTools kernels remain available under
**DevTools Local**.

## Build

    npm install
    npm run build

## Load

`chrome://extensions` -> developer mode -> **Load unpacked** -> select this
directory. Open DevTools and choose the **hara** panel.

## Test

    npm test
    npm run test:browser

The page-target and protocol tests can be run without the built WASM vendor
files:

    node --test test/page-target.test.js test/resp-protocol.test.js

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

Start the local bridge:

    node bridge/resp-bridge.mjs

Defaults:

- RESP: `127.0.0.1:7355`
- extension WebSocket: `127.0.0.1:7356`

Then press **connect RESP** in the DevTools toolbar. The bridge implements Hara
protocol 4 framing used by `hara-mode`, including `HELLO`, `INFO`, `TARGET`,
`SESSION`, `EVAL`, `LOAD`, `DOC`, `COMPLETE`, `PING` and `QUIT`. It also keeps
legacy `EVAL <session> <source>`, `SESSION CREATE` and `SESSION DELETE` aliases
for the current VS Code client.

Typical protocol flow:

```text
HELLO 4 CLIENT EMACS
TARGET LIST
TARGET ATTACH page:app
SESSION LIST
SESSION ATTACH game
EVAL REQ-1 "(+ 1 2)"
```

### Optional token

Set `HARA_BRIDGE_TOKEN` when launching the bridge and include the same token in
the toolbar URL:

    HARA_BRIDGE_TOKEN=secret node bridge/resp-bridge.mjs

    ws://127.0.0.1:7356/?token=secret

## Home directory

The panel can load `.hal` sources from a local directory:

- **choose home** picks a directory and restores it when permission remains.
- `project.edn` or `project.hal` supplies `:source-paths`.
- **run .hal file** evaluates the file in the selected page or local kernel.
- Namespace preloading from the chosen home applies to local DevTools kernels;
  page kernels resolve resources using the page application's own loader.

## Trust boundaries

Both listeners bind to `127.0.0.1`. A bridge token is recommended on shared or
multi-user machines. A connected editor can evaluate code in the selected Hara
kernel, and a local DevTools kernel can use the extension's privileged Chrome
host calls. Page inspection uses `chrome.devtools.inspectedWindow.eval`, so the
extension does not request broad page host permissions.

Targets are rescanned after navigation. A pending request fails with
`HARA_PAGE_RELOADED` when the inspected document changes before it completes.
