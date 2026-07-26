import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  _internalQuotaDelegateMutationFenceForTests,
  acquireQuotaDelegateLock,
  cleanupQuotaDelegateLock,
  processQuotaDelegateInbox,
  type QuotaDelegateLockReceipt as DelegateProcessLockReceipt,
} from "../server/services/quota-delegate.js";
import {
  appendCommand,
  delegateEnqueueProviderUsage,
  delegateMarkProviderUnavailable,
  isDelegateAlive,
  parseQuotaDelegateLockReceipt,
  readQuotaDelegateLockReceipt,
  waitForAck,
  waitForDelegateIncarnation,
  withQuotaDelegateClientPersistenceHooksForTests,
} from "../server/services/quota-delegate-client.js";
import { captureProcessIdentity, type ProcessIdentity } from "../core/runtime/process-tree.js";
import { QuotaStatus, readProviderQuotas, withProviderQuotaPersistenceHooksForTests } from "../server/services/provider-quota.js";
import { _internalAppendUsageLine, readProviderUsage } from "../server/services/provider-usage.js";

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for quota delegate");
}

test("quota delegate processes provider quota and usage IPC commands", async (t) => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-"));
  const scriptPath = fileURLToPath(new URL("../server/services/quota-delegate.js", import.meta.url));
  const ownerToken = "unit-test-owner-token";
  let output = "";
  const child = spawn(process.execPath, [scriptPath, "--hub-root", hubRoot, "--owner-token", ownerToken], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url)), ".."),
    env: { ...process.env, CPB_HUB_ROOT: hubRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  t.after(() => {
    if (child.pid) child.kill("SIGTERM");
  });

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`quota delegate exited early with ${child.exitCode}: ${output}`);
    }
    return isDelegateAlive(hubRoot);
  });

  const nextEligibleAt = Date.now() + 60_000;
  const entry = await delegateMarkProviderUnavailable(hubRoot, {
    providerKey: "claude:glm",
    agent: "claude-glm",
    variant: "glm",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt,
    source: "unit-test",
    confidence: 0.9,
    reason: "429 from provider",
  });
  assert.equal(entry.providerKey, "claude:glm");
  assert.equal(entry.status, QuotaStatus.RATE_LIMITED);

  const quotas = await readProviderQuotas(hubRoot);
  assert.equal(quotas["claude:glm"].agent, "claude-glm");
  assert.equal(quotas["claude:glm"].nextEligibleAt, nextEligibleAt);

  await delegateEnqueueProviderUsage(hubRoot, {
    project: "flow",
    jobId: "job-routing-history",
    attemptId: "attempt-2",
    taskCategory: "bugfix",
    retryCount: 2,
    jobRetryCount: 1,
    phaseRetryCount: 1,
    isRetry: true,
    phase: "execute",
    role: "executor",
    providerKey: "claude:glm",
    agent: "claude-glm",
    variant: "glm",
    status: "rate_limited",
    phaseStatus: "failed",
    failureKind: "timeout",
    durationMs: 42,
    source: "unit-test",
  });
  await waitFor(async () => (await readProviderUsage(hubRoot)).length === 1);
  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage[0].providerKey, "claude:glm");
  assert.equal(usage[0].status, "rate_limited");
  assert.equal(usage[0].jobId, "job-routing-history");
  assert.equal(usage[0].attemptId, "attempt-2");
  assert.equal(usage[0].taskCategory, "bugfix");
  assert.equal(usage[0].retryCount, 2);
  assert.equal(usage[0].jobRetryCount, 1);
  assert.equal(usage[0].phaseRetryCount, 1);
  assert.equal(usage[0].isRetry, true);
  assert.equal(usage[0].failureKind, "timeout");
  assert.match(String(usage[0].recordedAt), /^\d{4}-\d{2}-\d{2}T/);

  const lock = JSON.parse(await readFile(path.join(hubRoot, "providers", "delegate", "delegate.lock"), "utf8"));
  assert.equal(lock.pid, child.pid);
  assert.equal(lock.ownerToken, ownerToken);
  assert.equal(lock.processIdentity.pid, child.pid);
  assert.equal(lock.processIdentity.birthIdPrecision, "exact");
  assert.equal(lock.incarnation, lock.processIdentity.incarnation);
});

function lockPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "delegate.lock");
}

function claimPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "delegate.lock.claim");
}

function inboxPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "inbox");
}

function acksPath(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate", "acks");
}

function transactionPath(hubRoot: string, mutationId: string) {
  return path.join(hubRoot, "providers", "delegate", "transactions", `${mutationId}.json`);
}

function digestRaw(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function listenOnLocalPort(server: net.Server, port: number) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
}

