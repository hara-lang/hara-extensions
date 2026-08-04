export class ProtocolError extends Error {}
export class RespError extends Error {}
export class SimpleString {
  constructor(value) { this.value = String(value); }
}

const MAX_ARGS = 1024;
const MAX_BULK = 64 * 1024 * 1024;

export function readCommand(buffer) {
  if (buffer.length === 0) return null;
  if (buffer[0] !== 0x2a /* * */) throw new ProtocolError("array command required");
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd === -1) return null;
  const count = Number(buffer.subarray(1, lineEnd).toString());
  if (!Number.isInteger(count) || count < 0 || count > MAX_ARGS) throw new ProtocolError("invalid array length");
  const args = [];
  let cursor = lineEnd + 2;
  for (let index = 0; index < count; index += 1) {
    if (cursor >= buffer.length) return null;
    if (buffer[cursor] !== 0x24 /* $ */) throw new ProtocolError("bulk argument required");
    const sizeEnd = buffer.indexOf("\r\n", cursor);
    if (sizeEnd === -1) return null;
    const size = Number(buffer.subarray(cursor + 1, sizeEnd).toString());
    if (!Number.isInteger(size) || size < 0 || size > MAX_BULK) throw new ProtocolError("invalid bulk length");
    const dataStart = sizeEnd + 2;
    const dataEnd = dataStart + size;
    if (buffer.length < dataEnd + 2) return null;
    if (buffer[dataEnd] !== 13 || buffer[dataEnd + 1] !== 10) throw new ProtocolError("missing bulk CRLF");
    args.push(buffer.subarray(dataStart, dataEnd).toString());
    cursor = dataEnd + 2;
  }
  return { args, consumed: cursor };
}

export function createRespParser(onCommand, onProtocolError) {
  let buffer = Buffer.alloc(0);
  let tail = Promise.resolve();
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    tail = tail.then(async () => {
      for (;;) {
        let command;
        try {
          command = readCommand(buffer);
        } catch (error) {
          if (error instanceof ProtocolError) {
            buffer = Buffer.alloc(0);
            onProtocolError(error);
            return;
          }
          throw error;
        }
        if (!command) return;
        buffer = buffer.subarray(command.consumed);
        await onCommand(command.args);
      }
    }).catch((error) => onProtocolError(error));
  };
}

