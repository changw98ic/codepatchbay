import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AcpClient, terminateProcessesMatchingPath } from "../server/services/acp/acp-client.js";
import { captureSpawnProcessIdentity } from "../core/runtime/process-tree.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

function fakeIdentity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function nestedErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    codes.push(error.code);
  }
  if (error instanceof AggregateError) {
    for (const nested of error.errors) codes.push(...nestedErrorCodes(nested));
  }
  return codes;
}

async function waitForFixtureReady(child: ReturnType<typeof spawn>) {
  assert.ok(child.stdout, "fixture process should expose stdout readiness");
  const readinessController = new AbortController();
  const readinessTimeout = setTimeout(() => readinessController.abort(), 10_000);
  try {
    const ready = await Promise.race([
      once(child.stdout, "data", { signal: readinessController.signal }).then(([chunk]) => String(chunk)),
      once(child, "exit", { signal: readinessController.signal }).then(([code, signal]) => {
        throw new Error(`fixture exited before readiness: code=${String(code)} signal=${String(signal)}`);
      }),
      once(child, "error", { signal: readinessController.signal }).then(([error]) => { throw error; }),
    ]);
    assert.equal(ready, "ready\n");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("fixture did not report readiness within 10000ms", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(readinessTimeout);
    readinessController.abort();
  }
}

test("terminateProcessesMatchingPath kills orphaned helpers that still reference the worktree", async () => {
  const worktree = await tempRoot("cpb-acp-process-cleanup");
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('ready\\n'); setTimeout(() => {}, 30000)",
    worktree,
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  assert.ok(child.pid, "fixture process should start");
  const identity = captureSpawnProcessIdentity(child);
  assert.ok(identity, "fixture process identity should be captured at spawn");
  await waitForFixtureReady(child);

  const exited = Promise.race([
    once(child, "exit").then(() => true),
    delay(2000).then(() => false),
  ]);
  const signaled = await terminateProcessesMatchingPath(worktree, "SIGTERM", new Set([process.pid]), {
    ownedIdentities: [identity],
  });
  assert.ok(signaled >= 1, "cleanup should signal the helper process by worktree path");

  assert.equal(await exited, true, "helper process should exit after cleanup signal");
});

test("terminateProcessesMatchingPath refuses to signal a recycled matching PID", async () => {
  const target = "/tmp/cpb-acp-recycled-process";
  let captures = 0;
  const deliveredSignals: Array<number | string> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({
      status: 0,
      stdout: `4242 node helper.js ${target}\n`,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => {
      captures += 1;
      return fakeIdentity(4242, `late-capture-${captures}`);
    },
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== 0) deliveredSignals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    async () => terminateProcessesMatchingPath(target, "SIGKILL", new Set(), {
      system,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
  assert.equal(captures, 0, "residual cleanup must not capture a current PID identity");
  assert.deepEqual(deliveredSignals, [], "cleanup must not signal the successor incarnation");
});

test("terminateProcessesMatchingPath propagates EPERM instead of declaring cleanup", async () => {
  const target = "/tmp/cpb-acp-eperm-process";
  const identity = fakeIdentity(5252, "original");
  const deliveredSignals: Array<number | string> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({
      status: 0,
      stdout: `5252 node helper.js ${target}\n`,
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => identity,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      deliveredSignals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    async () => terminateProcessesMatchingPath(target, "SIGKILL", new Set(), {
      system,
      graceMs: 0,
      forceVerifyMs: 0,
      ownedIdentities: [identity],
    }),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
  assert.deepEqual(deliveredSignals, [], "EPERM must not be hidden behind a successful cleanup count");
});

test("AcpClient residual cleanup kills helpers under project runtime root", async () => {
  const root = await tempRoot("cpb-acp-runtime-process-cleanup");
  const worktree = path.join(root, "worktree");
  const runtimeRoot = path.join(root, "project-runtime");
  await mkdir(worktree, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  const child = spawn(process.execPath, [
    "-e",
    "process.stdout.write('ready\\n'); setTimeout(() => {}, 30000)",
    runtimeRoot,
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });

  assert.ok(child.pid, "fixture process should start");
  const identity = captureSpawnProcessIdentity(child);
  assert.ok(identity, "fixture process identity should be captured at spawn");
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
  await waitForFixtureReady(child);

  const exited = Promise.race([
    once(child, "exit").then(() => true),
    delay(2000).then(() => false),
  ]);
  const signaled = await terminateProcessesMatchingPath(runtimeRoot, "SIGTERM", new Set([process.pid]), {
    ownedIdentities: [identity],
  });
  assert.ok(signaled >= 1, "cleanup should signal helpers by project runtime path");

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

test("AcpClient terminal cleanup refuses a recycled terminal PID", async () => {
  const root = await tempRoot("cpb-acp-terminal-recycled");
  const original = fakeIdentity(1, "original");
  const successor = fakeIdentity(1, "successor");
  let actualPid = 0;
  let captureCount = 0;
  const deliveredSignals: Array<number | string> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid: number) => {
      actualPid = pid;
      captureCount += 1;
      return {
        ...(captureCount === 1 ? original : successor),
        pid,
        incarnation: `${pid}:${captureCount === 1 ? original.birthId : successor.birthId}`,
      };
    },
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== 0) deliveredSignals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: root,
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
    processSystem: system,
  });

  try {
    const { terminalId } = await client.createTerminal({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: root,
    });
    await assert.rejects(
      async () => client.killTerminal({ terminalId }),
      (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_MISMATCH",
    );
    assert.deepEqual(deliveredSignals, [], "terminal cleanup must not signal a successor incarnation");
    assert.ok(client.terminals.has(terminalId), "failed cleanup must not report terminal release");
  } finally {
    if (actualPid) {
      try {
        process.kill(actualPid, "SIGKILL");
      } catch {
        // Fixture process may have exited.
      }
    }
  }
});

test("AcpClient terminal cleanup propagates EPERM and keeps the terminal tracked", async () => {
  const root = await tempRoot("cpb-acp-terminal-eperm");
  let actualPid = 0;
  const deliveredSignals: Array<number | string> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid: number) => {
      actualPid = pid;
      return fakeIdentity(pid, "original");
    },
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      deliveredSignals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: root,
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
    processSystem: system,
  });

  try {
    const { terminalId } = await client.createTerminal({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
      cwd: root,
    });
    await assert.rejects(
      async () => client.releaseTerminal({ terminalId }),
      (error: NodeJS.ErrnoException) => error.code === "EPERM",
    );
    assert.deepEqual(deliveredSignals, [], "EPERM liveness failure must not be hidden by later signals");
    assert.ok(client.terminals.has(terminalId), "failed release must keep terminal tracked for retry/audit");
  } finally {
    if (actualPid) {
      try {
        process.kill(actualPid, "SIGKILL");
      } catch {
        // Fixture process may have exited.
      }
    }
  }
});

test("AcpClient terminal launch waits for close instead of bare-killing when identity capture fails", async () => {
  const root = await tempRoot("cpb-acp-terminal-capture-failure");
  const marker = `${root}-capture-failure-marker`;
  const deliveredSignals: Array<[number, NodeJS.Signals | 0]> = [];
  const livenessProbes: number[] = [];
  let spawnedPid = 0;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      if ((signal ?? 0) === 0) livenessProbes.push(pid);
      else deliveredSignals.push([pid, signal ?? 0]);
      return process.kill(pid, signal as NodeJS.Signals | 0 | undefined);
    }) as ProcessTreeSystem["kill"],
    captureIdentity: (pid: number) => {
      spawnedPid = pid;
      throw Object.assign(new Error("identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
    },
  };
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: root,
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
    processSystem: system,
  });

  await assert.rejects(
    async () => client.createTerminal({
      command: process.execPath,
      args: ["-e", "process.exit(0)", marker],
      cwd: root,
    }),
    (error: unknown) => {
      const codes = nestedErrorCodes(error);
      return codes.includes("PROCESS_IDENTITY_UNAVAILABLE")
        && !codes.includes("PROCESS_CLEANUP_UNVERIFIED");
    },
  );
  assert.equal(client.terminals.size, 0, "failed terminal launch must not register an unowned process");
  assert.equal(
    deliveredSignals.length,
    0,
    "identity-capture failure must not fall back to child.kill or any bare-pid terminating signal",
  );
  assert.ok(spawnedPid > 0 || livenessProbes.length > 0, "fixture should expose the spawned child pid to cleanup probes");
  const verifiedPid = spawnedPid || livenessProbes[0];
  const ps = spawnSync("ps", ["-p", String(verifiedPid), "-o", "stat="], { encoding: "utf8" });
  const stat = typeof ps.stdout === "string" ? ps.stdout.trim() : "";
  assert.ok(
    ps.status !== 0 || !stat || stat.startsWith("Z"),
    "identity-capture failure must wait for the original child pid to disappear or become reaped/zombie",
  );
  assert.ok(
    livenessProbes.length > 0 || ps.status !== 0 || !stat || stat.startsWith("Z"),
    "cleanup proof must verify the unowned child is no longer visible in the OS",
  );
});

test("AcpClient terminal launch preserves identity and close failures for unowned children", async () => {
  const root = await tempRoot("cpb-acp-terminal-capture-hang");
  const deliveredSignals: Array<[number, NodeJS.Signals | 0]> = [];
  const livenessProbes: number[] = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      if ((signal ?? 0) === 0) livenessProbes.push(pid);
      else deliveredSignals.push([pid, signal ?? 0]);
      return process.kill(pid, signal as NodeJS.Signals | 0 | undefined);
    }) as ProcessTreeSystem["kill"],
    captureIdentity: () => {
      throw Object.assign(new Error("identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
    },
  };
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: root,
    prompt: "",
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
    processSystem: system,
  });

  await assert.rejects(
    async () => client.createTerminal({
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      cwd: root,
    }),
    (error: unknown) => {
      const codes = nestedErrorCodes(error);
      return codes.includes("PROCESS_IDENTITY_UNAVAILABLE")
        && codes.includes("PROCESS_CLEANUP_UNVERIFIED");
    },
  );
  assert.equal(client.terminals.size, 0, "failed terminal launch must not register an unowned process");
  assert.equal(
    deliveredSignals.length,
    0,
    "unowned child close failure must not trigger a bare-pid kill fallback",
  );
});
