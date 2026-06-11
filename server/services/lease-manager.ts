import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";

export const LEASE_FORMAT_VERSION = 1;
type AnyRecord = Record<string, any>;

function _base(cpbRoot: string, opts: AnyRecord = {}) {
  if (opts?.dataRoot) return path.resolve(opts.dataRoot);
  if (opts?.includeLegacyFallback === true) return path.join(path.resolve(cpbRoot), "cpb-task");
  throw new Error("project runtime root required for lease storage");
}

const ownedLeaseTokens = new Map<string, string>();
// Lock TTL: timeout for mkdir-based atomic lock contention between competing processes.
// This is not the worker lease heartbeat TTL.
const DEFAULT_LOCK_TTL_MS = 30_000;

function validateLeaseId(leaseId: any) {
  if (
    typeof leaseId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(leaseId)
  ) {
    throw new Error("invalid leaseId");
  }
}

function leaseFileFor(cpbRoot: string, leaseId: string, opts: AnyRecord = {}) {
  validateLeaseId(leaseId);

  const leasesRoot = path.join(_base(cpbRoot, opts), "leases");
  const file = path.resolve(leasesRoot, `${leaseId}.json`);
  const relative = path.relative(leasesRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("lease file resolves outside leases root");
  }

  return file;
}

function expiresAtFor(now: Date, ttlMs: number) {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function tokenKey(cpbRoot: string, leaseId: string) {
  return `${path.resolve(cpbRoot)}\0${leaseId}`;
}

function rememberOwnerToken(cpbRoot: string, leaseId: string, ownerToken: string) {
  ownedLeaseTokens.set(tokenKey(cpbRoot, leaseId), ownerToken);
}

function forgetOwnerToken(cpbRoot: string, leaseId: string, ownerToken: string) {
  const key = tokenKey(cpbRoot, leaseId);
  if (ownedLeaseTokens.get(key) === ownerToken) {
    ownedLeaseTokens.delete(key);
  }
}

function ownerTokenFor(cpbRoot: string, leaseId: string, suppliedToken: any) {
  return suppliedToken ?? ownedLeaseTokens.get(tokenKey(cpbRoot, leaseId));
}

function assertLeaseOwner(lease: AnyRecord, ownerToken: any) {
  if (lease.ownerToken !== undefined && lease.ownerToken !== ownerToken) {
    throw new Error("lease owner mismatch");
  }
}

async function atomicWriteJson(file: string, value: any) {
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`
  );

  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

async function readLeaseFile(file: string): Promise<AnyRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function lockTtlMsFor(lockTtlMs: any): number {
  if (lockTtlMs !== undefined) {
    return lockTtlMs;
  }

  const fromEnv = Number.parseInt(process.env.CPB_LEASE_LOCK_TTL_MS ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_LOCK_TTL_MS;
}

async function isLockStale(lockDir: string, lockTtlMs: number) {
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

async function writeLockMetadata(lockDir: string) {
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

async function acquireLeaseFileLock(file: string, { lockTtlMs }: AnyRecord = {}) {
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

  return async () => {
    await rm(lockDir, { recursive: true, force: true });
  };
}

async function withLeaseLock(file: string, callback: () => Promise<any>, { lockTtlMs }: AnyRecord = {}) {
  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    return await callback();
  } finally {
    await releaseLock();
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
}: AnyRecord) {
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
  cpbRoot: string,
  {
    leaseId,
    jobId,
    phase,
    ttlMs,
    now = new Date(),
    ownerPid = process.pid,
    lockTtlMs,
    dataRoot,
    includeLegacyFallback,
  }: AnyRecord
) {
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
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

  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    const existing = await readLeaseFile(file);
    if (existing !== null && !isLeaseStale(existing, now)) {
      const err: any = new Error(`lease already exists: ${leaseId}`);
      err.code = "EEXIST";
      throw err;
    }

    await atomicWriteJson(file, lease);
    rememberOwnerToken(cpbRoot, leaseId, lease.ownerToken);
    return lease;
  } finally {
    await releaseLock();
  }
}

export async function readLease(cpbRoot: string, leaseId: string, { dataRoot, includeLegacyFallback }: AnyRecord = {}) {
  return await readLeaseFile(leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback }));
}

export function isLeaseStale(lease: AnyRecord | null, now = new Date()) {
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
  cpbRoot: string,
  leaseId: string,
  { ttlMs, now = new Date(), ownerToken, lockTtlMs, dataRoot, includeLegacyFallback }: AnyRecord = {}
) {
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });
  return await withLeaseLock(
    file,
    async () => {
      const existing = await readLeaseFile(file);
      if (existing === null) {
        throw new Error(`lease not found: ${leaseId}`);
      }

      const effectiveOwnerToken = ownerTokenFor(cpbRoot, leaseId, ownerToken);
      assertLeaseOwner(existing, effectiveOwnerToken);

      const renewed: AnyRecord = {
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
  cpbRoot: string,
  leaseId: string,
  { ownerToken, lockTtlMs, dataRoot, includeLegacyFallback }: AnyRecord = {}
) {
  const file = leaseFileFor(cpbRoot, leaseId, { dataRoot, includeLegacyFallback });

  const releaseLock = await acquireLeaseFileLock(file, { lockTtlMs });
  try {
    const existing = await readLeaseFile(file);
    if (existing === null) {
      return;
    }

    const effectiveOwnerToken = ownerTokenFor(cpbRoot, leaseId, ownerToken);
    assertLeaseOwner(existing, effectiveOwnerToken);

    await rm(file);
    forgetOwnerToken(cpbRoot, leaseId, existing.ownerToken);
  } finally {
    await releaseLock();
  }
}