async function closeServer(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readLocalPortLine(port: number) {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out reading local port ${port}`));
    }, 1_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response.slice(0, newline));
      }
    });
    socket.on("end", () => {
      clearTimeout(timeout);
      resolve(response.trim());
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function writeLockReceipt(hubRoot: string, receipt: DelegateProcessLockReceipt) {
  await mkdir(path.dirname(lockPath(hubRoot)), { recursive: true });
  await writeFile(lockPath(hubRoot), JSON.stringify(receipt, null, 2) + "\n", "utf8");
}

function currentIdentity() {
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  return { ...identity, birthIdPrecision: "exact" as const };
}

function receiptFor(hubRoot: string, identity: ProcessIdentity, ownerToken = "owner-token"): DelegateProcessLockReceipt {
  return {
    pid: identity.pid,
    hubRoot,
    startedAt: "2026-01-01T00:00:00.000Z",
    ownerToken,
    generation: `${ownerToken}-generation`,
    processIdentity: identity,
    incarnation: identity.incarnation,
  };
}

function invalidPersistedIdentityCases(identity: ProcessIdentity) {
  const noncanonicalIncarnation = `${identity.incarnation}:mismatch`;
  return [
    {
      name: "null-identity",
      processIdentity: null,
      outerIncarnation: identity.incarnation,
    },
    {
      name: "missing-precision",
      processIdentity: { ...identity, birthIdPrecision: undefined },
      outerIncarnation: identity.incarnation,
    },
    {
      name: "null-precision",
      processIdentity: { ...identity, birthIdPrecision: null },
      outerIncarnation: identity.incarnation,
    },
    {
      name: "coarse-precision",
      processIdentity: { ...identity, birthIdPrecision: "coarse" },
      outerIncarnation: identity.incarnation,
    },
    {
      name: "noncanonical-incarnation",
      processIdentity: { ...identity, incarnation: noncanonicalIncarnation },
      outerIncarnation: noncanonicalIncarnation,
    },
    {
      name: "invalid-captured-at",
      processIdentity: { ...identity, capturedAt: "not-a-timestamp" },
      outerIncarnation: identity.incarnation,
    },
    {
      name: "noncanonical-captured-at",
      processIdentity: { ...identity, capturedAt: "2026-01-01T00:00:00Z" },
      outerIncarnation: identity.incarnation,
    },
  ];
}

test("quota delegate lock acquisition is exclusive for concurrent delegates", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-lock-"));
  const results = await Promise.allSettled([
    acquireQuotaDelegateLock(hubRoot),
    acquireQuotaDelegateLock(hubRoot),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok([
    "QUOTA_DELEGATE_ALREADY_RUNNING",
    "QUOTA_DELEGATE_LOCK_BUSY",
  ].includes(((rejected[0] as PromiseRejectedResult).reason as NodeJS.ErrnoException).code || ""));

  await cleanupQuotaDelegateLock(hubRoot, (fulfilled[0] as PromiseFulfilledResult<DelegateProcessLockReceipt>).value);
});

test("quota delegate persists explicit exact identities for both lock and mutation claim owners", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-exact-identity-"));
  let claimPrecision: unknown;
  const receipt = await acquireQuotaDelegateLock(hubRoot, {
    hooks: {
      afterMutationClaimAcquired: async ({ claimPath: acquiredClaimPath }) => {
        const claim = JSON.parse(await readFile(acquiredClaimPath, "utf8")) as {
          processIdentity?: { birthIdPrecision?: unknown };
        };
        claimPrecision = claim.processIdentity?.birthIdPrecision;
      },
    },
  });
  const persisted = JSON.parse(await readFile(lockPath(hubRoot), "utf8")) as DelegateProcessLockReceipt;

  assert.equal(receipt.processIdentity.birthIdPrecision, "exact");
  assert.equal(persisted.processIdentity.birthIdPrecision, "exact");
  assert.equal(claimPrecision, "exact");
  assert.equal(parseQuotaDelegateLockReceipt(JSON.stringify(persisted), hubRoot).processIdentity.birthIdPrecision, "exact");

  await cleanupQuotaDelegateLock(hubRoot, receipt);
});

test("quota delegate stale recovery serializes three contenders without deleting the winner", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-race-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-owner`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-owner`,
  };
  await writeLockReceipt(hubRoot, receiptFor(hubRoot, staleIdentity, "stale-owner"));

  const claimHeld = deferred();
  const releaseClaim = deferred();
  const first = acquireQuotaDelegateLock(hubRoot, {
    ownerToken: "reaper-a",
    hooks: {
      afterMutationClaimAcquired: async () => {
        claimHeld.resolve();
        await releaseClaim.promise;
      },
    },
  });
  await claimHeld.promise;

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, { ownerToken: "reaper-b" }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_BUSY",
  );
  releaseClaim.resolve();
  const winner = await first;

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, { ownerToken: "reaper-c" }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ALREADY_RUNNING",
  );
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.generation, winner.generation);
  await cleanupQuotaDelegateLock(hubRoot, winner);
});

test("quota delegate stale recovery preserves a canonical third-party ABA successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-lock-aba-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-lock-aba`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-lock-aba`,
  };
  const stale = receiptFor(hubRoot, staleIdentity, "stale-aba-owner");
  const successor = receiptFor(hubRoot, identity, "stale-aba-successor");
  const retiredPath = `${lockPath(hubRoot)}.retired`;
  let successorInode = 0;
  let quarantinePath = "";
  await writeLockReceipt(hubRoot, stale);

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, {
      ownerToken: "stale-aba-reaper",
      hooks: {
        afterStaleLockObserved: async ({ receipt }) => {
          assert.equal(receipt.generation, stale.generation);
          await rename(lockPath(hubRoot), retiredPath);
          await writeLockReceipt(hubRoot, successor);
          successorInode = (await lstat(lockPath(hubRoot))).ino;
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: { canonical?: string; quarantine?: string };
    }) => {
      quarantinePath = error.recoveryPaths?.quarantine || "";
      return error.code === "QUOTA_DELEGATE_LOCK_RACE"
        && error.committed === false
        && error.quarantinePreserved === false
        && error.successorPreserved === true
        && error.recoveryPaths?.canonical === lockPath(hubRoot)
        && quarantinePath.length > 0;
    },
  );

  const preserved = await readQuotaDelegateLockReceipt(hubRoot);
  assert.equal(preserved?.ownerToken, successor.ownerToken);
  assert.equal(preserved?.generation, successor.generation);
  assert.equal(preserved?.processIdentity.incarnation, successor.processIdentity.incarnation);
  assert.equal((await lstat(lockPath(hubRoot))).ino, successorInode);
  await assert.rejects(lstat(quarantinePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await rm(retiredPath, { force: true });
  await cleanupQuotaDelegateLock(hubRoot, successor);
});

test("quota delegate stale-owner probe errors fail closed and preserve the lock", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-probe-error-"));
  const stale = receiptFor(hubRoot, currentIdentity(), "probe-owner");
  await writeLockReceipt(hubRoot, stale);
  const probeError = Object.assign(new Error("probe denied"), { code: "EPERM" });

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, {
      identityAlive: () => {
        throw probeError;
      },
    }),
    (error: NodeJS.ErrnoException) => error === probeError && error.code === "EPERM",
  );
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.generation, stale.generation);
});

test("quota delegate reports a committed receipt when post-link cleanup fails", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-commit-cleanup-"));
  let movedTemp = "";
  let obstructingTemp = "";

  let committedError: (Error & {
    code?: string;
    outcome?: {
      committed: boolean;
      receipt: DelegateProcessLockReceipt;
      cleanupErrors: NodeJS.ErrnoException[];
    };
  }) | null = null;
  try {
    await acquireQuotaDelegateLock(hubRoot, {
      ownerToken: "commit-cleanup-owner",
      hooks: {
        afterLockCommitted: async ({ tempPath }) => {
          movedTemp = `${tempPath}.moved`;
          obstructingTemp = tempPath;
          await rename(tempPath, movedTemp);
          await mkdir(tempPath);
        },
      },
    });
  } catch (error) {
    committedError = error as typeof committedError;
  }

  assert.ok(committedError);
  assert.equal(committedError.code, "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED");
  assert.equal(committedError.outcome?.committed, true);
  assert.ok(committedError.outcome?.receipt.generation);
  assert.ok(committedError.outcome?.cleanupErrors.some((error) => error.code === "QUOTA_DELEGATE_TEMP_RACE"));
  assert.equal(
    (await readQuotaDelegateLockReceipt(hubRoot))?.generation,
    committedError.outcome?.receipt.generation,
  );

  if (obstructingTemp) await rm(obstructingTemp, { recursive: true, force: true });
  if (movedTemp) await rm(movedTemp, { force: true });
  await cleanupQuotaDelegateLock(hubRoot, committedError.outcome!.receipt);
});

test("quota delegate candidate cleanup preserves a same-path file successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-candidate-successor-"));
  let tempPath = "";
  let retiredPath = "";
  const successor = "candidate-successor-must-survive\n";
  let committedError: (Error & {
    code?: string;
    outcome?: { committed: boolean; receipt: DelegateProcessLockReceipt; residualPaths: string[] };
  }) | null = null;

  try {
    await acquireQuotaDelegateLock(hubRoot, {
      ownerToken: "candidate-successor-owner",
      hooks: {
        afterLockCommitted: async ({ tempPath: observedTempPath }) => {
          tempPath = observedTempPath;
          retiredPath = `${tempPath}.retired-owner`;
          await rename(tempPath, retiredPath);
          await writeFile(tempPath, successor, "utf8");
        },
      },
    });
  } catch (error) {
    committedError = error as typeof committedError;
  }

  assert.ok(committedError);
  assert.equal(committedError.code, "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED");
  assert.equal(committedError.outcome?.committed, true);
  assert.ok(committedError.outcome?.residualPaths.includes(tempPath));
  assert.equal(await readFile(tempPath, "utf8"), successor);
  await rm(tempPath, { force: true });
  await rm(retiredPath, { force: true });
  await cleanupQuotaDelegateLock(hubRoot, committedError.outcome!.receipt);
});

test("quota delegate mutation claim release preserves a post-validation successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-claim-release-successor-"));
  let quarantinePath = "";
  let replacement = "";
  let injected = false;
  let committedError: (Error & {
    code?: string;
    outcome?: { committed: boolean; receipt: DelegateProcessLockReceipt; residualPaths: string[] };
  }) | null = null;

  try {
    await acquireQuotaDelegateLock(hubRoot, {
      ownerToken: "claim-release-successor-owner",
      hooks: {
        afterMutationClaimValidated: async (context) => {
          if (context.action !== "release" || injected) return;
          injected = true;
          quarantinePath = context.quarantinePath;
          const claim = JSON.parse(await readFile(quarantinePath, "utf8"));
          replacement = `${JSON.stringify({ ...claim, marker: "release-successor" }, null, 2)}\n`;
          await rm(quarantinePath);
          await writeFile(quarantinePath, replacement, "utf8");
        },
      },
    });
  } catch (error) {
    committedError = error as typeof committedError;
  }

  assert.ok(committedError);
  assert.equal(committedError.code, "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED");
  assert.equal(committedError.outcome?.committed, true);
  assert.equal(await readFile(quarantinePath, "utf8"), replacement);
  await cleanupQuotaDelegateLock(hubRoot, committedError.outcome!.receipt);
});

test("runQuotaDelegate refuses to start when committed-claim cleanup fails and reports the residual lock", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-claim-cleanup-"));
  let movedClaim = "";
  let runError: (Error & {
    code?: string;
    committedOutcome?: { receipt: DelegateProcessLockReceipt; residualPaths: string[] };
    residualLock?: DelegateProcessLockReceipt | null;
    rollbackErrors?: Error[];
  }) | null = null;
  try {
    const { runQuotaDelegate } = await import("../server/services/quota-delegate.js");
    await runQuotaDelegate(hubRoot, {
      ownerToken: "claim-cleanup-owner",
      hooks: {
        afterLockCommitted: async ({ claimPath: committedClaimPath }) => {
          movedClaim = `${committedClaimPath}.moved`;
          await rename(committedClaimPath, movedClaim);
          await mkdir(committedClaimPath);
        },
      },
    });
  } catch (error) {
    runError = error as typeof runError;
  }

  assert.ok(runError);
  assert.equal(runError.code, "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED");
  assert.ok(runError.committedOutcome?.receipt.generation);
  assert.ok(runError.committedOutcome?.residualPaths.includes(claimPath(hubRoot)));
  assert.equal(runError.residualLock?.generation, runError.committedOutcome?.receipt.generation);
  assert.ok((runError.rollbackErrors?.length || 0) > 0);

  await rm(claimPath(hubRoot), { recursive: true, force: true });
  if (movedClaim) await rm(movedClaim, { force: true });
  await cleanupQuotaDelegateLock(hubRoot, runError.committedOutcome!.receipt);
});

test("quota delegate automatically recovers a crashed stale mutation claim", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-claim-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-claim`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-claim`,
  };
  await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
  await writeFile(claimPath(hubRoot), JSON.stringify({
    version: 1,
    hubRoot,
    claimToken: "abandoned-claim",
    purpose: "acquire",
    targetGeneration: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    processIdentity: staleIdentity,
  }, null, 2) + "\n", "utf8");

  const receipt = await acquireQuotaDelegateLock(hubRoot);
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.generation, receipt.generation);
  await cleanupQuotaDelegateLock(hubRoot, receipt);
});

test("quota delegate stale mutation claim recovery is fenced against third-party successors", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-claim-aba-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-claim-aba`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-claim-aba`,
  };
  await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
  await writeFile(claimPath(hubRoot), JSON.stringify({
    version: 1,
    hubRoot,
    claimToken: "abandoned-claim",
    purpose: "acquire",
    targetGeneration: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    processIdentity: staleIdentity,
  }, null, 2) + "\n", "utf8");

  const staleObserved = deferred();
  const releaseRecovery = deferred();
  const first = acquireQuotaDelegateLock(hubRoot, {
    ownerToken: "reaper-a",
    hooks: {
      afterStaleMutationClaimObserved: async () => {
        staleObserved.resolve();
        await releaseRecovery.promise;
      },
    },
  });
  await staleObserved.promise;

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, { ownerToken: "successor-b" }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_BUSY",
  );

  releaseRecovery.resolve();
  const receipt = await first;
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.ownerToken, "reaper-a");
  await cleanupQuotaDelegateLock(hubRoot, receipt);
});

test("quota delegate stale mutation claim recovery preserves a post-validation successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-claim-post-validation-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-claim-post-validation`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-claim-post-validation`,
  };
  const staleClaim = {
    version: 1,
    hubRoot,
    claimToken: "stale-post-validation-claim",
    purpose: "acquire",
    targetGeneration: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    processIdentity: staleIdentity,
  };
  await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
  await writeFile(claimPath(hubRoot), JSON.stringify(staleClaim, null, 2) + "\n", "utf8");
  let quarantinePath = "";
  const successor = `${JSON.stringify({ ...staleClaim, marker: "claim-successor" }, null, 2)}\n`;

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, {
      hooks: {
        afterMutationClaimValidated: async (context) => {
          if (context.action !== "stale-recovery") return;
          quarantinePath = context.quarantinePath;
          await rm(quarantinePath);
          await writeFile(quarantinePath, successor, "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException & { committed?: boolean; recoveryPaths?: { quarantine?: string } }) => (
      error.code === "QUOTA_DELEGATE_MUTATION_CLAIM_RACE"
      && error.committed === true
      && error.recoveryPaths?.quarantine === quarantinePath
    ),
  );
  assert.equal(await readFile(quarantinePath, "utf8"), successor);
});

test("quota delegate stale mutation claim probe errors fail closed and preserve the claim", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-stale-claim-eperm-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale-claim-eperm`,
    incarnation: `${identity.pid}:${identity.birthId}:stale-claim-eperm`,
  };
  await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
  await writeFile(claimPath(hubRoot), JSON.stringify({
    version: 1,
    hubRoot,
    claimToken: "eperm-claim",
    purpose: "acquire",
    targetGeneration: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    processIdentity: staleIdentity,
  }, null, 2) + "\n", "utf8");
  const probeError = Object.assign(new Error("probe denied"), { code: "EPERM" });

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, {
      identityAlive: () => {
        throw probeError;
      },
    }),
    (error: NodeJS.ErrnoException) => error === probeError && error.code === "EPERM",
  );
  assert.match(await readFile(claimPath(hubRoot), "utf8"), /eperm-claim/);
});

