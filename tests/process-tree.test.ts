/**
 * Tests for core/runtime/process-tree.ts — detached process-group command runner
 * with SIGTERM→SIGKILL teardown on timeout/abort and registry-injection hooks.
 *
 * Mirrors the SIGINT/SIGKILL teardown style of tests/integration/reconcile.test.ts:610.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureProcessIdentity,
  captureSpawnProcessIdentity,
  descendantPids,
  isProcessIdentityAlive,
  killTree,
  runCommandTree,
  sameProcessIdentity,
} from "../core/runtime/process-tree.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";

async function makeCwd() {
  return mkdtemp(join(tmpdir(), "process-tree-"));
}

const HANG = `setInterval(()=>{}, 10000)`;

function psResult(stdout: string, status = 0) {
  return { stdout, status } as ReturnType<ProcessTreeSystem["spawnSync"]>;
}

function fakeIdentity(pid: number, birthId = `birth-${pid}`, processGroupId?: number): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    birthIdPrecision: "exact",
    ...(processGroupId ? { processGroupId } : {}),
  };
}

function coarseIdentity(pid: number, birthId = `coarse-${pid}`): ProcessIdentity {
  return {
    ...fakeIdentity(pid, birthId),
    birthIdPrecision: "coarse",
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

test("runCommandTree: normal exit returns exitCode + stdout", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree("node", ["-e", "process.stdout.write('hi'); process.exit(0)"], { cwd });
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.aborted, false);
  assert.equal(r.cleanupVerified, true);
  assert.match(r.stdout, /hi/);
});

test("runCommandTree: non-zero exit propagates", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree("node", ["-e", "process.exit(3)"], { cwd });
  assert.equal(r.exitCode, 3);
  assert.equal(r.timedOut, false);
});

test("runCommandTree: timeout kills the process and flags timedOut", async () => {
  const cwd = await makeCwd();
  let spawnedPid = 0;
  try {
    const r = await runCommandTree("node", ["-e", HANG], {
      cwd,
      timeoutMs: 300,
      graceMs: 200,
      onSpawn: (pid) => { spawnedPid = pid; },
    });
    assert.equal(r.timedOut, true);
    assert.equal(r.aborted, false);
    // killed by signal → exitCode resolved as 1 (null code)
    assert.equal(r.exitCode, 1);
    if (!r.cleanupVerified) {
      assert.ok(
        ["PROCESS_ENUMERATION_UNAVAILABLE", "PROCESS_IDENTITY_UNAVAILABLE"].includes(
          (r.error as NodeJS.ErrnoException | undefined)?.code || "",
        ),
      );
    }
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
});

test("runCommandTree: abort signal kills the process and flags aborted", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  let spawnedPid = 0;
  try {
    const pending = runCommandTree("node", ["-e", HANG], {
      cwd,
      signal: ac.signal,
      graceMs: 200,
      onSpawn: (pid) => { spawnedPid = pid; },
    });
    setTimeout(() => ac.abort(), 200);
    const r = await pending;
    assert.equal(r.aborted, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 1);
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
});

test("runCommandTree: pre-aborted signal does not spawn a process", async () => {
  const cwd = await makeCwd();
  const ac = new AbortController();
  ac.abort();
  let spawnedPid: number | null = null;
  const result = await runCommandTree("cpb-command-that-must-not-spawn", [], {
    cwd,
    signal: ac.signal,
    onSpawn: (pid) => { spawnedPid = pid; },
  });

  assert.equal(result.aborted, true);
  assert.equal(result.cleanupVerified, true);
  assert.equal(spawnedPid, null);
});

test("runCommandTree: output limit tears down the command and reports a bounded failure", async () => {
  const cwd = await makeCwd();
  let spawnedPid = 0;
  const result = await runCommandTree("node", ["-e", "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 10000);"], {
    cwd,
    timeoutMs: 10_000,
    graceMs: 50,
    maxBufferBytes: 128,
    onSpawn: (pid) => { spawnedPid = pid; },
  });

  try {
    assert.equal(result.exitCode, 1);
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 128);
    assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "COMMAND_OUTPUT_LIMIT_EXCEEDED");
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
});

test("runCommandTree: spawn identity failure preserves an already-closing child result", async () => {
  const cwd = await makeCwd();
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync,
    captureIdentity: () => {
      throw Object.assign(new Error("identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const result = await runCommandTree(process.execPath, ["-e", "process.stdout.write('ok')"], {
    cwd,
    timeoutMs: 1_000,
    graceMs: 10,
    system,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ok");
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.error, undefined);
  assert.equal(
    signalled.some(([, signal]) => signal !== 0),
    false,
    "spawn identity failure must not send any terminating signal to an already-closing child",
  );
});

test("runCommandTree: live spawn identity failure never authorizes teardown by current pid", async () => {
  const cwd = await makeCwd();
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync,
    captureIdentity: () => {
      throw Object.assign(new Error("identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const result = await runCommandTree(process.execPath, ["-e", "process.stdin.resume()"], {
    cwd,
    timeoutMs: 2_000,
    graceMs: 10,
    system,
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanupVerified, false);
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_IDENTITY_UNAVAILABLE");
  assert.equal(
    signalled.some(([, signal]) => signal !== 0),
    false,
    "spawn identity failure must not send any terminating signal to the current pid owner",
  );
});

test("runCommandTree: timeout refuses a pid reused after exact spawn identity capture", async () => {
  const cwd = await makeCwd();
  let capturedOnce = false;
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync,
    captureIdentity: (pid) => {
      const identity = fakeIdentity(pid, capturedOnce ? "successor" : "spawned", pid);
      capturedOnce = true;
      return identity;
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  const result = await runCommandTree(process.execPath, ["-e", "setTimeout(() => process.exit(0), 200)"], {
    cwd,
    timeoutMs: 50,
    graceMs: 10,
    forceVerifyMs: 20,
    system,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.cleanupVerified, false);
  assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_IDENTITY_MISMATCH");
  assert.equal(
    signalled.some(([, signal]) => signal !== 0),
    false,
    "a successor pid owner after spawn must not receive timeout teardown signals",
  );
});

test("runCommandTree: onSpawn receives the child pid", async () => {
  const cwd = await makeCwd();
  let spawnedPid: number | null = null;
  const r = await runCommandTree("node", ["-e", "process.exit(0)"], {
    cwd,
    onSpawn: (pid) => { spawnedPid = pid; },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(typeof spawnedPid, "number");
  assert.ok((spawnedPid as number) > 0);
});

test("runCommandTree: onExit receives pid + code", async () => {
  const cwd = await makeCwd();
  let exitPid: number | null = null;
  let exitCode: number | null = null;
  const r = await runCommandTree("node", ["-e", "process.exit(0)"], {
    cwd,
    onExit: (pid, code) => { exitPid = pid; exitCode = code; },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(exitCode, 0);
  assert.equal(typeof exitPid, "number");
});

test("runCommandTree: timeout tears down the whole process group (grandchild reaped)", async () => {
  // Parent spawns a grandchild that stays in the parent's process group (default —
  // NOT detached, so it inherits the parent pgid). On timeout, killTree(-parentPid)
  // must reap the grandchild too. (A detached grandchild would setsid into its own
  // group and escape — that is NOT the hard-gate scenario we are guarding.)
  const cwd = await makeCwd();
  const pidFile = join(cwd, "grandchild.pid");
  // The grandchild writes its OWN pid to a file as its first statement on start,
  // so the pid we assert on never depends on the parent surviving long enough to
  // flush a pipe or forward the value. killTree fires SIGTERM at timeoutMs; the
  // grandchild is in the parent's process group (default — not detached), so it
  // must be reaped too. timeoutMs is sized for spawn + Node startup under
  // concurrent-test CPU contention, not to exercise the timeout value itself.
  const gcScript = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},10000);`;
  const script = `const cp=require('child_process');const g=cp.spawn(process.execPath,['-e',${JSON.stringify(gcScript)}],{stdio:'ignore'});g.unref();setInterval(()=>{},10000);`;
  let spawnedPid = 0;
  let grandchildPid = NaN;
  try {
    const r = await runCommandTree("node", ["-e", script], {
      cwd,
      timeoutMs: 3000,
      graceMs: 500,
      onSpawn: (pid) => { spawnedPid = pid; },
    });
    assert.equal(r.timedOut, true);
    // The grandchild writes its pid before entering its hang interval; poll briefly
    // in case Node startup lagged under load.
    for (let i = 0; i < 20; i++) {
      try {
        grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        if (Number.isFinite(grandchildPid) && grandchildPid > 0) break;
      } catch { /* not written yet */ }
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0, `grandchild pid file never appeared: ${pidFile}`);
    // Allow grace + signal propagation, then exact-identity platforms must have
    // reaped the group. Coarse-identity platforms must report unverified cleanup.
    await new Promise((res) => setTimeout(res, 1500));
    let alive = true;
    try { process.kill(grandchildPid, 0); } catch { alive = false; }
    if (r.cleanupVerified) {
      assert.equal(alive, false, "grandchild in the process group must be reaped by killTree");
    } else {
      assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_IDENTITY_UNAVAILABLE");
    }
  } finally {
    for (const pid of [grandchildPid, spawnedPid]) {
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  }
});

