# Shared offscreen Hara runtime

The browser-local Hara runtime is hosted in:

```text
src/runtime-host.html
```

It is a Manifest V3 offscreen document created for the `WORKERS` reason. The document uses ordinary web-platform APIs and `chrome.runtime` messaging only. Chrome debugger, downloads, tabs, storage, and site-adapter authority remain in the background service worker.

## Ownership

The offscreen host owns:

- the raw Hara WASM module;
- one evaluator worker per kernel;
- the graph/program worker host;
- the session router and capability registry;
- IndexedDB-backed filesystem mounts;
- active kernels and private document generations;
- preview sessions and traces;
- the browser-side RESP WebSocket.

The toolbar popup and DevTools/extension panel are clients. Closing either UI disconnects its client ports but does not stop the runtime.

## Lifecycles

Starting the runtime:

```text
popup or panel
  → background runtime supervisor
  → ensure one offscreen document
  → offscreen broker loads WASM and ROOT
  → actual state becomes READY
```

Closing a panel:

```text
panel client disconnects
  → page-target provider is removed
  → offscreen kernels, filesystem and RESP remain alive
```

Stopping the runtime:

```text
explicit runtime-off or disconnect-all
  → offscreen broker closes RESP and kernels
  → workers and document sessions are reaped
  → background closes the offscreen document
```

## Service-worker suspension

The offscreen host reconnects its `hara-runtime-host` and `hara-host` ports after a service-worker restart. The background supervisor then reads the host's current status rather than reconstructing kernel state from service-worker globals.

Current runtime state is exposed through:

```text
greenways.hara-runtime/0-alpha
```

The page-target provider is intentionally transient. When a DevTools panel is open it can contribute page-resident Hara targets. Closing the panel removes that provider, while the local offscreen target and RESP connection remain available.

## Compatibility

`panel.html` continues to expose `window.hara`, `window.hara.ready`, target selection, file preload, the Studio interface, and RESP controls. Its broker is now a typed remote proxy; it no longer fetches Hara WASM, creates evaluator workers, opens IndexedDB filesystem sessions, or owns the RESP socket.

The first offscreen slice requires Chrome 116 or later so the service worker can discover the existing document with `chrome.runtime.getContexts`.
