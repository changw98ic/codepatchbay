import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import {
  acquireLease as acquireLeaseRust,
  readLease as readLeaseRust,
  releaseLease as releaseLeaseRust,
  renewLease as renewLeaseRust,
  shouldUseRustRuntime,
} from "./runtime-cli.js";

const ownedLeaseTokens = new Map();
// Lock TTL: timeout for mkdir-based atomic lock contention between competing processes.
// This is NOT the phase lease TTL (see CPB_LEASE_TTL_MS in job-runner.mjs / run-pipeline.mjs).
const DEFAULT_LOCK_TTL_MS = 30_000;

function validateLeaseId(leaseId) {
  if (
    typeof leaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(leaseId)
  ) {
    throw new Error("invalid leaseId");
  }
}

function leaseFileFor(cpbRoot, leaseId) {
  validateLeaseId(leaseId);

  const leasesRoot = runtimeDataPath(cpbRoot, "leases");
  const file = path.resolve(leasesRoot, `${leaseId}.json`);
  const relative = path.relative(leasesRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lease file resolves outside leases root");
  }

  return file;
}

function expiresAtFor(now, ttlMs) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function tokenKey(cpbRoot, leaseId) {
  return `${path.resolve(cpbRoot)}\0${leaseId}`;
}

function rememberOwnerToken(cpbRoot, leaseId, ownerToken) {
  ownedLeaseTokens.set(tokenKey(cpbRoot, leaseId), ownerToken);
}

function forgetOwnerToken(cpbRoot, leaseId, ownerToken) {
  const key = tokenKey(cpbRoot, leaseId);
  if (ownedLeaseTokens.get(key) === ownerToken) {
    ownedLeaseTokens.delete(key);
  }
}

function ownerTokenFor(cpbRoot, leaseId, suppliedToken) {
  return suppliedToken ?? ownedLeaseTokens.get(tokenKey(cpbRoot, leaseId));
}

function assertLeaseOwner(lease, ownerToken) {
  if (lease.ownerToken !== undefined && lease.ownerToken !== ownerToken) {
    throw new Error("lease owner mismatch");
  }
}

async function atomicWriteJson(file, value) {
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );

  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

async function readLeaseFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function lockTtlMsFor(lockTtlMs) {
  if (lockTtlMs !== undefined) {
    return lockTtlMs;
  }

  const fromEnv = Number.parseInt(process.env.CPB_LEASE_LOCK_TTL_MS ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LOCK_TTL_MS;
}

async function isLockStale(lockDir, lockTtlMs) {
  const nowMs = Date.now();

  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    const acquiredAtMs = new Date(lock.acquiredAt).getTime();
    return Number.isNaN(acquiredAtMs) || nowMs - acquiredAtMs >= lockTtlMs;
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      return true;
    }
  }

  try {
    const lockStat = await stat(lockDir);
    return nowMs - lockStat.mtimeMs >= lockTtlMs;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    return true;
  }
}

