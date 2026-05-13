import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";

const ownedLeaseTokens = new Map();
const DEFAULT_LOCK_TTL_MS = 30_000;

function validateLeaseId(leaseId) {
  if (
    typeof leaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(leaseId)
  ) {
    throw new Error("invalid leaseId");
  }
}

function leaseFileFor(flowRoot, leaseId) {
  validateLeaseId(leaseId);

  const leasesRoot = runtimeDataPath(flowRoot, "leases");
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

function tokenKey(flowRoot, leaseId) {
  return `${path.resolve(flowRoot)}\0${leaseId}`;
}

function rememberOwnerToken(flowRoot, leaseId, ownerToken) {
  ownedLeaseTokens.set(tokenKey(flowRoot, leaseId), ownerToken);
}

function forgetOwnerToken(flowRoot, leaseId, ownerToken) {
  const key = tokenKey(flowRoot, leaseId);
  if (ownedLeaseTokens.get(key) === ownerToken) {
    ownedLeaseTokens.delete(key);
  }
}

function ownerTokenFor(flowRoot, leaseId, suppliedToken) {
  return suppliedToken ?? ownedLeaseTokens.get(tokenKey(flowRoot, leaseId));
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

  const fromEnv = Number.parseInt(process.env.FLOW_LEASE_LOCK_TTL_MS ?? "", 10);
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
  flowRoot,
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
  const file = leaseFileFor(flowRoot, leaseId);
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
    rememberOwnerToken(flowRoot, leaseId, lease.ownerToken);
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
      rememberOwnerToken(flowRoot, leaseId, lease.ownerToken);
      return lease;
    },
    { lockTtlMs }
  );
}

export async function readLease(flowRoot, leaseId) {
  return await readLeaseFile(leaseFileFor(flowRoot, leaseId));
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
  flowRoot,
  leaseId,
  { ttlMs, now = new Date(), ownerToken, lockTtlMs } = {}
) {
  const file = leaseFileFor(flowRoot, leaseId);
  return await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        throw new Error(`lease not found: ${leaseId}`);
      }

      const effectiveOwnerToken = ownerTokenFor(flowRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      const renewed = {
        ...existing,
        heartbeatAt: now.toISOString(),
        expiresAt: expiresAtFor(now, ttlMs),
      };

      await atomicWriteJson(file, renewed);
      rememberOwnerToken(flowRoot, leaseId, renewed.ownerToken);
      return renewed;
    },
    { lockTtlMs }
  );
}

export async function releaseLease(
  flowRoot,
  leaseId,
  { ownerToken, lockTtlMs } = {}
) {
  const file = leaseFileFor(flowRoot, leaseId);

  await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        return;
      }

      const effectiveOwnerToken = ownerTokenFor(flowRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      await rm(file);
      forgetOwnerToken(flowRoot, leaseId, existing.ownerToken);
    },
    { lockTtlMs }
  );
}
