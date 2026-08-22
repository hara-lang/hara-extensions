import net from "node:net";

export class RespReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "RespReplyError";
  }
}

function lineAt(buffer, offset) {
  const end = buffer.indexOf("\r\n", offset);
  if (end === -1) return null;
  return { text: buffer.subarray(offset, end).toString(), next: end + 2 };
}

/** Decode one RESP2 frame. Returns null until a complete frame is available. */
export function readRespFrame(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const prefix = buffer[offset];
  const line = lineAt(buffer, offset + 1);
  if (!line) return null;

  if (prefix === 0x2b /* + */) return { value: line.text, consumed: line.next };
  if (prefix === 0x2d /* - */) {
    return { value: new RespReplyError(line.text.replace(/^ERR\s+/, "")), consumed: line.next };
  }
  if (prefix === 0x3a /* : */) {
    const value = Number(line.text);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid RESP integer: ${line.text}`);
    return { value, consumed: line.next };
  }
  if (prefix === 0x24 /* $ */) {
    const size = Number(line.text);
    if (!Number.isInteger(size) || size < -1) throw new Error(`invalid RESP bulk length: ${line.text}`);
    if (size === -1) return { value: null, consumed: line.next };
    const end = line.next + size;
    if (buffer.length < end + 2) return null;
    if (buffer[end] !== 13 || buffer[end + 1] !== 10) throw new Error("missing RESP bulk CRLF");
    return { value: buffer.subarray(line.next, end).toString(), consumed: end + 2 };
  }
  if (prefix === 0x2a /* * */) {
    const count = Number(line.text);
    if (!Number.isInteger(count) || count < -1) throw new Error(`invalid RESP array length: ${line.text}`);
    if (count === -1) return { value: null, consumed: line.next };
    const values = [];
    let cursor = line.next;
    for (let index = 0; index < count; index += 1) {
      const child = readRespFrame(buffer, cursor);
      if (!child) return null;
      values.push(child.value);
      cursor = child.consumed;
    }
    return { value: values, consumed: cursor };
  }
  throw new Error(`unsupported RESP prefix: ${String.fromCharCode(prefix)}`);
}

export function encodeCommand(args) {
  const values = args.map((value) => String(value));
  return `*${values.length}\r\n${values.map((value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join("")}`;
}

function withTimeout(promise, timeout, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export class RespClient {
  static async connect({ host = "127.0.0.1", port, timeout = 10000 } = {}) {
    if (!Number.isInteger(port) || port < 1) throw new Error(`invalid RESP port: ${port}`);
    const socket = net.createConnection({ host, port });
    await withTimeout(new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }), timeout, `RESP connect ${host}:${port}`);
    return new RespClient(socket, { timeout });
  }

  constructor(socket, { timeout = 10000 } = {}) {
    this.socket = socket;
    this.timeout = timeout;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.closed = false;

    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        for (;;) {
          const frame = readRespFrame(this.buffer);
          if (!frame) break;
          this.buffer = this.buffer.subarray(frame.consumed);
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(frame.value);
          else this.frames.push(frame.value);
        }
      } catch (error) {
        this.fail(error);
      }
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("RESP connection closed")));
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  nextFrame(timeout = this.timeout) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.closed) return Promise.reject(new Error("RESP connection is closed"));
    return withTimeout(new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    }), timeout, "RESP reply");
  }

  write(args) {
    if (this.closed) throw new Error("RESP connection is closed");
    this.socket.write(encodeCommand(args));
  }

  async command(...args) {
    this.write(args);
    const frame = await this.nextFrame();
    if (frame instanceof RespReplyError) throw frame;
    return frame;
  }

  async requestV4(command, args = [], id = `node-${Date.now().toString(36)}`) {
    this.write([command, id, ...args]);
    const result = await this.nextFrame();
    const done = await this.nextFrame();
    if (!Array.isArray(result) || String(result[1]) !== id) {
      throw new Error(`unexpected protocol-4 result frame: ${JSON.stringify(result)}`);
    }
    if (!Array.isArray(done) || done[0] !== "DONE" || String(done[1]) !== id) {
      throw new Error(`unexpected protocol-4 completion frame: ${JSON.stringify(done)}`);
    }
    if (result[0] === "ERROR" || done[2] !== "OK") {
      throw new RespReplyError(String(result[3] ?? result[2] ?? "protocol-4 request failed"));
    }
    if (result[0] !== "RESULT") {
      throw new Error(`unexpected protocol-4 result kind: ${JSON.stringify(result)}`);
    }
    return result[2];
  }

  close() {
    if (this.socket.destroyed) return;
    this.closed = true;
    this.socket.destroy();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("RESP client closed"));
  }
}

export async function verifyHaraResp({
  host = "127.0.0.1",
  port,
  timeout = 30000,
  tabId = null,
} = {}) {
  const client = await RespClient.connect({ host, port, timeout });
  try {
    const hello = await client.command("HELLO", "4", "CLIENT", "EMACS");
    const protoIndex = Array.isArray(hello) ? hello.indexOf("PROTO") : -1;
    if (protoIndex === -1 || Number(hello[protoIndex + 1]) !== 4) {
      throw new Error(`protocol 4 negotiation failed: ${JSON.stringify(hello)}`);
    }
    const attached = await client.requestV4("SESSION", ["ATTACH", "ROOT"], "ready-session");
    if (attached !== "ROOT") throw new Error(`ROOT attachment failed: ${JSON.stringify(attached)}`);
    const value = await client.requestV4("EVAL", ["(+ 40 2)"], "ready-eval");
    if (String(value) !== "42") throw new Error(`readiness evaluation returned ${JSON.stringify(value)}`);

    let domTarget = null;
    if (tabId !== null && tabId !== undefined) {
      domTarget = await client.requestV4(
        "EVAL",
        ['(do (require [browser.dom :as dom]) (:tab-id (dom/target)))'],
        "ready-dom-target",
      );
      if (Number(domTarget) !== Number(tabId)) {
        throw new Error(`browser.dom target returned ${JSON.stringify(domTarget)}; expected ${tabId}`);
      }
    }
    return { hello, attached, value, domTarget };
  } finally {
    client.close();
  }
}
