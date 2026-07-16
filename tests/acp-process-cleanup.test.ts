import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient, terminateProcessesMatchingPath } from "../server/services/acp/acp-client.js";
import { tempRoot } from "./helpers.js";

async function waitForPsCommand(needle: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
    if (typeof result.stdout === "string" && result.stdout.includes(needle)) return;
    await delay(25);
  }
  throw new Error(`process command not visible in ps output: ${needle}`);
}

test("terminateProcessesMatchingPath kills orphaned helpers that still reference the worktree", async () => {
  const worktree = await tempRoot("cpb-acp-process-cleanup");
  const child = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 30000)",
    worktree,
  ], {
    stdio: "ignore",
    detached: true,
  });

  assert.ok(child.pid, "fixture process should start");
  await waitForPsCommand(worktree);

  const signaled = terminateProcessesMatchingPath(worktree, "SIGTERM");
  assert.ok(signaled >= 1, "cleanup should signal the helper process by worktree path");

  const exited = Promise.race([
    once(child, "exit").then(() => true),
    delay(2000).then(() => false),
  ]);
  assert.equal(await exited, true, "helper process should exit after cleanup signal");
});

test("AcpClient residual cleanup kills helpers under project runtime root", async () => {
  const root = await tempRoot("cpb-acp-runtime-process-cleanup");
  const worktree = path.join(root, "worktree");
  const runtimeRoot = path.join(root, "project-runtime");
  await mkdir(worktree, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  const child = spawn(process.execPath, [
    "-e",
    "setTimeout(() => {}, 30000)",
    runtimeRoot,
  ], {
    stdio: "ignore",
    detached: true,
  });

  assert.ok(child.pid, "fixture process should start");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: worktree,
    prompt: "",
    env: {
      ...process.env,
      CPB_PROJECT_PATH_OVERRIDE: process.cwd(),
      CPB_PROJECT_RUNTIME_ROOT: runtimeRoot,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });
  assert.ok(
    !client.residualProcessPaths().includes(path.resolve(process.cwd())),
    "residual cleanup must not scan inherited broad project overrides",
  );
  await waitForPsCommand(runtimeRoot);

  const signaled = client.terminateResidualProcesses("SIGTERM");
  assert.ok(signaled >= 1, "cleanup should signal helpers by project runtime path");

  const exited = Promise.race([
    once(child, "exit").then(() => true),
    delay(2000).then(() => false),
  ]);
  assert.equal(await exited, true, "runtime helper process should exit after cleanup signal");
});

test("AcpClient residual cleanup ignores broad repository cwd paths", () => {
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: process.cwd(),
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  assert.ok(
    !client.residualProcessPaths().includes(path.resolve(process.cwd())),
    "repo root cwd must not be used for residual process scanning",
  );
});

test("isolated ACP clients never claim shared worktree or runtime processes", () => {
  const sharedWorktree = path.join(process.cwd(), ".tmp", "shared-worktree");
  const sharedRuntime = path.join(process.cwd(), ".tmp", "shared-runtime");
  const agentHome = path.join(sharedRuntime, "agent-homes", "codex", "job-1");
  const client = new AcpClient({
    agent: "codex",
    cwd: sharedWorktree,
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "1",
      CPB_PROJECT_RUNTIME_ROOT: sharedRuntime,
      HOME: agentHome,
      XDG_CONFIG_HOME: path.join(agentHome, ".config"),
      XDG_DATA_HOME: path.join(agentHome, ".local", "share"),
      XDG_CACHE_HOME: path.join(agentHome, ".cache"),
    },
  });

  // childEnv is installed at launch in production; setting it directly keeps
  // this unit test independent from spawning a provider process.
  client.childEnv = {
    ...process.env,
    HOME: agentHome,
    XDG_CONFIG_HOME: path.join(agentHome, ".config"),
    XDG_DATA_HOME: path.join(agentHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(agentHome, ".cache"),
  };
  const paths = client.residualProcessPaths();
  assert.ok(paths.includes(path.resolve(agentHome)));
  assert.ok(!paths.includes(path.resolve(sharedWorktree)));
  assert.ok(!paths.includes(path.resolve(sharedRuntime)));
});