test("runCommandTree: timeout also tears down a detached grandchild process group", async () => {
  const cwd = await makeCwd();
  const pidFile = join(cwd, "detached-grandchild.pid");
  const groupMemberPidFile = join(cwd, "detached-group-member.pid");
  const groupMemberScript = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(groupMemberPidFile)},String(process.pid));setInterval(()=>{},10000);`;
  const gcScript = `const fs=require('fs');const cp=require('child_process');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const member=cp.spawn(process.execPath,['-e',${JSON.stringify(groupMemberScript)}],{stdio:'ignore'});member.unref();setInterval(()=>{},10000);`;
  const script = `const cp=require('child_process');const g=cp.spawn(process.execPath,['-e',${JSON.stringify(gcScript)}],{stdio:'ignore',detached:true});g.unref();setInterval(()=>{},10000);`;
  let spawnedPid = 0;
  let grandchildPid = NaN;
  let groupMemberPid = NaN;
  try {
    const result = await runCommandTree("node", ["-e", script], {
      cwd,
      timeoutMs: 5000,
      graceMs: 300,
      onSpawn: (pid) => { spawnedPid = pid; },
    });
    assert.equal(result.timedOut, true);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        groupMemberPid = Number.parseInt(readFileSync(groupMemberPidFile, "utf8"), 10);
        if (
          Number.isFinite(grandchildPid)
          && grandchildPid > 0
          && Number.isFinite(groupMemberPid)
          && groupMemberPid > 0
        ) break;
      } catch { /* child has not reached its first statement yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(Number.isFinite(grandchildPid) && grandchildPid > 0);
    assert.ok(Number.isFinite(groupMemberPid) && groupMemberPid > 0);
    const survivors = new Set([grandchildPid, groupMemberPid]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (const pid of [...survivors]) {
        try { process.kill(pid, 0); } catch { survivors.delete(pid); }
      }
      if (survivors.size === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (process.platform === "win32") {
      assert.equal(result.cleanupVerified, false);
      assert.ok(
        ["PROCESS_ENUMERATION_UNAVAILABLE", "PROCESS_IDENTITY_UNAVAILABLE"].includes(
          (result.error as NodeJS.ErrnoException | undefined)?.code || "",
        ),
      );
    } else {
      assert.deepEqual([...survivors], [], "detached leader and its same-group member must both be reaped");
      assert.equal(result.cleanupVerified, true);
    }
    assert.equal(
      survivors.size > 0 && result.cleanupVerified,
      false,
      "detached descendant group survival must be reported as unverified cleanup",
    );
  } finally {
    for (const pid of [groupMemberPid, grandchildPid, spawnedPid]) {
      if (Number.isFinite(pid) && pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  }
});

test("killTree: rejects a bare pid before probing, capturing, or signalling", async () => {
  const probes: Array<[number, NodeJS.Signals | 0 | undefined]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => {
      throw new Error("bare pid must not be recaptured");
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      probes.push([pid, signal]);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(999999, 50, { system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
  assert.deepEqual(probes, []);
});

test("killTree: exact-identity loss during natural exit waits for gone without signalling", async () => {
  const identity = fakeIdentity(123, "naturally-exiting", 123);
  const signals: Array<NodeJS.Signals | 0> = [];
  let livenessProbes = 0;
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync,
    captureIdentity: () => coarseIdentity(123, "zombie-lstart"),
    kill: ((_pid: number, signal?: NodeJS.Signals | 0) => {
      signals.push(signal ?? 0);
      if ((signal ?? 0) === 0) {
        livenessProbes += 1;
        if (livenessProbes > 1) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(identity.pid, 0, {
    expectedRootIdentity: identity,
    system,
    forceVerifyMs: 100,
  });

  assert.equal(signals.some((signal) => signal !== 0), false);
});

test("descendantPids: strict mode fails closed when enumeration is unsupported", () => {
  const system: ProcessTreeSystem = {
    platform: "win32",
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    kill: process.kill,
  };
  assert.throws(
    () => descendantPids(123, { strict: true, system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_ENUMERATION_UNAVAILABLE",
  );
});

test("descendantPids: strict mode fails closed when ps fails", () => {
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("", 1)) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid),
    kill: process.kill,
  };
  assert.throws(
    () => descendantPids(123, { strict: true, system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_ENUMERATION_UNAVAILABLE",
  );
});

test("isProcessIdentityAlive: permission errors do not classify a live owner as stale", () => {
  const identity = fakeIdentity(123, "permission-denied-owner");
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => identity,
    kill: (() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }) as ProcessTreeSystem["kill"],
  };

  assert.throws(
    () => isProcessIdentityAlive(identity, system),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
});

test("captureProcessIdentity: non-linux ps lstart fallback is non-authoritative in strict mode", () => {
  const coarseLstart = "Tue Jul 21 12:34:56 2026\n";
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync: ((command, args) => {
      if (command === "/usr/bin/python3") return psResult("", 2);
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-p", "123", "-o", "lstart="]);
      return psResult(coarseLstart);
    }) as ProcessTreeSystem["spawnSync"],
    kill: process.kill,
  };

  const compatible = captureProcessIdentity(123, { system });
  assert.equal(compatible?.birthId, "ps-lstart:Tue Jul 21 12:34:56 2026");
  assert.equal(compatible?.birthIdPrecision, "coarse");
  assert.equal(sameProcessIdentity(compatible, compatible), false);
  assert.throws(
    () => captureProcessIdentity(123, { strict: true, system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
});

test("captureProcessIdentity: macOS proc_pidinfo start time is exact in strict mode", () => {
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync: ((command, args) => {
      assert.equal(command, "/usr/bin/python3");
      assert.equal(args?.at(-1), "123");
      return psResult("1784598534:660167\n");
    }) as ProcessTreeSystem["spawnSync"],
    kill: process.kill,
  };

  const identity = captureProcessIdentity(123, { strict: true, system });
  assert.equal(identity?.birthId, "darwin-proc-pidinfo-starttime:1784598534.660167");
  assert.equal(identity?.birthIdPrecision, "exact");
  assert.equal(sameProcessIdentity(identity, identity), true);
});

test("captureProcessIdentity: strict test seams cannot launder missing precision", () => {
  const identity = fakeIdentity(123, "missing-precision");
  delete identity.birthIdPrecision;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => identity,
    kill: process.kill,
  };

  assert.equal(sameProcessIdentity(identity, identity), false);
  assert.throws(
    () => captureProcessIdentity(123, { strict: true, system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
});

test("captureProcessIdentity rejects noncanonical exact test-seam identities", () => {
  const expectedRoot = fakeIdentity(123, "expected-root");
  const variants: ProcessIdentity[] = [
    { ...fakeIdentity(123, "wrong-pid"), pid: 124, incarnation: "124:wrong-pid" },
    { ...fakeIdentity(123, "unsafe-pid"), pid: Number.MAX_SAFE_INTEGER + 1, incarnation: `${Number.MAX_SAFE_INTEGER + 1}:unsafe-pid` },
    { ...fakeIdentity(123, "bad-incarnation"), incarnation: "123:different" },
    { ...fakeIdentity(123, "bad-time"), capturedAt: "2026-01-01T00:00:00Z" },
    { ...fakeIdentity(123, "unsafe-group"), processGroupId: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const identity of variants) {
    const system: ProcessTreeSystem = {
      platform: process.platform,
      spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
      captureIdentity: () => identity,
      kill: process.kill,
    };
    assert.equal(sameProcessIdentity(expectedRoot, identity), false);
    assert.throws(
      () => captureProcessIdentity(123, { strict: true, system }),
      (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
});

test("killTree rejects unsafe or mismatched root identities before any signal", async () => {
  const signals: Array<[number, string | number | undefined]> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => null,
    kill(pid, signal) {
      signals.push([pid, signal]);
      return true;
    },
  };
  await assert.rejects(
    killTree(Number.MAX_SAFE_INTEGER + 1, 0, { system }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
  await assert.rejects(
    killTree(123, 0, { system, expectedRootIdentity: fakeIdentity(124, "successor") }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
  assert.deepEqual(signals, []);
});

test("captureSpawnProcessIdentity retries transient coarse observations without accepting them", () => {
  let captures = 0;
  const pid = 4242;
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync,
    kill: process.kill,
    captureIdentity: () => {
      captures += 1;
      return captures === 1 ? coarseIdentity(pid) : fakeIdentity(pid, "exact-after-retry", pid);
    },
  };
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
  } as Parameters<typeof captureSpawnProcessIdentity>[0];

  const identity = captureSpawnProcessIdentity(child, system);

  assert.equal(captures, 2);
  assert.equal(identity?.birthIdPrecision, "exact");
  assert.equal(identity?.birthId, "exact-after-retry");
});

test("isProcessIdentityAlive: refuses same-pid same-lstart coarse successor", () => {
  const oldRoot = coarseIdentity(123, "ps-lstart:Tue Jul 21 12:34:56 2026");
  const sameCoarseSuccessor = coarseIdentity(123, "ps-lstart:Tue Jul 21 12:34:56 2026");
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync: (() => psResult("Tue Jul 21 12:34:56 2026\n")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => sameCoarseSuccessor,
    kill: (() => true) as ProcessTreeSystem["kill"],
  };

  assert.throws(
    () => isProcessIdentityAlive(oldRoot, system),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
});

test("killTree: refuses same-pid same-lstart coarse successor before signaling", async () => {
  const oldRoot = coarseIdentity(123, "ps-lstart:Tue Jul 21 12:34:56 2026");
  const sameCoarseSuccessor = coarseIdentity(123, "ps-lstart:Tue Jul 21 12:34:56 2026");
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: "darwin",
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => sameCoarseSuccessor,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(123, 0, {
      expectedRootIdentity: oldRoot,
      requireDescendantScan: true,
      system,
      forceVerifyMs: 20,
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );
  assert.equal(
    signalled.some(([, signal]) => signal !== 0),
    false,
    "coarse same-pid same-lstart identity must not authorize a terminating signal",
  );
});

test("killTree: a force-phase liveness error rejects the teardown instead of escaping its promise", async () => {
  const identity = fakeIdentity(123, "force-probe-owner");
  let livenessProbes = 0;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: () => identity,
    kill: ((_: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        livenessProbes += 1;
        if (livenessProbes >= 6) {
          throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
        }
      }
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(123, 0, {
      expectedRootIdentity: identity,
      requireDescendantScan: true,
      system,
      forceVerifyMs: 20,
    }),
    (error: unknown) => nestedErrorCodes(error).includes("EPERM"),
  );
});

test("killTree: recaptures descendants after SIGTERM and verifies them", async () => {
  const alive = new Set([123, 101, 102]);
  const rootIdentity = fakeIdentity(123);
  const scans = [
    "101 123\n",
    "101 123\n",
    "101 123\n102 101\n",
    "101 123\n102 101\n",
  ];
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult(scans.shift() || scans[0] || "")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => alive.has(pid) ? fakeIdentity(pid) : null,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === 0) {
        if (alive.has(pid)) return true;
        const err = Object.assign(new Error("not found"), { code: "ESRCH" });
        throw err;
      }
      if (signal === "SIGKILL" && pid > 0) alive.delete(pid);
      if (signal === "SIGKILL" && pid < 0) alive.delete(Math.abs(pid));
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, { expectedRootIdentity: rootIdentity, requireDescendantScan: true, system, forceVerifyMs: 20 });

  assert.ok(signalled.some(([pid, signal]) => pid === 102 && signal === "SIGKILL"));
});

test("killTree: immediately recaptures children that appear after SIGTERM", async () => {
  const alive = new Set([123, 102]);
  const rootIdentity = fakeIdentity(123);
  const scans = ["", "102 123\n", "102 123\n", ""];
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult(scans.shift() ?? "")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => alive.has(pid) ? fakeIdentity(pid) : null,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === 0) {
        if (alive.has(pid)) return true;
        const err = Object.assign(new Error("not found"), { code: "ESRCH" });
        throw err;
      }
      if (signal === "SIGKILL" && pid > 0) alive.delete(pid);
      if (signal === "SIGKILL" && pid < 0) alive.delete(Math.abs(pid));
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, { expectedRootIdentity: rootIdentity, requireDescendantScan: true, system, forceVerifyMs: 20 });

  const childTermIndex = signalled.findIndex(([pid, signal]) => pid === 102 && signal === "SIGTERM");
  const childKillIndex = signalled.findIndex(([pid, signal]) => pid === 102 && signal === "SIGKILL");
  assert.ok(childTermIndex >= 0, "new child must receive SIGTERM during immediate recapture");
  assert.ok(childKillIndex > childTermIndex, "new child must remain in the known set for force-kill verification");
});

test("killTree: rejects when force-kill liveness cannot be proven clean", async () => {
  const rootIdentity = fakeIdentity(123);
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => pid === 123 ? fakeIdentity(pid) : null,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0 && pid === 123) return true;
      if (signal === 0) {
        const err = Object.assign(new Error("not found"), { code: "ESRCH" });
        throw err;
      }
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(123, 0, { expectedRootIdentity: rootIdentity, requireDescendantScan: true, system, forceVerifyMs: 20 }),
    (error: unknown) => nestedErrorCodes(error).includes("PROCESS_CLEANUP_UNVERIFIED"),
  );
});

test("killTree: skips force signal when root pid is reused during grace", async () => {
  const births = new Map([[123, "old-root"]]);
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const rootIdentity = fakeIdentity(123, "old-root", 123);
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, births.get(pid) || `birth-${pid}`, pid === 123 ? 123 : undefined),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === "SIGTERM" && pid === -123) births.set(123, "successor-root");
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, { expectedRootIdentity: rootIdentity, requireDescendantScan: true, system, forceVerifyMs: 20 });

  assert.ok(signalled.some(([pid, signal]) => pid === -123 && signal === "SIGTERM"));
  assert.equal(
    signalled.some(([pid, signal]) => (pid === 123 || pid === -123) && signal === "SIGKILL"),
    false,
    "successor root incarnation must not receive force-kill",
  );
});

test("killTree: does not enumerate or signal a successor root's descendants", async () => {
  const births = new Map([[123, "old-root"], [201, "successor-child"]]);
  const rootIdentity = fakeIdentity(123, "old-root", 123);
  let successorPublished = false;
  let successorScans = 0;
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => {
      if (!successorPublished) return psResult("");
      successorScans += 1;
      return psResult("201 123\n");
    }) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, births.get(pid) || `birth-${pid}`, pid === 123 ? 123 : undefined),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (pid === -123 && signal === "SIGTERM") {
        births.set(123, "successor-root");
        successorPublished = true;
      }
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, {
    expectedRootIdentity: rootIdentity,
    requireDescendantScan: true,
    system,
    forceVerifyMs: 20,
  });

  assert.equal(
    signalled.some(([pid, signal]) => Math.abs(pid) === 201 && (signal === "SIGTERM" || signal === "SIGKILL")),
    false,
    "a child discovered only after root incarnation changed belongs to the successor and must not be signalled",
  );
  assert.equal(successorScans, 0, "successor process trees must never be enumerated through the old root pid");
});

test("killTree: revalidates descendant membership after identity capture", async () => {
  const rootIdentity = fakeIdentity(123, "root");
  const scans = ["101 123\n", "", ""];
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  let rootAlive = true;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult(scans.shift() ?? "")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => pid === 123
      ? (rootAlive ? rootIdentity : null)
      : fakeIdentity(pid, "reused-unrelated-process"),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === 0 && Math.abs(pid) === 123 && !rootAlive) {
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL" && Math.abs(pid) === 123) rootAlive = false;
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, {
    expectedRootIdentity: rootIdentity,
    requireDescendantScan: true,
    system,
    forceVerifyMs: 20,
  });

  assert.equal(
    signalled.some(([pid, signal]) => pid === 101 && (signal === "SIGTERM" || signal === "SIGKILL")),
    false,
    "a pid that stopped being a descendant before its captured incarnation was verified must not be signalled",
  );
});

test("killTree: skips force signal for a descendant pid reused after its graceful signal", async () => {
  const births = new Map([[123, "root"], [101, "old-child"]]);
  const rootIdentity = fakeIdentity(123, "root", 123);
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("101 123\n")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid, births.get(pid) || `birth-${pid}`, pid === 123 ? 123 : undefined),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (pid === -123 && signal === "SIGTERM") births.set(101, "successor-child");
      if (pid === -123 && signal === "SIGKILL") births.set(123, "successor-root");
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, { expectedRootIdentity: rootIdentity, requireDescendantScan: true, system, forceVerifyMs: 20 });

  assert.ok(signalled.some(([pid, signal]) => pid === 101 && signal === "SIGTERM"));
  assert.equal(signalled.some(([pid, signal]) => Math.abs(pid) === 101 && signal === "SIGKILL"), false);
});

test("killTree: signals an exact detached descendant process group", async () => {
  const alive = new Set([123, 101]);
  const rootIdentity = fakeIdentity(123, "root-group", 123);
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult(alive.has(101) ? "101 123\n" : "")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => alive.has(pid)
      ? fakeIdentity(pid, pid === 123 ? "root-group" : "child-group", pid)
      : null,
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      const target = Math.abs(pid);
      if (signal === 0) {
        if (alive.has(target)) return true;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      if (pid < 0 && signal === "SIGTERM") alive.delete(target);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await killTree(123, 0, {
    expectedRootIdentity: rootIdentity,
    requireDescendantScan: true,
    system,
    forceVerifyMs: 20,
  });

  assert.ok(signalled.some(([pid, signal]) => pid === -101 && signal === "SIGTERM"));
  assert.equal(
    signalled.some(([pid, signal]) => pid === 101 && signal !== 0),
    false,
    "a successful exact group signal must not be followed by a redundant bare-pid signal",
  );
});

test("killTree: one unavailable descendant identity does not hide exact siblings", async () => {
  const alive = new Set([123, 101, 102]);
  const rootIdentity = fakeIdentity(123, "root");
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("101 123\n102 123\n")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => {
      if (!alive.has(pid)) return null;
      if (pid === 101) return coarseIdentity(101, "unavailable-child");
      return pid === 123 ? rootIdentity : fakeIdentity(pid, "exact-child");
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === 0) {
        if (alive.has(Math.abs(pid))) return true;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL") alive.delete(Math.abs(pid));
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(123, 0, {
      expectedRootIdentity: rootIdentity,
      requireDescendantScan: true,
      system,
      forceVerifyMs: 20,
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_UNAVAILABLE",
  );

  assert.ok(signalled.some(([pid, signal]) => pid === 102 && signal === "SIGTERM"));
  assert.ok(signalled.some(([pid, signal]) => pid === 102 && signal === "SIGKILL"));
  assert.equal(signalled.some(([pid, signal]) => Math.abs(pid) === 101 && signal !== 0), false);
});

test("killTree: root identity loss does not skip already captured descendants", async () => {
  const alive = new Set([123, 101]);
  const rootIdentity = fakeIdentity(123, "root");
  let rootIdentityAvailable = true;
  let scans = 0;
  const signalled: Array<[number, NodeJS.Signals | 0]> = [];
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => {
      scans += 1;
      const result = psResult("101 123\n");
      if (scans === 4) rootIdentityAvailable = false;
      return result;
    }) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => {
      if (!alive.has(pid)) return null;
      if (pid === 123) return rootIdentityAvailable ? rootIdentity : null;
      return fakeIdentity(101, "child");
    },
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      signalled.push([pid, signal ?? 0]);
      if (signal === 0) {
        if (alive.has(Math.abs(pid))) return true;
        throw Object.assign(new Error("not found"), { code: "ESRCH" });
      }
      if (signal === "SIGKILL" && pid === 101) alive.delete(101);
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  await assert.rejects(
    killTree(123, 0, {
      expectedRootIdentity: rootIdentity,
      requireDescendantScan: true,
      system,
      forceVerifyMs: 20,
    }),
    (error: unknown) => {
      const codes = nestedErrorCodes(error);
      return codes.includes("PROCESS_IDENTITY_UNAVAILABLE")
        && codes.includes("PROCESS_CLEANUP_UNVERIFIED");
    },
  );

  assert.ok(signalled.some(([pid, signal]) => pid === 101 && signal === "SIGTERM"));
  assert.ok(signalled.some(([pid, signal]) => pid === 101 && signal === "SIGKILL"));
  assert.equal(
    signalled.some(([pid, signal]) => Math.abs(pid) === 123 && signal !== 0),
    false,
    "an unavailable root identity must never authorize a root or group signal",
  );
});

test("runCommandTree: timeout reports unverified cleanup when strict enumeration fails", async () => {
  const cwd = await makeCwd();
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("", 1)) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid),
    kill: process.kill,
  };

  const r = await runCommandTree("node", ["-e", HANG], {
    cwd,
    timeoutMs: 300,
    graceMs: 100,
    system,
  });

  assert.equal(r.timedOut, true);
  assert.equal(r.cleanupVerified, false);
  assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, "PROCESS_ENUMERATION_UNAVAILABLE");
});

test("runCommandTree: timeout settles after verified teardown even when close never arrives", async () => {
  const cwd = await makeCwd();
  let spawnedPid = 0;
  let cleanupVerifiedByFakeSystem = false;
  const system: ProcessTreeSystem = {
    platform: process.platform,
    spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => fakeIdentity(pid),
    kill: ((pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (cleanupVerifiedByFakeSystem) {
          throw Object.assign(new Error(`pid ${pid} not found`), { code: "ESRCH" });
        }
        return true;
      }
      if (signal === "SIGKILL") cleanupVerifiedByFakeSystem = true;
      return true;
    }) as ProcessTreeSystem["kill"],
  };

  try {
    const started = Date.now();
    const r = await runCommandTree(process.execPath, ["-e", HANG], {
      cwd,
      timeoutMs: 50,
      graceMs: 20,
      system,
      forceVerifyMs: 20,
      onSpawn: (pid) => { spawnedPid = pid; },
    });

    assert.equal(r.timedOut, true);
    assert.equal(r.exitCode, 1);
    assert.equal(r.cleanupVerified, true);
    assert.ok(Date.now() - started < 1_000, "teardown completion must settle the command without waiting for close");
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already dead */ }
    }
  }
});

test("runCommandTree: forwards stdin and closes it", async () => {
  const cwd = await makeCwd();
  const r = await runCommandTree(process.execPath, [
    "-e",
    "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => value += chunk); process.stdin.on('end', () => process.stdout.write(value));",
  ], {
    cwd,
    input: "provider-preflight-input",
    timeoutMs: 2_000,
  });

  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "provider-preflight-input");
  assert.equal(r.timedOut, false);
  assert.equal(r.cleanupVerified, true);
});
