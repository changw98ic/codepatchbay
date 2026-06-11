import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { ingestEvent } from "../server/services/event-source.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob } from "../server/services/job-store.js";
import { checkProactiveBudget } from "../server/services/task-brain.js";
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

async function waitForFile(filePath: string, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`file did not appear: ${filePath}`);
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

async function waitForExit(child: ChildProcess, timeoutMs = 2_000) {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
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

test("/api/health is available without an API key", async () => {
  const root = await tempRoot("cpb-server-health");
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
    const response = await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200, logs);
    const body = await response.json();
    assert.equal(body.ok, true);

    const queryResponse = await fetch(`http://127.0.0.1:${port}/api/health?ping=1`);
    assert.equal(queryResponse.status, 200, logs);
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("server refuses public unauthenticated binds when started directly", async () => {
  const root = await tempRoot("cpb-server-public-bind");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  const port = await freePort();
  const serverEntry = existsSync(path.join(process.cwd(), "server", "index.js"))
    ? path.join(process.cwd(), "server", "index.js")
    : path.join(process.cwd(), "dist", "server", "index.js");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CPB_ROOT: cpbRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_PORT: String(port),
    CPB_HOST: "0.0.0.0",
    CPB_PROACTIVE: "0",
  };
  delete env.CPB_API_KEYS;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const exit = await waitForExit(child, 10_000);
    assert.notEqual(exit, null, logs);
    assert.notEqual(exit?.code, 0, logs);
    assert.match(logs, /requires CPB_API_KEYS|public/i);
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("server refuses to start when legacy runtime data remains", async () => {
  const root = await tempRoot("cpb-server-legacy-runtime");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  await mkdir(path.join(cpbRoot, "cpb-task", "events", "flow"), { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    path.join(cpbRoot, "cpb-task", "events", "flow", "job-20260611-090000-legacy.jsonl"),
    "{}\n",
    "utf8",
  );
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
      CPB_PROACTIVE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const exit = await waitForExit(child, 10_000);
    assert.notEqual(exit, null, logs);
    assert.notEqual(exit?.code, 0, logs);
    assert.match(logs, /legacy runtime data remains/);
    assert.match(logs, /migrate-runtime-root --execute/);
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("proactive auto-scan writes immediate jobs to registered project runtime root", async () => {
  const root = await tempRoot("cpb-server-proactive-runtime");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const candidateRuntimeRoot = path.join(root, "candidate-runtime");
  const sourcePath = path.join(root, "source");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(candidateRuntimeRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  const project = await registerProject(hubRoot, {
    id: "flow",
    sourcePath,
    skipCodeGraphGate: true,
  });
  const previousRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
  process.env.CPB_PROJECT_RUNTIME_ROOT = candidateRuntimeRoot;
  try {
    await ingestEvent(cpbRoot, {
      source: "github-issue",
      externalId: "docs-1",
      projectId: "flow",
      payload: {
        title: "Update docs",
        body: "Refresh README wording",
        labels: ["docs"],
      },
    });
  } finally {
    if (previousRuntimeRoot === undefined) {
      delete process.env.CPB_PROJECT_RUNTIME_ROOT;
    } else {
      process.env.CPB_PROJECT_RUNTIME_ROOT = previousRuntimeRoot;
    }
  }

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
      CPB_PROJECT_RUNTIME_ROOT: candidateRuntimeRoot,
      CPB_PORT: String(port),
      CPB_HOST: "127.0.0.1",
      NODE_ENV: "test",
      CPB_PROACTIVE: "1",
      CPB_TEST_PROACTIVE_INTERVAL_MS: "50",
      CPB_PROACTIVE_DAILY_LIMIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const ready = await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    assert.equal(ready.status, 200, logs);
    await waitForFile(path.join(project.projectRuntimeRoot, "jobs-index.json"), { timeoutMs: 8_000 });
    assert.equal(
      existsSync(path.join(candidateRuntimeRoot, "events", "flow")),
      false,
      "proactive immediate job must not write to the fallback runtime root",
    );
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("proactive production interval ignores unsafe short values", async () => {
  const root = await tempRoot("cpb-server-proactive-interval-guard");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  const project = await registerProject(hubRoot, {
    id: "flow",
    sourcePath,
    skipCodeGraphGate: true,
  });
  await ingestEvent(cpbRoot, {
    source: "github-issue",
    externalId: "docs-1",
    projectId: "flow",
    payload: {
      title: "Update docs",
      body: "Refresh README wording",
      labels: ["docs"],
    },
  }, { hubRoot });

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
      CPB_PROACTIVE: "1",
      CPB_PROACTIVE_INTERVAL_MS: "10",
      CPB_PROACTIVE_DAILY_LIMIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

  try {
    const ready = await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    assert.equal(ready.status, 200, logs);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(
      existsSync(path.join(project.projectRuntimeRoot, "jobs-index.json")),
      false,
      "unsafe CPB_PROACTIVE_INTERVAL_MS must not trigger a sub-10s auto-scan",
    );
  } finally {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("proactive budget reads registered project runtime roots without fallback dataRoot", async () => {
  const root = await tempRoot("cpb-server-proactive-budget-runtime");
  const cpbRoot = path.join(root, "cpb");
  const hubRoot = path.join(root, "hub");
  const sourcePath = path.join(root, "source");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(sourcePath, { recursive: true });
  const project = await registerProject(hubRoot, {
    id: "flow",
    sourcePath,
    skipCodeGraphGate: true,
  });
  await createJob(cpbRoot, {
    project: "flow",
    task: "Update docs",
    dataRoot: project.projectRuntimeRoot,
    sourceContext: {
      type: "proactive",
      candidateId: "docs-1",
      source: "github-issue",
      category: "documentation",
    },
  });

  const previousProactive = process.env.CPB_PROACTIVE;
  const previousDailyLimit = process.env.CPB_PROACTIVE_DAILY_LIMIT;
  process.env.CPB_PROACTIVE = "1";
  process.env.CPB_PROACTIVE_DAILY_LIMIT = "1";
  try {
    const budget = await checkProactiveBudget(cpbRoot, { hubRoot });
    assert.deepEqual(budget, { allowed: false, reason: "daily limit reached (1)" });
    assert.equal(
      existsSync(path.join(cpbRoot, "cpb-task", "jobs-index.json")),
      false,
      "proactive budget must not create or read through the fallback runtime root",
    );
  } finally {
    if (previousProactive === undefined) delete process.env.CPB_PROACTIVE;
    else process.env.CPB_PROACTIVE = previousProactive;
    if (previousDailyLimit === undefined) delete process.env.CPB_PROACTIVE_DAILY_LIMIT;
    else process.env.CPB_PROACTIVE_DAILY_LIMIT = previousDailyLimit;
    await rm(root, { recursive: true, force: true });
  }
});
