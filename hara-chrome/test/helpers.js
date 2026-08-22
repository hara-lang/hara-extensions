export class FakeEvent {
  constructor() { this.listeners = new Set(); }
  addListener(listener) { this.listeners.add(listener); }
  removeListener(listener) { this.listeners.delete(listener); }
  hasListener(listener) { return this.listeners.has(listener); }
  emit(...args) {
    for (const listener of [...this.listeners]) listener(...args);
  }
}

export function createPortPair(name = "test") {
  const a = makePort(name);
  const b = makePort(name);
  a.peer = b;
  b.peer = a;
  return { a, b };
}

function makePort(name) {
  return {
    name,
    sender: {},
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    disconnected: false,
    peer: null,
    postMessage(value) {
      if (this.disconnected) throw new Error("port disconnected");
      queueMicrotask(() => {
        if (!this.peer?.disconnected) this.peer?.onMessage.emit(structuredClone(value));
      });
    },
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      const peer = this.peer;
      queueMicrotask(() => this.onDisconnect.emit());
      if (peer && !peer.disconnected) {
        peer.disconnected = true;
        queueMicrotask(() => peer.onDisconnect.emit());
      }
    },
  };
}

export function createStorageArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(key) {
      if (key == null) return structuredClone(values);
      if (typeof key === "string") return { [key]: structuredClone(values[key]) };
      const keys = Array.isArray(key) ? key : Object.keys(key);
      return Object.fromEntries(keys.map((name) => [name, structuredClone(values[name])]));
    },
    async set(next) { Object.assign(values, structuredClone(next)); },
    async remove(key) { for (const name of Array.isArray(key) ? key : [key]) delete values[name]; },
    async clear() { for (const name of Object.keys(values)) delete values[name]; },
  };
}

export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