test("quota delegate rejects malformed persisted mutation claim identities without removing them", async () => {
  const identity = currentIdentity();
  for (const invalidCase of invalidPersistedIdentityCases(identity)) {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), `cpb-quota-delegate-invalid-claim-${invalidCase.name}-`));
    const persistedClaim = JSON.stringify({
      version: 1,
      hubRoot,
      claimToken: `invalid-${invalidCase.name}`,
      purpose: "acquire",
      targetGeneration: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      processIdentity: invalidCase.processIdentity,
    }, null, 2) + "\n";
    await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
    await writeFile(claimPath(hubRoot), persistedClaim, "utf8");

    await assert.rejects(
      acquireQuotaDelegateLock(hubRoot),
      (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
      invalidCase.name,
    );
    assert.equal(await readFile(claimPath(hubRoot), "utf8"), persistedClaim, invalidCase.name);
  }
});

test("quota delegate preserves mutation claims with noncanonical timestamps", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-noncanonical-claim-time-"));
  const persistedClaim = JSON.stringify({
    version: 1,
    hubRoot,
    claimToken: "noncanonical-time",
    purpose: "acquire",
    targetGeneration: null,
    createdAt: "2026-01-01T00:00:00Z",
    processIdentity: currentIdentity(),
  }, null, 2) + "\n";
  await mkdir(path.dirname(claimPath(hubRoot)), { recursive: true });
  await writeFile(claimPath(hubRoot), persistedClaim, "utf8");

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
  );
  assert.equal(await readFile(claimPath(hubRoot), "utf8"), persistedClaim);
});

