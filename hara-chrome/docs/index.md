# hara-chrome

A Chrome MV3 DevTools extension that embeds the Hara WASM runtime in a panel,
exposes a local RESP REPL, and provides a closed DOM-control surface.

```clojure
(require [browser.dom :as dom])
(require [chrome.api :as api])
```

## Guides

- [Browser control examples](browser-control-examples.md) — forms, scrolling,
  mouse and keyboard input, network observation, interception, blocking, and
  request headers.
- [ChatGPT web-app REPL map](chatgpt-webapp-repl.md) — a read-only-first,
  fail-closed design for chats, projects, pinned chats, search, composer
  control, and later reversible organization actions.
- [ChatGPT capability manifest](chatgpt-webapp-capabilities.edn) —
  machine-readable entities, operations, risk levels, confirmation contracts,
  selector policy, and delivery phases.

## Runtime features

- **Panel Studio** — the shared Hara Studio environment running the raw Hara
  WASM runtime in Web Workers.
- **`browser.dom`** — panel-bound query, snapshot, refresh, focus, fill, click,
  and detach operations using opaque backend node references.
- **`chrome.api`** — lower-level Chrome and CDP calls for reviewed development
  workflows.
- **Target binding** — `make dev URL=...` resolves one exact CDP target to one
  exact Chrome tab ID before opening the panel.
- **Home directory** — pick a local directory and load or require `.hal` files.
- **RESP endpoint** — a loopback RESP TCP to WebSocket bridge lets editor tools
  evaluate Hara inside the browser runtime.

See the repository README for build, test, lifecycle, and trust-boundary
details.
