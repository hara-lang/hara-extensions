# Local Hara language host

Hara Chrome can act as an outbound execution host for the local `hara-mcp` loopback relay. This is a separate runtime profile from browser control.

```text
MCP client
  -> local hara-mcp
  -> http://127.0.0.1:<port>
  <- Hara Chrome outbound register / poll / result
  -> fresh hara.mcp-pure/0-alpha BrowserWasmSandbox
```

The local language host is dormant by default. Enable it only through the exact `chrome.storage.local` record named `hara.language-host.local/0-alpha`:

```json
{
  "enabled": true,
  "relayUrl": "http://127.0.0.1:8765",
  "token": "replace-with-a-random-development-token",
  "hostId": "hara.chrome.local",
  "generation": 1
}
```

The relay URL must use explicit IPv4 loopback HTTP with a port. `localhost`, LAN addresses, public addresses, TLS, credentials in the URL, paths, query strings, and fragments are rejected. The token authenticates only the local HTTP transport. It is not copied into host descriptors, execution requests, results, diagnostics, status projections, or logs.

## Advertised capability

The first delivery advertises exactly:

```text
profile      hara.mcp-pure/0-alpha
operations   runtime.get, sandbox.eval
backend      raw-wasm
```

`sandbox.call` and `sandbox.check` are not advertised until the canonical Hara sandbox implements them. Unknown or overclaimed capability fails closed.

Each eval creates a new Hara-owned `BrowserWasmSandbox`, a new Worker, and a new raw-Wasm instance. The adapter invokes exact `sandbox/eval`, verifies the source SHA-256 digest, returns a bounded transfer-safe value, closes the sandbox, and reports cleanup evidence.

The remote worker receives no browser broker, `ROOT`, RESP connection, Chrome or DOM adapter, IndexedDB home, filesystem host, parent Kernel/Session/Runtime, provider credential, or ambient host-call table. Browser-control permissions remain available only to the separately controlled trusted local runtime.

## Local relay

Start `hara-mcp` with matching settings:

```sh
HARA_MCP_LOOPBACK_TOKEN='replace-with-a-random-development-token' \
HARA_MCP_LOOPBACK_PORT=8765 \
HARA_MCP_LOOPBACK_ORIGIN='chrome-extension://<extension-id>' \
npm run dev
```

Then configure the storage record and ensure the offscreen Hara runtime is active. The host registers, long-polls for `execute` or `cancel`, acknowledges commands, and submits one immutable terminal result.

This local proof does not provide a hosted endpoint, OAuth, account or device pairing, uploads, persistent sessions, browser automation tools, or `mcp.hara-lang.org` production deployment.