test("quota delegate mutation fence skips an unrelated listener on the first candidate port", async (t) => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-fence-unrelated-"));
  const [firstPort] = _internalQuotaDelegateMutationFenceForTests(hubRoot).ports;
  const unrelated = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.end("unrelated-service\n");
  });
  unrelated.unref();
  await listenOnLocalPort(unrelated, firstPort);
  t.after(() => closeServer(unrelated).catch(() => undefined));

  const receipt = await acquireQuotaDelegateLock(hubRoot, { ownerToken: "fence-unrelated-owner" });
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.ownerToken, "fence-unrelated-owner");
  await cleanupQuotaDelegateLock(hubRoot, receipt);
});

test("quota delegate mutation fence rejects an existing owner with the same fence key", async (t) => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-fence-same-key-"));
  const fence = _internalQuotaDelegateMutationFenceForTests(hubRoot);
  const [firstPort] = fence.ports;
  const owner = spawn(process.execPath, [
    "-e",
    [
      "const net = require('node:net');",
      "const port = Number(process.argv[1]);",
      "const response = process.argv[2];",
      "const server = net.createServer((socket) => {",
      "  socket.on('error', () => undefined);",
      "  socket.end(response);",
      "});",
      "server.listen({ host: '127.0.0.1', port, exclusive: true }, () => process.stdout.write('ready\\n'));",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"),
    String(firstPort),
    `${fence.protocol}${fence.key}\n`,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  owner.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  t.after(() => {
    if (owner.exitCode === null) owner.kill("SIGTERM");
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out waiting for same-key fence owner: ${stderr}`));
    }, 5_000);
    owner.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("ready")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    owner.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`same-key fence owner exited early with ${code}: ${stderr}`));
    });
  });
  assert.equal(await readLocalPortLine(firstPort), `${fence.protocol}${fence.key}`);
  assert.equal(owner.exitCode, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await readLocalPortLine(firstPort), `${fence.protocol}${fence.key}`);

  try {
    const receipt = await acquireQuotaDelegateLock(hubRoot, { ownerToken: "fence-same-key-contender" });
    await cleanupQuotaDelegateLock(hubRoot, receipt).catch(() => undefined);
    assert.fail(`same-key fence owner was bypassed on port ${firstPort}; childExit=${owner.exitCode}; key=${fence.key}`);
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, "QUOTA_DELEGATE_LOCK_BUSY");
  }
  assert.equal(await readQuotaDelegateLockReceipt(hubRoot), null);
});

test("quota delegate mutation fence fails closed when an occupied port will not identify itself", async (t) => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-fence-unresponsive-"));
  const [firstPort] = _internalQuotaDelegateMutationFenceForTests(hubRoot).ports;
  const unresponsive = net.createServer((socket) => {
    socket.on("error", () => undefined);
  });
  unresponsive.unref();
  await listenOnLocalPort(unresponsive, firstPort);
  t.after(() => closeServer(unresponsive).catch(() => undefined));

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot, { ownerToken: "fence-unresponsive-contender" }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_BUSY",
  );
});

test("quota delegate lock acquisition surfaces owner write/read failures", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-bad-lock-"));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(lockPath(hubRoot), { recursive: true }));

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
});

test("quota delegate rejects malformed persisted lock identities without replacing them", async () => {
  const identity = currentIdentity();
  for (const invalidCase of invalidPersistedIdentityCases(identity)) {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), `cpb-quota-delegate-invalid-lock-${invalidCase.name}-`));
    const persistedLock = JSON.stringify({
      ...receiptFor(hubRoot, identity, `invalid-${invalidCase.name}`),
      processIdentity: invalidCase.processIdentity,
      incarnation: invalidCase.outerIncarnation,
    }, null, 2) + "\n";
    await mkdir(path.dirname(lockPath(hubRoot)), { recursive: true });
    await writeFile(lockPath(hubRoot), persistedLock, "utf8");

    await assert.rejects(
      acquireQuotaDelegateLock(hubRoot),
      (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
      invalidCase.name,
    );
    assert.equal(await readFile(lockPath(hubRoot), "utf8"), persistedLock, invalidCase.name);
  }
});

test("quota delegate rejects a symlinked lock instead of following external owner state", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-symlink-lock-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-external-lock-"));
  const externalLock = path.join(externalRoot, "delegate.lock");
  await mkdir(path.dirname(lockPath(hubRoot)), { recursive: true });
  await writeFile(externalLock, JSON.stringify(receiptFor(hubRoot, currentIdentity()), null, 2) + "\n", "utf8");
  await symlink(externalLock, lockPath(hubRoot));

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
  await assert.rejects(
    readQuotaDelegateLockReceipt(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
});

test("quota delegate rejects an oversized lock receipt without replacing it", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-oversized-lock-"));
  const oversized = "x".repeat(1024 * 1024 + 1);
  await mkdir(path.dirname(lockPath(hubRoot)), { recursive: true });
  await writeFile(lockPath(hubRoot), oversized, "utf8");

  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
  assert.equal((await lstat(lockPath(hubRoot))).size, oversized.length);
});

test("quota delegate rejects a receipt bound to a different hub root", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-wrong-root-"));
  const otherHubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-other-root-"));
  await writeLockReceipt(hubRoot, receiptFor(otherHubRoot, currentIdentity()));

  await assert.rejects(
    readQuotaDelegateLockReceipt(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
  await assert.rejects(
    acquireQuotaDelegateLock(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
});

test("quota delegate client rejects malformed lock receipts", () => {
  assert.throws(
    () => parseQuotaDelegateLockReceipt(JSON.stringify({ pid: process.pid })),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );

  const hubRoot = path.join(os.tmpdir(), "cpb-quota-delegate-client-invalid-identity");
  const identity = currentIdentity();
  for (const invalidCase of invalidPersistedIdentityCases(identity)) {
    assert.throws(
      () => parseQuotaDelegateLockReceipt(JSON.stringify({
        ...receiptFor(hubRoot, identity, `invalid-${invalidCase.name}`),
        processIdentity: invalidCase.processIdentity,
        incarnation: invalidCase.outerIncarnation,
      }), hubRoot),
      (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
      invalidCase.name,
    );
  }
  assert.throws(
    () => parseQuotaDelegateLockReceipt(JSON.stringify({
      ...receiptFor(hubRoot, identity, "noncanonical-started-at"),
      startedAt: "2026-01-01T00:00:00Z",
    }), hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_INVALID",
  );
});

test("quota delegate client rejects unbound and symlinked acknowledgements", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-invalid-ack-"));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-external-ack-"));
  const commandId = "invalid-ack-command";
  const ackPath = path.join(acksPath(hubRoot), `${commandId}.json`);
  const externalAck = path.join(externalRoot, `${commandId}.json`);
  const ack = {
    commandId,
    mutationId: commandId,
    hubRoot: "",
    ts: new Date().toISOString(),
    ok: true,
  };
  await mkdir(acksPath(hubRoot), { recursive: true });
  await writeFile(ackPath, JSON.stringify(ack) + "\n", "utf8");

  await assert.rejects(
    waitForAck(hubRoot, commandId, 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );

  ack.hubRoot = hubRoot;
  ack.mutationId = "different-mutation";
  await writeFile(ackPath, JSON.stringify(ack) + "\n", "utf8");
  await assert.rejects(
    waitForAck(hubRoot, commandId, 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );

  ack.mutationId = commandId;
  await writeFile(externalAck, JSON.stringify(ack) + "\n", "utf8");
  await rm(ackPath);
  await symlink(externalAck, ackPath);
  await assert.rejects(
    waitForAck(hubRoot, commandId, 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ACK_INVALID",
  );
  await assert.rejects(
    waitForAck(hubRoot, "../outside", 100),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_COMMAND_INVALID",
  );
});

test("isDelegateAlive validates process birth identity instead of pid only", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-reused-pid-"));
  const identity = currentIdentity();
  const staleIdentity = {
    ...identity,
    birthId: `${identity.birthId}:stale`,
    incarnation: `${identity.pid}:${identity.birthId}:stale`,
  };
  await writeLockReceipt(hubRoot, receiptFor(hubRoot, staleIdentity));

  assert.equal(await isDelegateAlive(hubRoot), false);
});

test("quota delegate cleanup is fenced by owner token and preserves successors", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-"));
  const identity = currentIdentity();
  const successor = receiptFor(hubRoot, identity, "successor-token");
  await writeLockReceipt(hubRoot, successor);

  await cleanupQuotaDelegateLock(hubRoot, receiptFor(hubRoot, identity, "old-token"));

  const lock = await readQuotaDelegateLockReceipt(hubRoot);
  assert.equal(lock?.ownerToken, "successor-token");
});

test("quota delegate cleanup removes only the matching owner", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-owner-"));
  const receipt = receiptFor(hubRoot, currentIdentity(), "matching-token");
  await writeLockReceipt(hubRoot, receipt);

  await cleanupQuotaDelegateLock(hubRoot, receipt);

  assert.equal(await readQuotaDelegateLockReceipt(hubRoot), null);
});

test("concurrent same-owner cleanup cannot delete a successor generation", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-race-"));
  const original = await acquireQuotaDelegateLock(hubRoot, { ownerToken: "shared-owner" });
  const observed = deferred();
  const releaseCleanup = deferred();
  const firstCleanup = cleanupQuotaDelegateLock(hubRoot, original, {
    hooks: {
      afterOwnedLockObserved: async () => {
        observed.resolve();
        await releaseCleanup.promise;
      },
    },
  });
  await observed.promise;

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, original),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_LOCK_BUSY",
  );
  releaseCleanup.resolve();
  await firstCleanup;

  const successor = await acquireQuotaDelegateLock(hubRoot, { ownerToken: "shared-owner" });
  assert.notEqual(successor.generation, original.generation);
  const staleCleanup = await cleanupQuotaDelegateLock(hubRoot, original);
  assert.equal(staleCleanup.status, "preserved");
  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.generation, successor.generation);
  await cleanupQuotaDelegateLock(hubRoot, successor);
});

test("quota delegate cleanup preserves a canonical third-party ABA successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-aba-"));
  const identity = currentIdentity();
  const original = receiptFor(hubRoot, identity, "cleanup-aba-owner");
  const successorIdentity = {
    ...identity,
    birthId: `${identity.birthId}:cleanup-aba-successor`,
    incarnation: `${identity.pid}:${identity.birthId}:cleanup-aba-successor`,
  };
  const successor = {
    ...receiptFor(hubRoot, successorIdentity, "cleanup-aba-successor"),
    generation: "cleanup-aba-successor-generation",
  };
  await writeLockReceipt(hubRoot, original);
  const originalInode = (await lstat(lockPath(hubRoot))).ino;
  let successorInode = 0;
  let quarantinePath = "";

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, original, {
      hooks: {
        afterOwnedLockObserved: async ({ receipt }) => {
          assert.equal(receipt.generation, original.generation);
          await writeLockReceipt(hubRoot, successor);
          successorInode = (await lstat(lockPath(hubRoot))).ino;
          assert.equal(successorInode, originalInode);
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: { canonical?: string; quarantine?: string };
    }) => {
      quarantinePath = error.recoveryPaths?.quarantine || "";
      return error.code === "QUOTA_DELEGATE_LOCK_RACE"
        && error.committed === false
        && error.quarantinePreserved === false
        && error.successorPreserved === true
        && error.recoveryPaths?.canonical === lockPath(hubRoot)
        && quarantinePath.length > 0;
    },
  );

  const preserved = await readQuotaDelegateLockReceipt(hubRoot);
  assert.equal(preserved?.ownerToken, successor.ownerToken);
  assert.equal(preserved?.generation, successor.generation);
  assert.equal(preserved?.processIdentity.incarnation, successor.processIdentity.incarnation);
  assert.equal((await lstat(lockPath(hubRoot))).ino, successorInode);
  await assert.rejects(lstat(quarantinePath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await cleanupQuotaDelegateLock(hubRoot, successor);
});

test("quota delegate cleanup preserves both a canonical successor and its quarantine", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-successor-"));
  const identity = currentIdentity();
  const original = receiptFor(hubRoot, identity, "cleanup-successor-original");
  const successor = {
    ...receiptFor(hubRoot, identity, "cleanup-successor-new"),
    generation: "cleanup-successor-new-generation",
  };
  await writeLockReceipt(hubRoot, original);
  let quarantinePath = "";

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, original, {
      hooks: {
        afterLockQuarantined: async (context) => {
          quarantinePath = context.quarantinePath;
          await writeLockReceipt(hubRoot, successor);
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: { canonical?: string; quarantine?: string };
    }) => error.code === "QUOTA_DELEGATE_LOCK_SUCCESSOR_PRESERVED"
      && error.committed === true
      && error.quarantinePreserved === true
      && error.successorPreserved === true
      && error.recoveryPaths?.canonical === lockPath(hubRoot)
      && error.recoveryPaths.quarantine === quarantinePath,
  );

  assert.equal((await readQuotaDelegateLockReceipt(hubRoot))?.generation, successor.generation);
  assert.equal(JSON.parse(await readFile(quarantinePath, "utf8")).generation, original.generation);
  await rm(quarantinePath, { force: true });
  await cleanupQuotaDelegateLock(hubRoot, successor);
});

test("quota delegate cleanup preserves a same-owner quarantine generation ABA", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-quarantine-aba-"));
  const original = receiptFor(hubRoot, currentIdentity(), "cleanup-quarantine-aba");
  await writeLockReceipt(hubRoot, original);
  let quarantinePath = "";

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, original, {
      hooks: {
        afterLockQuarantined: async (context) => {
          quarantinePath = context.quarantinePath;
          await writeFile(quarantinePath, JSON.stringify(original, null, 2) + "\n", "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      successorPreserved?: boolean;
      recoveryPaths?: { canonical?: string; quarantine?: string };
    }) => error.code === "QUOTA_DELEGATE_LOCK_RACE"
      && error.committed === true
      && error.quarantinePreserved === true
      && error.successorPreserved === false
      && error.recoveryPaths?.canonical === lockPath(hubRoot)
      && error.recoveryPaths.quarantine === quarantinePath,
  );

  assert.equal(JSON.parse(await readFile(quarantinePath, "utf8")).generation, original.generation);
  assert.equal(await readQuotaDelegateLockReceipt(hubRoot), null);
  await rm(quarantinePath, { force: true });
});

test("quota delegate cleanup preserves a post-validation quarantine successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-post-validation-aba-"));
  const original = receiptFor(hubRoot, currentIdentity(), "cleanup-post-validation-owner");
  await writeLockReceipt(hubRoot, original);
  let quarantinePath = "";
  const successor = `${JSON.stringify({ ...original, marker: "post-validation-successor" }, null, 2)}\n`;

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, original, {
      hooks: {
        afterQuarantinedLockValidated: async (context) => {
          quarantinePath = context.quarantinePath;
          await rm(quarantinePath);
          await writeFile(quarantinePath, successor, "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      quarantinePreserved?: boolean;
      recoveryPaths?: { quarantine?: string };
    }) => error.code === "QUOTA_DELEGATE_LOCK_RACE"
      && error.committed === true
      && error.quarantinePreserved === true
      && error.recoveryPaths?.quarantine === quarantinePath,
  );

  assert.equal(await readFile(quarantinePath, "utf8"), successor);
  await rm(quarantinePath, { force: true });
});

test("quota delegate cleanup preserves committed quarantine when directory fsync fails", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-cleanup-fsync-"));
  const receipt = receiptFor(hubRoot, currentIdentity(), "cleanup-fsync-owner");
  await writeLockReceipt(hubRoot, receipt);

  await assert.rejects(
    cleanupQuotaDelegateLock(hubRoot, receipt, {
      hooks: {
        syncQuarantineDirectory: async ({ phase }) => {
          if (phase === "post-rename") {
            throw Object.assign(new Error("directory fsync unsupported"), { code: "ENOTSUP" });
          }
        },
      },
    }),
    (error: NodeJS.ErrnoException & {
      committed?: boolean;
      removalCommitted?: boolean;
      quarantinePreserved?: boolean;
      recoveryPaths?: { canonical?: string; quarantine?: string };
    }) => error.code === "QUOTA_DELEGATE_LOCK_QUARANTINE_DURABILITY_AMBIGUOUS"
      && error.committed === true
      && error.removalCommitted === false
      && error.quarantinePreserved === true
      && error.recoveryPaths?.canonical === lockPath(hubRoot)
      && typeof error.recoveryPaths.quarantine === "string",
  );

  assert.equal(await readQuotaDelegateLockReceipt(hubRoot), null);
});

test("waitForDelegateIncarnation binds readiness to a specific spawned incarnation", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-ready-"));
  const identity = currentIdentity();
  const receipt = receiptFor(hubRoot, identity, "ready-token");
  await writeLockReceipt(hubRoot, receipt);

  const ready = await waitForDelegateIncarnation(hubRoot, identity, 100);
  assert.equal(ready?.ownerToken, "ready-token");

  const wrongIdentity = {
    ...identity,
    birthId: `${identity.birthId}:wrong`,
    incarnation: `${identity.pid}:${identity.birthId}:wrong`,
  };
  assert.equal(await waitForDelegateIncarnation(hubRoot, wrongIdentity, 50), null);
});

test("quota delegate atomically publishes malformed-command failures before deletion", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-malformed-"));
  const commandId = "malformed-command";
  const commandPath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(commandPath, "{not-json\n", "utf8");
  const ackReady = deferred();
  const publishAck = deferred();
  const processing = processQuotaDelegateInbox(hubRoot, {
    hooks: {
      beforeAckPublish: async ({ ackPath, tempPath }) => {
        await assert.rejects(readFile(ackPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
        assert.match(await readFile(tempPath, "utf8"), /QUOTA_DELEGATE_COMMAND_MALFORMED/);
        ackReady.resolve();
        await publishAck.promise;
      },
    },
  });
  await ackReady.promise;
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), true);
  publishAck.resolve();
  await processing;

  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "QUOTA_DELEGATE_COMMAND_MALFORMED");
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), false);
});

test("quota delegate terminalizes invalid command-local payloads without blocking sorted inbox", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-invalid-payload-"));
  const invalidCommandId = "000-invalid-payload";
  const validCommandId = "001-valid-usage";
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(path.join(inboxPath(hubRoot), `${invalidCommandId}.json`), JSON.stringify({
    commandId: invalidCommandId,
    mutationId: invalidCommandId,
    type: "usage_write",
    record: {
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
    },
  }) + "\n", "utf8");
  await appendCommand(hubRoot, {
    commandId: validCommandId,
    mutationId: validCommandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  await processQuotaDelegateInbox(hubRoot);

  const invalidAck = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${invalidCommandId}.json`), "utf8"));
  assert.equal(invalidAck.ok, false);
  assert.equal(invalidAck.code, "QUOTA_DELEGATE_COMMAND_INVALID");
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${invalidCommandId}.json`), false);
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${validCommandId}.json`), false);
  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].mutationId, validCommandId);
  await assert.rejects(
    readFile(transactionPath(hubRoot, invalidCommandId), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});