async function writeLockMetadata(lockDir) {
  await writeFile(
    path.join(lockDir, "lock.json"),
    `${JSON.stringify(
      {
        acquiredAt: new Date().toISOString(),
        ownerPid: process.pid,
        ownerHost: hostname(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function withLeaseLock(file, callback, { lockTtlMs } = {}) {
  const lockDir = `${file}.lock`;
  let acquired = false;
  const effectiveLockTtlMs = lockTtlMsFor(lockTtlMs);

  await mkdir(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeLockMetadata(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }

      if (await isLockStale(lockDir, effectiveLockTtlMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) {
    throw new Error(`lease lock busy: ${path.basename(file)}`);
  }

  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function createLease({
  leaseId,
  jobId,
  phase,
  ttlMs,
  now,
  ownerPid,
  ownerToken = randomUUID(),
}) {
  const timestamp = now.toISOString();
  return {
    leaseId,
    jobId,
    phase,
    ownerPid,
    ownerHost: hostname(),
    ownerToken,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: expiresAtFor(now, ttlMs),
  };
}

export async function acquireLease(
  cpbRoot,
  {
    leaseId,
    jobId,
    phase,
    ttlMs,
    now = new Date(),
    ownerPid = process.pid,
    lockTtlMs,
  }
) {
  if (shouldUseRustRuntime()) {
    const result = await acquireLeaseRust(cpbRoot, { leaseId, jobId, phase, ttlMs, ownerPid });
    if (result?.acquired === false) {
      const err = new Error(`lease already exists: ${leaseId}`);
      err.code = "EEXIST";
      throw err;
    }
    rememberOwnerToken(cpbRoot, leaseId, result.lease.ownerToken);
    return result.lease;
  }

  const file = leaseFileFor(cpbRoot, leaseId);
  const lease = createLease({
    leaseId,
    jobId,
    phase,
    ttlMs,
    now,
    ownerPid,
  });

  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, `${JSON.stringify(lease, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    rememberOwnerToken(cpbRoot, leaseId, lease.ownerToken);
    return lease;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }

  return await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing !== null && !isLeaseStale(existing, now)) {
        const err = new Error(`lease already exists: ${leaseId}`);
        err.code = "EEXIST";
        throw err;
      }

      await atomicWriteJson(file, lease);
      rememberOwnerToken(cpbRoot, leaseId, lease.ownerToken);
      return lease;
    },
    { lockTtlMs }
  );
}

export async function readLease(cpbRoot, leaseId) {
  if (shouldUseRustRuntime()) {
    const lease = await readLeaseRust(cpbRoot, leaseId);
    return lease ?? null;
  }
  return await readLeaseFile(leaseFileFor(cpbRoot, leaseId));
}

export function isLeaseStale(lease, now = new Date()) {
  if (
    lease === null ||
    typeof lease !== "object" ||
    typeof lease.expiresAt !== "string"
  ) {
    throw new Error("invalid lease");
  }

  const expiresAtMs = new Date(lease.expiresAt).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }

  return expiresAtMs <= now.getTime();
}

export async function renewLease(
  cpbRoot,
  leaseId,
  { ttlMs, now = new Date(), ownerToken, lockTtlMs } = {}
) {
  if (shouldUseRustRuntime()) {
    const renewed = await renewLeaseRust(cpbRoot, leaseId, { ttlMs, ownerToken: ownerTokenFor(cpbRoot, leaseId, ownerToken) });
    rememberOwnerToken(cpbRoot, leaseId, renewed.ownerToken);
    return renewed;
  }

  const file = leaseFileFor(cpbRoot, leaseId);
  return await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        throw new Error(`lease not found: ${leaseId}`);
      }

      const effectiveOwnerToken = ownerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      const renewed = {
        ...existing,
        heartbeatAt: now.toISOString(),
        expiresAt: expiresAtFor(now, ttlMs),
      };

      await atomicWriteJson(file, renewed);
      rememberOwnerToken(cpbRoot, leaseId, renewed.ownerToken);
      return renewed;
    },
    { lockTtlMs }
  );
}

export async function releaseLease(
  cpbRoot,
  leaseId,
  { ownerToken, lockTtlMs } = {}
) {
  if (shouldUseRustRuntime()) {
    const effectiveOwnerToken = ownerTokenFor(cpbRoot, leaseId, ownerToken);
    await releaseLeaseRust(cpbRoot, leaseId, { ownerToken: effectiveOwnerToken });
    forgetOwnerToken(cpbRoot, leaseId, effectiveOwnerToken);
    return;
  }

  const file = leaseFileFor(cpbRoot, leaseId);

  await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        return;
      }

      const effectiveOwnerToken = ownerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      await rm(file);
      forgetOwnerToken(cpbRoot, leaseId, existing.ownerToken);
    },
    { lockTtlMs }
  );
}
