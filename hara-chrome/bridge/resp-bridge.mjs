import net from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { createProtocolSession, createRespParser, encodeResp, RespError } from "./protocol.mjs";

function waitForListening(server) {
  if (server.listening === true || server._server?.listening === true) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const listening = () => {
      cleanup();
      resolve();
    };
    const error = (cause) => {
      cleanup();
      reject(cause);
    };
    const cleanup = () => {
      server.removeListener("listening", listening);
      server.removeListener("error", error);
    };
    server.once("listening", listening);
    server.once("error", error);
  });
}

function closeNetServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function closeWebSocketServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

export async function startBridge({
  respPort = 7355,
  wsPort = 7356,
  token = process.env.HARA_BRIDGE_TOKEN ?? null,
} = {}) {
  let extension = null;
  const pending = new Map();
  const tcpSockets = new Set();
  let next = 1;
  let closePromise = null;

  const rejectPending = (message) => {
    for (const entry of pending.values()) entry.reject(new Error(message));
    pending.clear();
  };

  const wss = new WebSocketServer({ port: wsPort, host: "127.0.0.1" });
  wss.on("error", () => {});
  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "ws://127.0.0.1");
    if (token && url.searchParams.get("token") !== token) {
      socket.close(1008, "invalid token");
      return;
    }
    if (extension && extension !== socket) {
      extension.terminate();
      rejectPending("hara extension replaced");
    }
    extension = socket;
    socket.on("message", (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.ok
        ? entry.resolve(message.value)
        : entry.reject(new Error(message.error ?? "browser request failed"));
    });
    socket.on("close", () => {
      if (extension === socket) {
        extension = null;
        rejectPending("hara extension disconnected");
      }
    });
  });

  const requestExtension = (op, payload = {}) => new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== 1) {
      reject(new Error("hara extension not connected"));
      return;
    }
    const id = next++;
    pending.set(id, { resolve, reject });
    extension.send(JSON.stringify({ id, op, ...payload }));
  });

  let connectionCounter = 0;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    tcpSockets.add(socket);
    socket.once("close", () => tcpSockets.delete(socket));
    const session = createProtocolSession({
      request: requestExtension,
      connectionId: `chrome-${(++connectionCounter).toString(36)}`,
    });
    const writeFrames = ({ frames = [], close = false }) => {
      if (socket.destroyed) return;
      for (const frame of frames) socket.write(encodeResp(frame));
      if (close) socket.end();
    };
    socket.on("data", createRespParser(
      async (args) => writeFrames(await session.handle(args)),
      () => socket.end(encodeResp(new RespError("Protocol error"))),
    ));
    socket.on("error", () => {});
  });
  server.on("error", () => {});

  const close = () => {
    closePromise ??= (async () => {
      rejectPending("bridge closed");
      extension = null;
      for (const socket of tcpSockets) socket.destroy();
      tcpSockets.clear();
      for (const client of wss.clients) client.terminate();
      await Promise.all([
        closeNetServer(server),
        closeWebSocketServer(wss),
      ]);
    })();
    return closePromise;
  };

  try {
    const tcpListening = waitForListening(server);
    const wsListening = waitForListening(wss);
    server.listen(respPort, "127.0.0.1");
    await Promise.all([tcpListening, wsListening]);
  } catch (error) {
    await close();
    throw error;
  }

  const respAddress = server.address();
  const wsAddress = wss.address();
  return {
    respPort: typeof respAddress === "object" ? respAddress.port : respPort,
    wsPort: typeof wsAddress === "object" ? wsAddress.port : wsPort,
    close,
  };
}

async function main() {
  const respPort = Number(process.argv[2] ?? 7355);
  const wsPort = Number(process.argv[3] ?? 7356);
  const token = process.argv[4] ?? process.env.HARA_BRIDGE_TOKEN ?? null;
  const bridge = await startBridge({ respPort, wsPort, token });
  const tokenNote = token ? " token=required" : "";
  console.log(`hara-chrome bridge: resp=127.0.0.1:${bridge.respPort} ws=127.0.0.1:${bridge.wsPort}${tokenNote}`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await bridge.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
