# hara-lsp

The shared Hara language service for `.hal` buffers.

The service itself is native Hara in [`src/hara/lsp/service.hal`](src/hara/lsp/service.hal). It delegates parsing and semantic findings to `tool.lint.analyze`, keeps an open-document registry, and exposes diagnostics, completion, hover, definitions, document/workspace symbols, references, rename, and formatting through a small LSP JSON-RPC host.

The Rust executable in [`src/main.rs`](src/main.rs) owns only the process boundary:

1. Read Content-Length framed JSON-RPC from stdin.
2. Start a Hara lite runtime in headless RESP mode.
3. Evaluate the Hara service with JSON values.
4. Write LSP responses and `publishDiagnostics` notifications to stdout.

This keeps editor protocol concerns out of Hara while keeping language behavior in Hara. RESP remains the stateful evaluation/REPL protocol used by `hara-mode`; LSP is the asynchronous analysis path.

## Build and install

```sh
cargo check
cargo build --release
make install
```

By default, installation places `hara-lsp` in `~/.local/bin` and the Hara service project in `~/.local/share/hara-lsp`. The host discovers the runtime in this order:

1. `--runtime PATH`;
2. `HARA_RUNTIME`;
3. `/home/hoebat/.local/bin/hara-rust-lite`;
4. `hara-rust-lite`, `hara-lite`, or `hara` on `PATH`.

Set `HARA_LSP_PROJECT` or pass `--service-project PATH` when the service project is outside the workspace or installed share directory.

## Current boundaries

Document open/change notifications only store the latest text and version and
clear stale diagnostics; they do not analyze the source. Completion is a
latency-sensitive exception: it returns static forms and definitions from an
analysis already cached for the current version, and never starts semantic
analysis itself. Other semantic requests (navigation, symbols, hover,
references, rename, and formatting) analyze a document on demand and cache the
result by document version. The custom `hara/diagnostics` request performs an
explicit analysis and publishes a
`textDocument/publishDiagnostics` notification. References and rename therefore
cover the documents known to the running language-service session; Eglot
synchronizes buffers as they are visited. Formatting currently removes trailing
spaces and tabs, leaving Hara's semantic formatter as a separate future service
operation.

The Hara analyzer currently exposes exact parsed block offsets, while some legacy lint findings still carry coarse `block/info` spans. The service recovers the unresolved token range from the finding message so editors underline the actual symbol.
