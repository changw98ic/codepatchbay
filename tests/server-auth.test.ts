import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { tempRoot } from "./helpers.js";

type WebSocketAttempt = {
  opened: boolean;
  ws: WebSocket;
  timeout?: boolean;
  error?: boolean;
  code?: number;
};

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastErr || new Error(`server did not respond: ${url}`);
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
}

async function tryOpenWebSocket(url: string): Promise<WebSocketAttempt> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result: Omit<WebSocketAttempt, "ws">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, ws });
    };
    const timer = setTimeout(() => finish({ opened: false, timeout: true }), 2_000);
    ws.onopen = () => finish({ opened: true });
    ws.onerror = () => finish({ opened: false, error: true });
    ws.onclose = (event) => finish({ opened: false, code: event.code });
  });
}

test("API key mode protects WebSocket connections consistently with HTTP routes", async (t) => {
  if (typeof WebSocket !== "function") {
    t.skip("global WebSocket is unavailable in this Node runtime");
    return;
  }

  const root = await tempRoot("cpb-server-auth");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const port = await freePort();
  const serverEntry = existsSync(path.join(process.cwd(), "server", "index.js"))
    ? path.join(process.cwd(), "server", "index.js")
    : path.join(process.cwd(), "dist", "server", "index.js");

  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_PORT: String(port),
      CPB_HOST: "127.0.0.1",
      CPB_API_KEYS: "review-secret",
      CPB_PROACTIVE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const base = `http://127.0.0.1:${port}`;
    const ready = await waitForHttp(`${base}/api/hub/status?api_key=review-secret`);
    assert.equal(ready.status, 200, logs);

    const noKey = await fetch(`${base}/api/hub/status`);
    assert.equal(noKey.status, 401);

    const wsNoKey = await tryOpenWebSocket(`ws://127.0.0.1:${port}/ws`);
    assert.equal(wsNoKey.opened, false);

    const wsWithKey = await tryOpenWebSocket(`ws://127.0.0.1:${port}/ws?api_key=review-secret`);
    assert.equal(wsWithKey.opened, true);
    wsWithKey.ws.close();
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});