export function encodeResp(value) {
  if (value instanceof SimpleString) return `+${cleanLine(value.value)}\r\n`;
  if (value instanceof RespError) return `-ERR ${cleanLine(value.message)}\r\n`;
  if (value === null || value === undefined) return "$-1\r\n";
  if (typeof value === "boolean") return `:${value ? 1 : 0}\r\n`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `:${value}\r\n`;
  if (Array.isArray(value)) {
    return `*${value.length}\r\n${value.map(encodeResp).join("")}`;
  }
  if (typeof value === "object") return encodeResp(JSON.stringify(value));
  const text = String(value);
  return `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
}

function cleanLine(value) {
  return String(value).replace(/[\r\n]+/g, " ");
}

function codeFor(error) {
  const message = cleanLine(error?.message ?? error);
  const token = message.split(/\s+/, 1)[0];
  return /^[A-Z][A-Z0-9_]*$/.test(token) ? token : "BROWSER_ERROR";
}

function metadata(info, state) {
  const sessions = Array.isArray(info?.sessions) ? info.sessions.length : Number(info?.sessions ?? 0);
  return [
    "SERVER", "HARA",
    "VERSION", "0.1.0",
    "PROTO", state.protocol,
    "RUNTIME", "BROWSER",
    "CONNECTION", state.connectionId,
    "INSTANCE", info?.instance ?? "hara-chrome-dev",
    "PROJECT", info?.project ?? null,
    "SESSION", state.attached,
    "SESSIONS", sessions,
    "TARGET", state.target ?? info?.target ?? null,
  ];
}

export function createProtocolSession({ request, connectionId = `browser-${Date.now().toString(36)}` }) {
  const state = {
    protocol: 2,
    attached: "ROOT",
    target: null,
    client: null,
    connectionId,
  };

  async function extension(op, payload = {}) {
    return request(op, { ...payload, target: state.target, connectionId: state.connectionId });
  }

  async function sessionList() {
    const sessions = await extension("session.list");
    return Array.isArray(sessions) ? sessions : [];
  }

  async function v4Result(id, action) {
    try {
      const value = await action();
      return { frames: [["RESULT", id, value], ["DONE", id, "OK"]] };
    } catch (error) {
      return {
        frames: [
          ["ERROR", id, codeFor(error), cleanLine(error?.message ?? error)],
          ["DONE", id, "ERROR"],
        ],
      };
    }
  }

  async function handleSession(args, offset = 1) {
    const sub = String(args[offset] ?? "").toUpperCase();
    switch (sub) {
      case "LIST":
        return sessionList();
      case "ATTACH": {
        const name = String(args[offset + 1] ?? "");
        if (!(await sessionList()).includes(name)) throw new Error(`NO_SESSION ${name}`);
        state.attached = name;
        return name;
      }
      case "DETACH":
        state.attached = "ROOT";
        return "DETACHED";
      case "NEW":
      case "CREATE": {
        const name = String(args[offset + 1] ?? "");
        return extension("session.new", { session: name });
      }
      case "CLOSE":
      case "KILL":
      case "DELETE": {
        const name = String(args[offset + 1] ?? "");
        const result = await extension("session.close", { session: name });
        if (state.attached === name) state.attached = "ROOT";
        return result;
      }
      case "INFO":
        return extension("session.info", { session: String(args[offset + 1] ?? state.attached) });
      default:
        throw new Error(`UNKNOWN_SESSION_COMMAND ${sub}`);
    }
  }

  async function handleTarget(args, offset = 1) {
    const sub = String(args[offset] ?? "").toUpperCase();
    switch (sub) {
      case "LIST":
        return extension("target.list");
      case "ATTACH": {
        const target = String(args[offset + 1] ?? "");
        const targets = await extension("target.list");
        const ids = (targets ?? []).map((entry) => typeof entry === "string" ? entry : entry.id);
        if (!ids.includes(target)) throw new Error(`NO_TARGET ${target}`);
        state.target = target;
        const info = (targets ?? []).find((entry) => entry?.id === target);
        if (info?.activeKernel) state.attached = info.activeKernel;
        return target;
      }
      case "DETACH":
        state.target = null;
        return "DETACHED";
      default:
        throw new Error(`UNKNOWN_TARGET_COMMAND ${sub}`);
    }
  }

  async function handleV4(args) {
    const command = String(args[0] ?? "").toUpperCase();
    const id = String(args[1] ?? "");
    if (!id) return { frames: [new RespError("MISSING_REQUEST_ID")] };
    switch (command) {
      case "PING":
        return v4Result(id, async () => "PONG");
      case "COMMANDS":
        return v4Result(id, async () => ["HELLO", "PING", "INFO", "STATUS", "TARGET", "SESSION", "EVAL", "LOAD", "DOC", "COMPLETE", "QUIT"]);
      case "INFO":
      case "STATUS":
        return v4Result(id, async () => metadata(await extension("info", { session: state.attached }), state));
      case "TARGET":
        return v4Result(id, async () => handleTarget(args, 2));
      case "SESSION":
        return v4Result(id, async () => handleSession(args, 2));
      case "EVAL":
      case "LOAD": {
        const source = String(args[2] ?? "");
        const options = {};
        if ((args.length - 3) % 2 !== 0) return v4Result(id, async () => { throw new Error("EVAL_OPTIONS_EXPECT_KEY_VALUE_PAIRS"); });
        for (let index = 3; index < args.length; index += 2) {
          options[String(args[index]).toLowerCase()] = args[index + 1];
        }
        return v4Result(id, async () => extension("eval", { session: state.attached, source, options }));
      }
      case "DOC":
        return v4Result(id, async () => extension("doc", { session: state.attached, symbol: String(args[2] ?? "") }));
      case "COMPLETE":
        return v4Result(id, async () => extension("complete", { session: state.attached, prefix: String(args[2] ?? "") }));
      case "INTERRUPT":
        return v4Result(id, async () => { throw new Error("INTERRUPT_UNSUPPORTED"); });
      case "QUIT":
        return { frames: [["RESULT", id, "BYE"], ["DONE", id, "OK"]], close: true };
      default:
        return v4Result(id, async () => { throw new Error(`UNKNOWN_COMMAND ${command}`); });
    }
  }

  async function handleLegacy(args) {
    const command = String(args[0] ?? "").toUpperCase();
    try {
      switch (command) {
        case "PING": return { frames: [new SimpleString("PONG")] };
        case "COMMANDS": return { frames: [["HELLO", "PING", "INFO", "TARGET", "SESSION", "EVAL", "DOC", "COMPLETE", "QUIT"]] };
        case "INFO":
        case "STATUS": return { frames: [metadata(await extension("info", { session: state.attached }), state)] };
        case "TARGET": return { frames: [await handleTarget(args)] };
        case "SESSION": return { frames: [await handleSession(args)] };
        case "EVAL":
        case "LOAD": {
          const explicitSession = args.length >= 3 ? String(args[1]) : state.attached;
          const source = String(args.length >= 3 ? args[2] : args[1] ?? "");
          return { frames: [await extension("eval", { session: explicitSession, source, options: {} })] };
        }
        case "DOC": return { frames: [await extension("doc", { session: state.attached, symbol: String(args[1] ?? "") })] };
        case "COMPLETE": return { frames: [await extension("complete", { session: state.attached, prefix: String(args[1] ?? "") })] };
        case "QUIT": return { frames: [new SimpleString("OK")], close: true };
        default: return { frames: [new RespError(`unknown command: ${command}`)] };
      }
    } catch (error) {
      return { frames: [new RespError(cleanLine(error?.message ?? error))] };
    }
  }

  async function handle(args) {
    const command = String(args[0] ?? "").toUpperCase();
    if (command === "HELLO") {
      const requested = Number(args[1] ?? 3);
      state.protocol = Number.isInteger(requested) ? Math.max(2, Math.min(4, requested)) : 3;
      state.client = args.find((value, index) => String(value).toUpperCase() === "CLIENT" ? args[index + 1] : false) ?? null;
      let info = {};
      try { info = await extension("info", { session: state.attached }); } catch { /* panel may connect later */ }
      return { frames: [metadata(info, state)] };
    }
    return state.protocol === 4 ? handleV4(args) : handleLegacy(args);
  }

  return { state, handle };
}
