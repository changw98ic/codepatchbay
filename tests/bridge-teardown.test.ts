import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runAgentSmoke } from "../bridges/project-worker.js";
import { runAcp } from "../bridges/run-phase.js";
import { runCommand } from "../bridges/run-pipeline.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../core/runtime/process-tree.js";

function psResult(stdout: string, status = 0) {
  return { stdout, status } as ReturnType<ProcessTreeSystem["spawnSync"]>;
}

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

async function makeCwd() {
  return mkdtemp(path.join(tmpdir(), "cpb-bridge-teardown-"));
}

function killRealChild(pid: number | null) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

test("run-pipeline runCommand refuses to signal a successor after root incarnation mismatch", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  let childPid: number | null = null;
  let captureCount = 0;
  const signals: Array<[number, NodeJS.Signals | 0 | undefined]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, captureCount++ === 0 ? "original" : "successor"),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push([pid, signal]);
      if (signal === 0) return true;
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const pending = runCommand(process.execPath, ["-e", "setInterval(() => {}, 10000);"], cwd, {
    signal: ac.signal,
    graceMs: 0,
    forceVerifyMs: 20,
    system,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  ac.abort();
  const result = await pending;
  childPid = result.childPid;
  killRealChild(childPid);

  assert.equal(result.exitCode, 1);
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_IDENTITY_MISMATCH");
  assert.deepEqual(
    signals.filter(([, signal]) => signal === "SIGTERM" || signal === "SIGKILL"),
    [],
    "bridge teardown must not send TERM/KILL after root incarnation mismatch",
  );
});

test("run-pipeline runCommand awaits delayed force cleanup before resolving", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  const started = Date.now();
  const pending = runCommand(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);"],
    cwd,
    { signal: ac.signal, graceMs: 250, forceVerifyMs: 1000 },
  );
  setTimeout(() => ac.abort(), 50);
  const result = await pending;
  const elapsed = Date.now() - started;

  assert.equal(result.exitCode, 1);
  assert.ok(elapsed >= 250, `runCommand resolved before grace/force cleanup completed: ${elapsed}ms`);
});

test("run-pipeline runCommand propagates cleanup rejection as a non-zero command error", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  const alive = new Set<number>();
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => {
      alive.add(pid);
      return fakeIdentity(pid, "stable");
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (alive.has(pid)) return true;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const pending = runCommand(process.execPath, ["-e", "setInterval(() => {}, 10000);"], cwd, {
    signal: ac.signal,
    graceMs: 0,
    forceVerifyMs: 30,
    system,
  });
  setTimeout(() => ac.abort(), 50);
  const result = await pending;
  killRealChild(result.childPid);

  assert.equal(result.exitCode, 1);
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_CLEANUP_UNVERIFIED");
});

test("run-pipeline runCommand enforces the subprocess output byte bound", async () => {
  const cwd = await makeCwd();
  const previous = process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES;
  process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES = "128";
  try {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 10000);"],
      cwd,
      { graceMs: 10, forceVerifyMs: 1000 },
    );

    assert.equal(result.exitCode, 1);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 128);
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "COMMAND_OUTPUT_LIMIT_EXCEEDED");
  } finally {
    if (previous === undefined) delete process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES;
    else process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES = previous;
  }
});

test("run-phase runAcp removes SIGINT/SIGTERM listeners after signal-driven abort", async () => {
  const cwd = await makeCwd();
  const clientPath = path.join(cwd, "hang-acp-client.js");
  await writeFile(
    clientPath,
    "#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(() => {}, 10000);\n",
    "utf8",
  );
  await chmod(clientPath, 0o755);

  const previousClient = process.env.CPB_ACP_CLIENT;
  process.env.CPB_ACP_CLIENT = clientPath;
  const originalOn = process.on;
  const originalRemove = process.removeListener;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const removed: string[] = [];
  process.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") {
      listeners.set(String(event), listener);
      return process;
    }
    return originalOn.call(process, event, listener);
  }) as typeof process.on;
  process.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if ((event === "SIGINT" || event === "SIGTERM") && listeners.get(String(event)) === listener) {
      removed.push(String(event));
      listeners.delete(String(event));
      return process;
    }
    return originalRemove.call(process, event, listener);
  }) as typeof process.removeListener;

  try {
    const pending = runAcp("codex", "prompt", cwd, cwd);
    await new Promise((resolve) => setTimeout(resolve, 50));
    listeners.get("SIGTERM")?.();
    const result = await pending;

    assert.equal(result.exitCode, 143);
    assert.equal(result.aborted, true);
    assert.deepEqual(removed.sort(), ["SIGINT", "SIGTERM"]);
    assert.deepEqual([...listeners.keys()], []);
  } finally {
    process.on = originalOn;
    process.removeListener = originalRemove;
    if (previousClient === undefined) delete process.env.CPB_ACP_CLIENT;
    else process.env.CPB_ACP_CLIENT = previousClient;
  }
});