test("quota delegate client reports committed command durability ambiguity and leaves recoverable command", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-client-ambiguous-"));
  const commandId = "client-committed-ambiguous";
  type AmbiguousCommandError = Error & {
    code?: string;
    committed?: boolean;
    committedPath?: string;
    commandId?: string;
    mutationId?: string;
    commandDigest?: string;
    primaryError?: NodeJS.ErrnoException;
  };
  const thrown: AmbiguousCommandError[] = [];

  try {
    await withQuotaDelegateClientPersistenceHooksForTests({
      afterRename: () => {
        throw Object.assign(new Error("directory fsync denied after committed command rename"), { code: "EIO" });
      },
    }, async () => {
      await appendCommand(hubRoot, {
        commandId,
        mutationId: commandId,
        type: "usage_write",
        record: {
          providerKey: "claude:glm",
          agent: "claude-glm",
          phase: "execute",
          status: "ok",
          phaseStatus: "completed",
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });
  } catch (error) {
    thrown.push(error as AmbiguousCommandError);
  }

  assert.equal(thrown.length, 1);
  const ambiguity = thrown[0];
  assert.equal(ambiguity.code, "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS");
  assert.equal(ambiguity.committed, true);
  assert.equal(ambiguity.commandId, commandId);
  assert.equal(ambiguity.mutationId, commandId);
  assert.equal(ambiguity.primaryError?.code, "EIO");
  assert.equal(ambiguity.committedPath, path.join(inboxPath(hubRoot), `${commandId}.json`));
  const raw = await readFile(ambiguity.committedPath!, "utf8");
  assert.equal(ambiguity.commandDigest, digestRaw(raw));

  await processQuotaDelegateInbox(hubRoot);
  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].mutationId, commandId);
  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, true);
});

