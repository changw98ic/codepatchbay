import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  captureScriptChildIdentity as captureCiSmokeChildIdentity,
  run,
  runCiTemporaryWorkspace,
  startHubProcess,
  teardownScriptChildProcess as teardownCiSmokeChild,
} from "../scripts/ci-smoke.js";
import {
  captureScriptChildIdentity as captureReadinessChildIdentity,
  runIsolatedCheck,
  teardownScriptChildProcess as teardownReadinessChild,
} from "../scripts/validate-scan-readiness.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";
import {
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspace,
} from "../core/runtime/temporary-workspace.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-21T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function coarseIdentity(pid: number, birthId: string): ProcessIdentity {
  return {
    ...identity(pid, birthId),
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

function psResult(stdout = "", status = 0) {
  return { stdout, status } as ReturnType<ProcessTreeSystem["spawnSync"]>;
}

class FakeChildProcess extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = { destroy() {} };
  stdout = { destroy() {} };
  stderr = { destroy() {} };
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeadPid(pid: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`pid ${pid} remained alive after teardown`);
}

test("ci-smoke run timeout tears down the child tree before returning", async () => {
  const result = await run("-e", ["setInterval(() => {}, 10000);"], { timeout: 100 });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /command timed out after 100ms/);
});

test("ci-smoke hub startup timeout tears down the identity-bound process", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-script-startup-timeout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const pidFile = path.join(cwd, "server.pid");
  const serverPath = path.join(cwd, "silent-server.js");
  await writeFile(
    serverPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 10000);
`,
    "utf8",
  );
  await chmod(serverPath, 0o755);

  await assert.rejects(
    startHubProcess(path.join(cwd, "hub"), { serverPath, startupTimeoutMs: 100 }),
    /Hub start timed out/,
  );

  const pidText = await readFile(pidFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (pidText === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(readFile(pidFile, "utf8"), { code: "ENOENT" });
    return;
  }
  const pid = Number.parseInt(pidText, 10);
  assert.ok(Number.isInteger(pid) && pid > 0);
  await waitForDeadPid(pid);
});

test("npm-pack E2E cleanup delegates to identity-bound Hub shutdown", async () => {
  const source = await readFile(path.join(repoRoot, "scripts", "e2e-npm-pack.ts"), "utf8");
  const stepStop = source.match(/function stepStop\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(stepStop, /runInstalledCpb\(\["hub", "stop"\], \{ silent: true \}\)/);
  assert.doesNotMatch(stepStop, /allowFail\s*:\s*true/);
  assert.doesNotMatch(stepStop, /\b(?:pkill|killall)\b|cpb codegraph stop/);
});

test("script teardown helpers await close after normal finally cleanup", async () => {
  for (const teardown of [teardownCiSmokeChild, teardownReadinessChild]) {
    const root = identity(1234, `root-${Math.random()}`);
    const child = new FakeChildProcess();
    const signals: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
    let alive = true;
    let closeObserved = false;
    const system: ProcessTreeSystem = {
      platform: "linux",
      spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
      captureIdentity: (pid) => alive && Math.abs(pid) === root.pid ? root : null,
      kill: ((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) {
          if (!alive) throw Object.assign(new Error("missing"), { code: "ESRCH" });
          return true;
        }
        signals.push({ pid, signal: signal || "SIGTERM" });
        if (pid === root.pid) {
          alive = false;
          child.signalCode = signal as NodeJS.Signals;
          setTimeout(() => {
            closeObserved = true;
            child.emit("close", null, signal);
          }, 25);
        }
        return true;
      }) as ProcessTreeSystem["kill"],
    };

    await teardown(child as unknown as Parameters<typeof teardown>[0], {
      identity: root,
      graceMs: 0,
      closeTimeoutMs: 100,
      processTreeSystem: system,
    });

    assert.equal(closeObserved, true);
    assert.ok(signals.some((entry) => entry.pid === root.pid && entry.signal === "SIGTERM"));
  }
});

test("script teardown helpers refuse to signal a recycled root PID", async () => {
  for (const teardown of [teardownCiSmokeChild, teardownReadinessChild]) {
    const original = identity(1234, "original");
    const successor = identity(1234, "successor");
    const child = new FakeChildProcess();
    const signals: Array<number | NodeJS.Signals> = [];
    const system: ProcessTreeSystem = {
      platform: "linux",
      spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
      captureIdentity: () => successor,
      kill: ((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal !== 0) signals.push(signal || "SIGTERM");
        return true;
      }) as ProcessTreeSystem["kill"],
    };

    await assert.rejects(
      teardown(child as unknown as Parameters<typeof teardown>[0], {
        identity: original,
        graceMs: 0,
        closeTimeoutMs: 20,
        processTreeSystem: system,
      }),
      (error: unknown) => nestedErrorCodes(error).includes("PROCESS_IDENTITY_MISMATCH"),
    );
    assert.deepEqual(signals, []);
  }
});

test("script child identity capture accepts only exact spawn identities", () => {
  for (const capture of [captureCiSmokeChildIdentity, captureReadinessChildIdentity]) {
    const root = identity(1234, "root");
    const child = new FakeChildProcess();
    const exactSystem: ProcessTreeSystem = {
      platform: "linux",
      spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
      captureIdentity: () => root,
      kill: (() => true) as ProcessTreeSystem["kill"],
    };
    assert.deepEqual(capture(child as unknown as Parameters<typeof capture>[0], exactSystem), root);

    const missingSystem: ProcessTreeSystem = {
      ...exactSystem,
      captureIdentity: () => null,
    };
    assert.equal(capture(child as unknown as Parameters<typeof capture>[0], missingSystem), null);

    const coarseSystem: ProcessTreeSystem = {
      ...exactSystem,
      captureIdentity: () => coarseIdentity(1234, "root"),
    };
    assert.equal(capture(child as unknown as Parameters<typeof capture>[0], coarseSystem), null);

    for (const invalid of [
      { ...root, capturedAt: "2026-07-21T00:00:00Z" },
      { ...root, processGroupId: Number.MAX_SAFE_INTEGER + 1 },
      { ...root, pid: Number.MAX_SAFE_INTEGER + 1, incarnation: `${Number.MAX_SAFE_INTEGER + 1}:${root.birthId}` },
    ]) {
      const invalidSystem: ProcessTreeSystem = { ...exactSystem, captureIdentity: () => invalid };
      assert.equal(capture(child as unknown as Parameters<typeof capture>[0], invalidSystem), null);
    }
  }
});

test("script teardown helpers refuse missing or coarse identity without bare PID signal", async () => {
  for (const teardown of [teardownCiSmokeChild, teardownReadinessChild]) {
    for (const suppliedIdentity of [null, coarseIdentity(1234, "root")]) {
      const child = new FakeChildProcess();
      const signals: Array<number | NodeJS.Signals> = [];
      const system: ProcessTreeSystem = {
        platform: "linux",
        spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
        captureIdentity: () => identity(1234, "root"),
        kill: ((pid: number, signal?: number | NodeJS.Signals) => {
          if (signal !== 0) signals.push(signal || "SIGTERM");
          return true;
        }) as ProcessTreeSystem["kill"],
      };

      await assert.rejects(
        teardown(child as unknown as Parameters<typeof teardown>[0], {
          identity: suppliedIdentity,
          graceMs: 0,
          closeTimeoutMs: 20,
          processTreeSystem: system,
        }),
        (error: unknown) => nestedErrorCodes(error).includes("PROCESS_IDENTITY_UNAVAILABLE"),
      );
      assert.deepEqual(signals, []);
    }
  }
});

test("script teardown helpers arm close observation before signalling fast-closing child", async () => {
  for (const teardown of [teardownCiSmokeChild, teardownReadinessChild]) {
    const root = identity(1234, `root-${Math.random()}`);
    const child = new FakeChildProcess();
    let signalCount = 0;
    let alive = true;
    const system: ProcessTreeSystem = {
      platform: "linux",
      spawnSync: (() => psResult("")) as ProcessTreeSystem["spawnSync"],
      captureIdentity: () => alive ? root : null,
      kill: ((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) {
          if (!alive) throw Object.assign(new Error("missing"), { code: "ESRCH" });
          return true;
        }
        signalCount += 1;
        alive = false;
        child.signalCode = signal as NodeJS.Signals;
        child.emit("close", null, signal);
        return true;
      }) as ProcessTreeSystem["kill"],
    };

    await teardown(child as unknown as Parameters<typeof teardown>[0], {
      identity: root,
      graceMs: 0,
      closeTimeoutMs: 50,
      processTreeSystem: system,
    });

    assert.ok(signalCount > 0);
  }
});

test("scan readiness treats isolated Hub cleanup failure as a failed check", async () => {
  const cleanupError = Object.assign(new Error("quarantine destination occupied"), {
    code: "TEMPORARY_WORKSPACE_QUARANTINE_OCCUPIED",
  });
  let observedRoot = "";
  const result = await runIsolatedCheck({
    name: "cleanup-proof",
    fn: async (hubRoot) => {
      observedRoot = hubRoot;
      return { pass: true, detail: "check passed" };
    },
  }, {
    rootPath: "/tmp/cpb-val-owned",
    cleanup: async () => { throw cleanupError; },
  });

  assert.equal(observedRoot, "/tmp/cpb-val-owned");
  assert.equal(result.pass, false);
  assert.match(String(result.detail), /check passed; isolated Hub cleanup failed: quarantine destination occupied/);
  assert.equal(result.cleanupError, cleanupError);
});

test("scan readiness preserves both validation and cleanup failure evidence", async () => {
  const cleanupError = new Error("cleanup failed");
  const result = await runIsolatedCheck({
    name: "dual-failure",
    fn: async () => { throw new Error("validation failed"); },
  }, {
    rootPath: "/tmp/cpb-val-owned",
    cleanup: async () => { throw cleanupError; },
  });

  assert.equal(result.pass, false);
  assert.match(String(result.detail), /UNEXPECTED: validation failed/);
  assert.match(String(result.detail), /isolated Hub cleanup failed: cleanup failed/);
  assert.equal(result.cleanupError, cleanupError);
});

test("ci-smoke temporary workspace preserves primary and successor-safe cleanup recovery evidence", async () => {
  const primary = new Error("synthetic Hub smoke failure");
  const recovery = {
    version: 1,
    kind: "temporary_workspace_recovery",
    code: "TEMPORARY_WORKSPACE_SUCCESSOR_PRESERVED",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-ci-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-owned",
    },
    successorPreserved: true,
  } as const;
  const cleanupFailure = Object.assign(new Error("synthetic cleanup race"), {
    temporaryWorkspaceRecovery: recovery,
  });
  let cleanupCalls = 0;
  const workspace = {
    rootPath: "/tmp/cpb-ci-owned",
    cleanup: async () => {
      cleanupCalls += 1;
      throw cleanupFailure;
    },
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runCiTemporaryWorkspace(
      "cpb-ci-test-",
      async (rootPath) => {
        assert.equal(rootPath, workspace.rootPath);
        throw primary;
      },
      async () => workspace,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanupFailure]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, recovery);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, recovery.recoveryPaths);
      assert.equal((error as { successorPreserved?: unknown }).successorPreserved, true);
      return true;
    },
  );
  assert.equal(cleanupCalls, 1);
});

test("ci-smoke workspace cleanup never clobbers a hostile same-path successor", async () => {
  const primary = new Error("synthetic smoke failure after ownership replacement");
  let canonicalRoot = "";
  let movedOwnedRoot = "";
  try {
    await assert.rejects(
      runCiTemporaryWorkspace("cpb-ci-successor-", async (rootPath) => {
        canonicalRoot = rootPath;
        movedOwnedRoot = `${rootPath}.owned`;
        await rename(rootPath, movedOwnedRoot);
        await mkdir(rootPath);
        await writeFile(path.join(rootPath, "successor.txt"), "must survive\n", "utf8");
        throw primary;
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], primary);
        const recovery = temporaryWorkspaceErrorDetails(error);
        assert.equal(recovery?.successorPreserved, true);
        assert.equal(recovery?.committed, false);
        assert.equal(recovery?.recoveryPaths.canonicalRoot, canonicalRoot);
        return true;
      },
    );
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "must survive\n");
    assert.ok(movedOwnedRoot);
  } finally {
    if (canonicalRoot) await rm(canonicalRoot, { recursive: true, force: true });
    if (movedOwnedRoot) await rm(movedOwnedRoot, { recursive: true, force: true });
  }
});

test("ci-smoke operation failure reports successful quarantine proof", async () => {
  const primary = new Error("synthetic operation failure");
  const cleanupProof = {
    version: 1,
    kind: "temporary_workspace_disposition",
    recoveryPaths: {
      canonicalRoot: "/tmp/cpb-ci-proof-owned",
      quarantineRoot: "/tmp/.cpb-quarantine-proof-owned",
    },
    successorPreserved: false,
  } as const;
  const workspace = {
    rootPath: cleanupProof.recoveryPaths.canonicalRoot,
    cleanup: async () => cleanupProof,
  } as unknown as TemporaryWorkspace;

  await assert.rejects(
    runCiTemporaryWorkspace(
      "cpb-ci-proof-",
      async () => { throw primary; },
      async () => workspace,
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary]);
      assert.equal(error.cause, primary);
      assert.equal((error as { temporaryWorkspaceRecovery?: unknown }).temporaryWorkspaceRecovery, cleanupProof);
      assert.deepEqual((error as { recoveryPaths?: unknown }).recoveryPaths, cleanupProof.recoveryPaths);
      return true;
    },
  );
});