test("project-worker runAgentSmoke timeout waits for exact process tree cleanup", async (t) => {
  const cwd = await makeCwd();
  const fakeAgent = path.join(cwd, "fake-agent.mjs");
  const rootPidFile = path.join(cwd, "agent.pid");
  const childPidFile = path.join(cwd, "agent-child.pid");
  const observedIdentities: ProcessIdentity[] = [];

  t.after(async () => {
    for (const identity of observedIdentities) {
      if (isProcessIdentityAlive(identity)) {
        await killTree(identity.pid, 0, { expectedRootIdentity: identity, forceVerifyMs: 500 });
      }
    }
  });

  await writeFile(fakeAgent, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid));`,
    "const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));`,
    "process.on('SIGTERM', () => {});",
    "setInterval(() => {}, 1000);",
  ].join("\n"), "utf8");

  const smoke = runAgentSmoke({
    agent: "codex",
    cpbRoot: cwd,
    executorRoot: cwd,
    cwd,
    timeoutMs: 250,
    termGraceMs: 25,
    forceVerifyMs: 1_000,
    closeGraceMs: 1_000,
    spawnSpec: {
      command: process.execPath,
      args: [fakeAgent],
      env: { ...process.env },
    },
  });

  const observedPids: number[] = [];
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && observedPids.length === 0) {
    try {
      observedPids.push(
        Number((await readFile(rootPidFile, "utf8")).trim()),
        Number((await readFile(childPidFile, "utf8")).trim()),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assert.equal(observedPids.length, 2, "fake agent process tree should publish both pids");
  for (const pid of observedPids) {
    const identity = captureProcessIdentity(pid, { strict: true });
    assert.ok(identity, `process identity should be capturable for ${pid}`);
    observedIdentities.push(identity);
  }

  const result = await smoke;

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  for (const identity of observedIdentities) {
    assert.equal(isProcessIdentityAlive(identity), false, `pid ${identity.pid} should be cleaned up before smoke resolves`);
  }
});

test("project-worker runAgentSmoke never signals an identity-unavailable child handle", async (t) => {
  const cwd = await makeCwd();
  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => null,
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const startedAt = Date.now();

  await assert.rejects(
    runAgentSmoke({
      agent: "codex",
      cpbRoot: cwd,
      executorRoot: cwd,
      cwd,
      timeoutMs: 5,
      closeGraceMs: 500,
      processTreeSystem: system,
      spawnSpec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 80);"],
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(nestedErrorCodes(error).includes("CHILD_PROCESS_IDENTITY_UNAVAILABLE"));
      return true;
    },
  );

  assert.ok(Date.now() - startedAt >= 40, "identity failure must wait for the child close boundary");
  assert.equal(directKill.mock.callCount(), 0, "identity failure must not invoke ChildProcess.kill");
  assert.deepEqual(signals, [], "identity failure must not invoke process-tree signaling");
});

test("project-worker runAgentSmoke never signals after root PID reuse", async (t) => {
  const cwd = await makeCwd();
  const directKill = t.mock.method(ChildProcess.prototype, "kill", () => true);
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  let captureCount = 0;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, captureCount++ === 0 ? "original" : "successor"),
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    runAgentSmoke({
      agent: "codex",
      cpbRoot: cwd,
      executorRoot: cwd,
      cwd,
      timeoutMs: 5,
      termGraceMs: 0,
      closeGraceMs: 500,
      processTreeSystem: system,
      spawnSpec: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 80);"],
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(nestedErrorCodes(error).includes("PROCESS_IDENTITY_MISMATCH"));
      return true;
    },
  );

  assert.equal(directKill.mock.callCount(), 0, "PID reuse must not invoke ChildProcess.kill");
  assert.equal(
    signals.some((signal) => signal !== 0),
    false,
    "PID reuse must not send a terminating signal to the successor through killTree",
  );
});