test("quota delegate preserves a command when ack publication fails and replays without duplicating usage", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-ack-replay-"));
  const commandId = "usage-replay-command";
  await appendCommand(hubRoot, {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  await mkdir(path.dirname(acksPath(hubRoot)), { recursive: true });
  await writeFile(acksPath(hubRoot), "blocks ack directory\n", "utf8");

  await assert.rejects(processQuotaDelegateInbox(hubRoot));
  assert.equal((await readProviderUsage(hubRoot)).length, 1);
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), true);

  await rm(acksPath(hubRoot));
  await processQuotaDelegateInbox(hubRoot);
  assert.equal((await readProviderUsage(hubRoot)).length, 1);
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), false);
  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, true);
  assert.equal(ack.mutationId, commandId);
});

test("quota delegate reconciles an executing usage transaction from durable evidence", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-usage-reconcile-"));
  const commandId = "usage-executing-reconcile";
  const command = {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  await appendCommand(hubRoot, command);
  const commandPath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const raw = await readFile(commandPath, "utf8");
  const digest = digestRaw(raw);
  await _internalAppendUsageLine(hubRoot, {
    ...command.record,
    mutationId: commandId,
    commandDigest: digest,
  });
  await mkdir(path.dirname(transactionPath(hubRoot, commandId)), { recursive: true });
  await writeFile(transactionPath(hubRoot, commandId), JSON.stringify({
    version: 1,
    hubRoot,
    commandId,
    mutationId: commandId,
    commandDigest: digest,
    state: "executing",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ack: null,
  }, null, 2) + "\n", "utf8");

  await processQuotaDelegateInbox(hubRoot);

  assert.equal((await readProviderUsage(hubRoot)).length, 1);
  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, true);
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), false);
  const transaction = JSON.parse(await readFile(transactionPath(hubRoot, commandId), "utf8"));
  assert.equal(transaction.state, "applied");
});

