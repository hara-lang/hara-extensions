import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import { verifyHaraResp } from "../scripts/resp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForMatch(child, pattern, timeout = 90000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}\n${output}`)), timeout);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(pattern);
      if (match) {
        clearTimeout(timer);
        resolve({ match, output: () => output });
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited before readiness: code=${code} signal=${signal}\n${output}`));
    });
  });
}

function waitForExit(child, timeout = 30000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error("runtime did not exit")), timeout)),
  ]);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 1000).unref?.();
  });
}

test("development launcher binds URL, exposes browser.dom, and shuts down", async () => {
  test.setTimeout(150000);
  const respPort = await freePort();
  let wsPort = await freePort();
  while (wsPort === respPort) wsPort = await freePort();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "hara-chrome-lifecycle-"));
  const targetServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>launcher target</title><button id=save>Save</button>");
  });
  await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  const targetUrl = `http://127.0.0.1:${targetServer.address().port}/`;
  const child = spawn(process.execPath, [path.join(root, "scripts/dev-runtime.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      RESP_PORT: String(respPort),
      WS_PORT: String(wsPort),
      PROFILE_DIR: profileDir,
      URL: targetUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let transcript = "";
  try {
    const targetReady = await waitForMatch(
      child,
      new RegExp(`HARA TARGET ${targetUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} TAB (\\d+)`),
    );
    const tabId = Number(targetReady.match[1]);
    const ready = await waitForMatch(child, new RegExp(`HARA RESP 127\\.0\\.0\\.1:${respPort}`));
    const result = await verifyHaraResp({ port: respPort, tabId });
    expect(result.value).toBe("42");
    expect(Number(result.domTarget)).toBe(tabId);
    child.kill("SIGTERM");
    const exited = await waitForExit(child);
    await new Promise((resolve) => setTimeout(resolve, 50));
    transcript = ready.output();
    expect(exited.code).toBe(0);
    expect(transcript).toContain("HARA STOPPED");
    expect(await canConnect(respPort)).toBe(false);
    expect(await canConnect(wsPort)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child).catch(() => {});
    }
    await new Promise((resolve) => targetServer.close(resolve));
    await rm(profileDir, { recursive: true, force: true });
  }
});
