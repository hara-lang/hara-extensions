# Toolbar connection control

The pinned **hara** toolbar action is the compact control surface for the browser runtime. It is a status-and-switch panel rather than a website dashboard.

Each switch shows two independent facts:

- the switch position is the requested state;
- the lamp and status label are the actual state.

An enabled switch may therefore report `STARTING`, `CONNECTING`, `UNAVAILABLE`, or `ERROR` instead of pretending that the operation already succeeded.

## Connections

**Current tab** binds one exact positive Chrome tab ID. Activating another browser tab does not transfer DOM, ChatGPT, or Tripo authority.

**Hara runtime** creates or closes the shared offscreen runtime document. The offscreen host owns Hara WASM, evaluator workers, IndexedDB filesystem sessions, kernels, graph workers, and the browser-side RESP client.

**RESP** connects or disconnects the offscreen runtime from the configured bridge URL. The default is:

```text
ws://127.0.0.1:7356
```

**ChatGPT adapter** or **Tripo Studio adapter** appears only when the bound page has a reviewed contextual adapter. Disabling it denies new site-adapter host calls for that exact tab. Generic DOM status remains separate.

Downloads are status-only. Tripo capture is armed only around an explicitly confirmed `download-asset` operation; it is not a persistent toolbar switch.

## Quick operations

`OPEN REPL` starts the shared runtime when needed and opens or focuses one extension panel bound to the exact selected tab.

`RECONNECT` reasserts the requested runtime and RESP state without rebinding to whichever tab later became active.

`DISCONNECT ALL` closes RESP, shuts down the offscreen runtime, clears contextual adapter authority and the tab binding, and closes a popup-owned REPL tab. It does not modify the controlled webpage.

## Recovery

Requested preferences are stored in `chrome.storage.local`. Recoverable tab and connection state are stored in `chrome.storage.session`. The service worker reconstructs the panel after suspension and discovers an existing offscreen document through `chrome.runtime.getContexts`.

The popup uses the typed protocol:

```text
greenways.hara-control/0-alpha
```