test("quota delegate safely replays an executing usage transaction with no applied evidence", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-usage-replay-"));
  const commandId = "usage-executing-replay";
  const command = {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  await appendCommand(hubRoot, command);
  const raw = await readFile(path.join(inboxPath(hubRoot), `${commandId}.json`), "utf8");
  await mkdir(path.dirname(transactionPath(hubRoot, commandId)), { recursive: true });
  await writeFile(transactionPath(hubRoot, commandId), JSON.stringify({
    version: 1,
    hubRoot,
    commandId,
    mutationId: commandId,
    commandDigest: digestRaw(raw),
    state: "executing",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ack: null,
  }, null, 2) + "\n", "utf8");

  await processQuotaDelegateInbox(hubRoot);
  await processQuotaDelegateInbox(hubRoot);

  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].mutationId, commandId);
});

test("quota delegate reconciles an executing quota transaction from durable evidence", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-quota-reconcile-"));
  const commandId = "quota-executing-reconcile";
  const command = {
    commandId,
    mutationId: commandId,
    type: "quota_write",
    providerKey: "claude:glm",
    entry: {
      agent: "claude-glm",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() + 60_000,
      source: "unit-test",
      confidence: 1,
      reason: "429",
    },
  };
  await appendCommand(hubRoot, command);
  const raw = await readFile(path.join(inboxPath(hubRoot), `${commandId}.json`), "utf8");
  const digest = digestRaw(raw);
  await mkdir(path.join(hubRoot, "providers"), { recursive: true });
  await writeFile(path.join(hubRoot, "providers", "quotas.json"), JSON.stringify({
    "claude:glm": {
      providerKey: "claude:glm",
      ...command.entry,
      variant: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      mutationId: commandId,
      commandDigest: digest,
    },
  }, null, 2) + "\n", "utf8");
  await mkdir(path.dirname(transactionPath(hubRoot, commandId)), { recursive: true });
  await writeFile(transactionPath(hubRoot, commandId), JSON.stringify({
    version: 1,
    hubRoot,
    commandId,
    mutationId: commandId,
    commandDigest: digest,
    state: "executing",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ack: null,
  }, null, 2) + "\n", "utf8");

  await processQuotaDelegateInbox(hubRoot);

  const quotas = await readProviderQuotas(hubRoot);
  assert.equal(quotas["claude:glm"].mutationId, commandId);
  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, true);
  assert.equal(ack.entry.mutationId, commandId);
});

test("quota delegate leaves quota transaction executing on committed durability ambiguity and reconciles next pass", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-quota-ambiguous-"));
  const commandId = "quota-committed-ambiguous";
  await appendCommand(hubRoot, {
    commandId,
    mutationId: commandId,
    type: "quota_write",
    providerKey: "claude:glm",
    entry: {
      agent: "claude-glm",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() + 60_000,
      source: "unit-test",
      confidence: 1,
      reason: "429",
    },
  });
  await withProviderQuotaPersistenceHooksForTests({
    afterRename: () => {
      throw Object.assign(new Error("directory fsync denied after committed rename"), { code: "EIO" });
    },
  }, async () => {
    await assert.rejects(
      processQuotaDelegateInbox(hubRoot),
      (error: NodeJS.ErrnoException) => error.code === "PROVIDER_QUOTA_WRITE_COMMITTED_DURABILITY_AMBIGUOUS",
    );
  });

  await assert.rejects(
    readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), true);
  assert.equal(JSON.parse(await readFile(transactionPath(hubRoot, commandId), "utf8")).state, "executing");
  assert.equal((await readProviderQuotas(hubRoot))["claude:glm"].mutationId, commandId);

  await processQuotaDelegateInbox(hubRoot);
  assert.equal(JSON.parse(await readFile(transactionPath(hubRoot, commandId), "utf8")).state, "applied");
  const ack = JSON.parse(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, true);
});

test("quota delegate preserves usage command when existing provider usage state is corrupt", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-usage-corrupt-"));
  const commandId = "usage-corrupt-store";
  const usagePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(path.dirname(usagePath), { recursive: true });
  await writeFile(usagePath, "{\"providerKey\":\"claude:glm\"\n", "utf8");
  await appendCommand(hubRoot, {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  });

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "PROVIDER_USAGE_CONTRACT_INVALID",
  );

  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), true);
  await assert.rejects(
    readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const transaction = JSON.parse(await readFile(transactionPath(hubRoot, commandId), "utf8"));
  assert.equal(transaction.state, "executing");
  assert.equal(transaction.ack, null);
  assert.equal(await readFile(usagePath, "utf8"), "{\"providerKey\":\"claude:glm\"\n");
});

test("quota delegate preserves quota command when existing provider quota state is corrupt", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-quota-corrupt-"));
  const commandId = "quota-corrupt-store";
  const quotasPath = path.join(hubRoot, "providers", "quotas.json");
  const corruptContent = JSON.stringify({
    "claude:existing": {
      providerKey: "claude:existing",
      agent: "claude",
      status: "not-a-valid-quota-status",
    },
  }, null, 2) + "\n";
  await mkdir(path.dirname(quotasPath), { recursive: true });
  await writeFile(quotasPath, corruptContent, "utf8");
  await appendCommand(hubRoot, {
    commandId,
    mutationId: commandId,
    type: "quota_write",
    providerKey: "claude:glm",
    entry: {
      agent: "claude-glm",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() + 60_000,
      source: "unit-test",
      confidence: 1,
      reason: "429",
    },
  });

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot),
    (error: NodeJS.ErrnoException) => error.code === "PROVIDER_QUOTA_ENTRY_CONTRACT_INVALID",
  );

  assert.equal((await readdir(inboxPath(hubRoot))).includes(`${commandId}.json`), true);
  await assert.rejects(
    readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
  const transaction = JSON.parse(await readFile(transactionPath(hubRoot, commandId), "utf8"));
  assert.equal(transaction.state, "executing");
  assert.equal(transaction.ack, null);
  assert.equal(await readFile(quotasPath, "utf8"), corruptContent);
});

