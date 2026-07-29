import { HtaKeyword } from "../vendor/hta.js";

/** Render an HTA value as a display string for evaluation replies. */
export function renderHta(value) {
  if (value === null || value === undefined) return "nil";
  if (value instanceof HtaKeyword) return `:${value.name}`;
  if (value instanceof Map) {
    return `{${[...value].map(([key, item]) => `${renderHta(key)} ${renderHta(item)}`).join(", ")}}`;
  }
  if (value instanceof Set) return `#{${[...value].map(renderHta).join(" ")}}`;
  if (Array.isArray(value)) return `[${value.map(renderHta).join(" ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return value;
  return String(value);
}

function documentationSource(symbol) {
  if (!/^[A-Za-z0-9*+!?._/-]+$/.test(symbol)) throw new Error("INVALID_SYMBOL");
  return `["SYMBOL" "${symbol}" "DOC" (get (meta #'${symbol}) :doc) "ARGLISTS" (get (meta #'${symbol}) :arglists) "FILE" (get (meta #'${symbol}) :file) "LINE" (get (meta #'${symbol}) :line) "COLUMN" (get (meta #'${symbol}) :column)]`;
}

/**
 * Adapts page and extension-local brokers to the generic WebSocket RPC used by
 * the local RESP bridge.
 */
export function createBrowserRespHandler({ listTargets, resolveTarget }) {
  async function targetFor(message) {
    const target = await resolveTarget(message.target);
    if (!target) throw new Error("NO_TARGET_SELECTED");
    return target;
  }

  return async function handle(message) {
    if (message.source !== undefined && !message.op) message = { ...message, op: "eval" };
    switch (message.op) {
      case "target.list":
        return (await listTargets()).map((target) => ({
          id: target.environmentId ?? target.id,
          label: target.environmentLabel ?? target.label,
          kind: target.kind,
          activeKernel: target.kernel,
        })).filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index);
      case "info": {
        const target = await targetFor(message);
        const sessions = await target.list();
        return {
          instance: `chrome:${target.environmentId}`,
          project: target.page?.url ?? null,
          target: target.environmentId,
          session: message.session ?? target.kernel,
          sessions,
        };
      }
      case "session.list":
        return (await targetFor(message)).list();
      case "session.info": {
        const target = await targetFor(message);
        return target.info(message.session ?? target.kernel);
      }
      case "session.new": {
        const target = await targetFor(message);
        return target.create(message.session);
      }
      case "session.close": {
        const target = await targetFor(message);
        return target.close(message.session);
      }
      case "eval": {
        const target = await targetFor(message);
        const value = await target.eval(message.session ?? target.kernel, message.source ?? "", message.options ?? {});
        return renderHta(value);
      }
      case "doc": {
        const target = await targetFor(message);
        if (target.doc) return target.doc(message.session ?? target.kernel, message.symbol ?? "");
        return target.eval(message.session ?? target.kernel, documentationSource(message.symbol ?? ""));
      }
      case "complete": {
        const target = await targetFor(message);
        return target.complete ? target.complete(message.session ?? target.kernel, message.prefix ?? "") : [];
      }
      default:
        throw new Error(`UNKNOWN_BROWSER_OPERATION ${message.op}`);
    }
  };
}

export function connectResp(url, handler, { onStatus = () => {} } = {}) {
  const socket = new WebSocket(url);
  socket.onopen = () => onStatus("connected");
  socket.onerror = () => onStatus("error");
  socket.onclose = () => onStatus("closed");
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    try {
      const value = await handler(message);
      socket.send(JSON.stringify({ id: message.id, ok: true, value }));
    } catch (error) {
      socket.send(JSON.stringify({ id: message.id, ok: false, error: String(error?.message ?? error) }));
    }
  };
  return socket;
}
