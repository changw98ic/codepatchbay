import assert from "node:assert/strict";
import test from "node:test";

import { AcpPool, poolClientKey, terminateAcpPoolChild } from "../server/services/acp/acp-pool.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function psResult(status = 0) {
  return {
    status,
    stdout: "",
    stderr: status === 0 ? "" : "ps failed",
    pid: 1,
    output: [],
    signal: null,
  } as unknown as ReturnType<ProcessTreeSystem["spawnSync"]>;
}

function childFor(processIdentity: ProcessIdentity) {
  return {
    pid: processIdentity.pid,
    exitCode: null,
    signalCode: null,
    detached: true,
    processIdentity,
  } as unknown as Parameters<typeof terminateAcpPoolChild>[0];
}

test("ACP pool child teardown returns only after incarnation cleanup is verified", async () => {
  const root = identity(6101, "root");
  let alive = true;
  const signals: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => psResult()) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => alive ? root : null,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error("missing"), { code: "ESRCH" });
        return true;
      }
      signals.push({ pid, signal: signal || "SIGTERM" });
      alive = false;
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const result = await terminateAcpPoolChild(childFor(root), {
    system,
    graceMs: 0,
    forceVerifyMs: 0,
  });

  assert.equal(result.attempted, true);
  assert.equal(result.cleanupVerified, true);
  assert.deepEqual(result.rootIdentity, root);
  assert.ok(signals.some((entry) => entry.signal === "SIGTERM"));
});

test("ACP pool child teardown refuses to signal a recycled root PID", async () => {
  const original = identity(6202, "original");
  const successor = identity(6202, "successor");
  const signals: Array<number | NodeJS.Signals> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => psResult()) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => successor,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal !== 0) signals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    terminateAcpPoolChild(childFor(original), { system, graceMs: 0, forceVerifyMs: 0 }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_MISMATCH",
  );
  assert.deepEqual(signals, []);
});

test("ACP pool child teardown propagates liveness and strict enumeration failures", async () => {
  const root = identity(6303, "root");
  const deliveredSignals: Array<number | NodeJS.Signals> = [];
  const permissionSystem: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => psResult()) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => root,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      deliveredSignals.push(signal || "SIGTERM");
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  await assert.rejects(
    terminateAcpPoolChild(childFor(root), { system: permissionSystem, graceMs: 0, forceVerifyMs: 0 }),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
  assert.deepEqual(deliveredSignals, []);

  let alive = true;
  const enumerationSystem: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => psResult(1)) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => alive ? root : null,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (!alive) throw Object.assign(new Error("missing"), { code: "ESRCH" });
        return true;
      }
      alive = false;
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  await assert.rejects(
    terminateAcpPoolChild(childFor(root), { system: enumerationSystem, graceMs: 0, forceVerifyMs: 0 }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_ENUMERATION_UNAVAILABLE",
  );
});

test("ACP pool worktree release propagates terminal cleanup failure instead of reporting success", async () => {
  const pool = new AcpPool({ runner: async () => "ok" });
  const cwd = "/tmp/cpb-acp-release-cleanup-failure";
  const cleanupError = Object.assign(new Error("terminal cleanup failed"), { code: "EIO" });
  const client = {
    activeSessionCwd: cwd,
    cleanupTerminalsForCwd: async () => {
      throw cleanupError;
    },
    closeActiveSession: async () => true,
    close: async () => {},
  };
  pool.persistentClients.set("fake", {
    client,
    agent: "fake",
    projectId: "project",
    jobId: "job",
    dataRoot: null,
    conversationKey: null,
    sessionKey: "fake",
    providerKey: "fake",
    connectionLease: null,
    launchCwd: cwd,
    launchScopedMcp: false,
    startedAt: Date.now(),
    requestCount: 0,
    lastUsedAt: null,
  } as never);

  await assert.rejects(
    pool.releaseWorktree(cwd),
    (error: Error & { cleanupErrors?: Error[] }) => error === cleanupError
      || error.cleanupErrors?.includes(cleanupError) === true,
  );
});

test("ACP pool keeps a persistent entry when provider close cleanup fails", async () => {
  const pool = new AcpPool({ runner: async () => "ok" });
  const cwd = "/tmp/cpb-acp-provider-close-failure";
  const closeError = Object.assign(new Error("provider close failed"), { code: "EIO" });
  const client = {
    activeSessionCwd: cwd,
    cleanupTerminalsForCwd: async () => 1,
    closeActiveSession: async () => true,
    close: async () => {
      throw closeError;
    },
  };
  pool.persistentClients.set("fake", {
    client,
    agent: "fake",
    projectId: "project",
    jobId: "job",
    dataRoot: null,
    conversationKey: null,
    sessionKey: "fake",
    providerKey: "fake",
    connectionLease: null,
    launchCwd: cwd,
    launchScopedMcp: true,
    startedAt: Date.now(),
    requestCount: 0,
    lastUsedAt: null,
  } as never);

  await assert.rejects(
    pool.releaseWorktree(cwd, "worktree_release", { closeProvider: true }),
    (error: Error & { cleanupErrors?: Error[] }) => error === closeError
      || error.cleanupErrors?.includes(closeError) === true,
  );
  assert.equal(pool.persistentClients.has("fake"), true);
});

test("ACP persistent timeout awaits one close and preserves its cleanup failure", async () => {
  const pool = new AcpPool({
    persistentProcesses: true,
    env: { ...process.env, CPB_PROJECT_RUNTIME_ROOT: "" },
  });
  const agent = "fake-timeout";
  const cwd = "/tmp/cpb-acp-persistent-timeout";
  const key = poolClientKey(agent);
  const closeError = Object.assign(new Error("provider close failed during timeout"), { code: "EIO" });
  let closeCalls = 0;
  const client = {
    activeSessionCwd: cwd,
    outputSink: () => {},
    errorSink: () => {},
    isUsable: () => true,
    setAuditContext: () => {},
    promptOnce: async () => new Promise<string>(() => {}),
    close: async () => {
      closeCalls += 1;
      throw closeError;
    },
  };
  pool.persistentClients.set(key, {
    client,
    agent,
    projectId: "",
    jobId: "",
    dataRoot: null,
    conversationKey: null,
    sessionKey: agent,
    providerKey: agent,
    connectionLease: null,
    launchCwd: cwd,
    launchScopedMcp: false,
    startedAt: Date.now(),
    requestCount: 0,
    lastUsedAt: null,
  } as never);

  await assert.rejects(
    pool.execute(agent, "prompt", cwd, 5, { bypass: true }),
    (error: AggregateError & { cleanupErrors?: Error[]; primaryError?: Error; cleanupVerified?: boolean }) => {
      assert.match(error.primaryError?.message || "", /timed out/);
      assert.equal(error.cleanupErrors?.includes(closeError), true);
      assert.equal(error.cleanupVerified, false);
      return true;
    },
  );
  assert.equal(closeCalls, 1);
  assert.equal(pool.persistentClients.has(key), true);
});