test("provider usage rejects partial JSONL tails without appending or truncating", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-usage-partial-tail-"));
  const usagePath = path.join(hubRoot, "providers", "usage.jsonl");
  const validLine = JSON.stringify({
    providerKey: "claude:glm",
    agent: "claude-glm",
    phase: "execute",
    status: "ok",
    phaseStatus: "completed",
  }) + "\n";
  const corruptContent = `${validLine}{"providerKey":"claude:glm"`;
  await mkdir(path.dirname(usagePath), { recursive: true });
  await writeFile(usagePath, corruptContent, "utf8");

  await assert.rejects(
    _internalAppendUsageLine(hubRoot, {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "verify",
      status: "ok",
      phaseStatus: "completed",
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROVIDER_USAGE_CONTRACT_INVALID",
  );
  assert.equal(await readFile(usagePath, "utf8"), corruptContent);
});

test("provider usage rejects same mutationId with a different command digest", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-usage-digest-conflict-"));
  await _internalAppendUsageLine(hubRoot, {
    providerKey: "claude:glm",
    agent: "claude-glm",
    phase: "execute",
    status: "ok",
    phaseStatus: "completed",
    mutationId: "mutation-1",
    commandDigest: "a".repeat(64),
  });

  await assert.rejects(
    _internalAppendUsageLine(hubRoot, {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
      mutationId: "mutation-1",
      commandDigest: "b".repeat(64),
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROVIDER_USAGE_CONTRACT_INVALID",
  );
  assert.equal((await readProviderUsage(hubRoot)).length, 1);
});

test("provider usage append does not truncate when append fails for non-missing files", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-provider-usage-append-fail-"));
  const usagePath = path.join(hubRoot, "providers", "usage.jsonl");
  await mkdir(usagePath, { recursive: true });

  await assert.rejects(
    _internalAppendUsageLine(hubRoot, {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "execute",
      status: "ok",
      phaseStatus: "completed",
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROVIDER_USAGE_CONTRACT_INVALID",
  );
  assert.equal((await lstat(usagePath)).isDirectory(), true);
});

test("quota delegate surfaces inbox and command-removal filesystem failures", async () => {
  const badInboxRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-bad-inbox-"));
  await mkdir(path.dirname(inboxPath(badInboxRoot)), { recursive: true });
  await writeFile(inboxPath(badInboxRoot), "not a directory\n", "utf8");
  await assert.rejects(processQuotaDelegateInbox(badInboxRoot));

  const removeRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-remove-error-"));
  const commandId = "remove-error-command";
  const commandPath = path.join(inboxPath(removeRoot), `${commandId}.json`);
  await mkdir(inboxPath(removeRoot), { recursive: true });
  await writeFile(commandPath, "{malformed\n", "utf8");
  await assert.rejects(
    processQuotaDelegateInbox(removeRoot, {
      hooks: {
        beforeCommandRemoval: async ({ filePath }) => {
          await rm(filePath);
          await mkdir(filePath);
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_COMMAND_RACE",
  );
  const ack = JSON.parse(await readFile(path.join(acksPath(removeRoot), `${commandId}.json`), "utf8"));
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "QUOTA_DELEGATE_COMMAND_MALFORMED");
});

test("quota delegate defers hard-link publications until the command inode is stable", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-command-publication-"));
  const commandId = "command-publication-in-progress";
  const filePath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const publisherPath = `${filePath}.publisher-link`;
  const ackPath = path.join(acksPath(hubRoot), `${commandId}.json`);
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(filePath, "{malformed\n", "utf8");
  await link(filePath, publisherPath);
  assert.equal((await stat(filePath)).nlink, 2);

  await processQuotaDelegateInbox(hubRoot);

  assert.equal(await readFile(filePath, "utf8"), "{malformed\n");
  await assert.rejects(readFile(ackPath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await rm(publisherPath);
  assert.equal((await stat(filePath)).nlink, 1);
  await processQuotaDelegateInbox(hubRoot);

  const ack = JSON.parse(await readFile(ackPath, "utf8"));
  assert.equal(ack.ok, false);
  assert.equal(ack.code, "QUOTA_DELEGATE_COMMAND_MALFORMED");
  await assert.rejects(readFile(filePath, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("quota delegate command removal preserves a successor installed after the pinned read", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-command-successor-"));
  const commandId = "command-successor-race";
  const filePath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const retiredPath = `${filePath}.retired-owner`;
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(filePath, "{malformed\n", "utf8");
  const successor = `${JSON.stringify({
    commandId,
    mutationId: `${commandId}-successor`,
    type: "usage_write",
    record: {
      providerKey: "claude:glm",
      agent: "claude-glm",
      phase: "verify",
      status: "ok",
      phaseStatus: "completed",
      recordedAt: "2026-07-21T00:00:00.000Z",
    },
  })}\n`;

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot, {
      hooks: {
        beforeCommandRemoval: async () => {
          await rename(filePath, retiredPath);
          await writeFile(filePath, successor, "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_COMMAND_RACE",
  );
  assert.equal(await readFile(filePath, "utf8"), successor);
  assert.equal(await readFile(retiredPath, "utf8"), "{malformed\n");
});

test("quota delegate command removal detects a same-inode ctime mutation", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-command-ctime-"));
  const commandId = "command-ctime-race";
  const filePath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(filePath, "{malformed\n", "utf8");

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot, {
      hooks: {
        beforeCommandRemoval: async () => {
          const before = await stat(filePath);
          const mode = before.mode & 0o777;
          await chmod(filePath, mode ^ 0o040);
          await chmod(filePath, mode);
          assert.notEqual((await stat(filePath)).ctimeMs, before.ctimeMs);
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_COMMAND_RACE",
  );
  assert.equal(await readFile(filePath, "utf8"), "{malformed\n");
});

test("quota delegate ack publication never overwrites a hook-installed successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-ack-successor-"));
  const commandId = "ack-successor-race";
  const commandPath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const successorAck = `${JSON.stringify({ marker: "ack-successor-must-survive" })}\n`;
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(commandPath, "{malformed\n", "utf8");

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot, {
      hooks: {
        beforeAckPublish: async ({ ackPath }) => {
          await writeFile(ackPath, successorAck, "utf8");
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_ATOMIC_PUBLISH_CONFLICT",
  );
  assert.equal(await readFile(path.join(acksPath(hubRoot), `${commandId}.json`), "utf8"), successorAck);
  assert.equal(await readFile(commandPath, "utf8"), "{malformed\n");
});

test("quota delegate atomic temp cleanup preserves a same-path successor", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-atomic-temp-successor-"));
  const commandId = "atomic-temp-successor";
  const commandPath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const successor = "atomic-temp-successor-must-survive\n";
  let tempPath = "";
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(commandPath, "{malformed\n", "utf8");

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot, {
      hooks: {
        beforeAckPublish: async ({ tempPath: observedTempPath }) => {
          tempPath = observedTempPath;
          await rename(tempPath, `${tempPath}.retired-owner`);
          await writeFile(tempPath, successor, "utf8");
          throw Object.assign(new Error("stop publication after temp replacement"), { code: "EIO" });
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "EIO",
  );
  assert.equal(await readFile(tempPath, "utf8"), successor);
  assert.equal(await readFile(commandPath, "utf8"), "{malformed\n");
});

test("quota delegate directory sync rejects a symlink replacement", async () => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-sync-symlink-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-sync-target-"));
  const commandId = "sync-symlink-race";
  const filePath = path.join(inboxPath(hubRoot), `${commandId}.json`);
  const retiredInbox = `${inboxPath(hubRoot)}.retired`;
  await mkdir(inboxPath(hubRoot), { recursive: true });
  await writeFile(filePath, "{malformed\n", "utf8");

  await assert.rejects(
    processQuotaDelegateInbox(hubRoot, {
      hooks: {
        syncCommandRemovalDirectory: async () => {
          await rename(inboxPath(hubRoot), retiredInbox);
          await symlink(external, inboxPath(hubRoot), "dir");
        },
      },
    }),
    (error: NodeJS.ErrnoException) => error.code === "QUOTA_DELEGATE_COMMAND_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
  );
  assert.deepEqual(await readdir(external), []);
});
