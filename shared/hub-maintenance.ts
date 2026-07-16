import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INCOMPLETE_LOCK_TTL_MS = 30_000;

export type HubMaintenanceOwner = {
  format: "cpb-hub-maintenance/v1";
  ownerToken: string;
  operation: string;
  hubRoot: string;
  pid: number;
  host: string;
  acquiredAt: string;
};

export type HubMaintenanceLease = {
  lockPath: string;
  owner: HubMaintenanceOwner;
  release: () => Promise<boolean>;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function namespacePath(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  const name = path.basename(resolved) || "root";
  return path.join(path.dirname(resolved), `.${name}.cpb-${digest}`);
}

export function hubMaintenanceLockPath(hubRoot: string) {
  return `${namespacePath(hubRoot)}.maintenance.lock`;
}

export function hubRestoreJournalPath(hubRoot: string) {
  return `${namespacePath(hubRoot)}.restore.json`;
}

export async function fsyncDirectory(directory: string) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(errnoCode(error))) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeJsonDurableAtomic(filePath: string, value: unknown) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(tempPath, "wx", 0o600);
  let closed = false;
  let renamed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(tempPath, filePath);
    renamed = true;
    await fsyncDirectory(parent);
  } finally {
    if (!closed) await handle.close().catch(() => undefined);
    if (!renamed) await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function removeDurable(filePath: string) {
  await rm(filePath, { force: true });
  await fsyncDirectory(path.dirname(filePath));
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

function processAlive(pidValue: unknown) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

async function readOwner(lockPath: string) {
  try {
    const parsed = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const owner = parsed as Partial<HubMaintenanceOwner>;
    if (
      owner.format !== "cpb-hub-maintenance/v1"
      || typeof owner.ownerToken !== "string"
      || !owner.ownerToken
      || typeof owner.operation !== "string"
      || typeof owner.hubRoot !== "string"
      || !Number.isInteger(owner.pid)
      || typeof owner.host !== "string"
      || !Number.isFinite(Date.parse(String(owner.acquiredAt || "")))
    ) return null;
    return owner as HubMaintenanceOwner;
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readHubMaintenance(hubRoot: string) {
  const resolvedHubRoot = path.resolve(hubRoot);
  const lockPath = hubMaintenanceLockPath(resolvedHubRoot);
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { active: false as const, lockPath, owner: null };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Hub maintenance lock is not a real directory: ${lockPath}`);
  }
  const owner = await readOwner(lockPath);
  const sameHost = owner?.host === os.hostname();
  return {
    active: true as const,
    lockPath,
    owner,
    incomplete: !owner,
    ageMs: Math.max(0, Date.now() - info.mtimeMs),
    ownerAlive: owner ? (!sameHost || processAlive(owner.pid)) : false,
  };
}

export async function assertHubWritable(hubRoot: string) {
  const journalPath = hubRestoreJournalPath(hubRoot);
  if (await pathExists(journalPath)) {
    throw Object.assign(
      new Error(`Hub is unavailable for writes until interrupted restore recovery completes (${journalPath})`),
      { code: "HUB_RESTORE_RECOVERY_REQUIRED" },
    );
  }
  const state = await readHubMaintenance(hubRoot);
  if (!state.active) return;
  const operation = state.owner?.operation || "unknown maintenance";
  throw Object.assign(
    new Error(`Hub is unavailable for writes while ${operation} is active (${state.lockPath})`),
    { code: "HUB_MAINTENANCE_ACTIVE" },
  );
}

async function quarantineLock(lockPath: string, expectedToken: string | null) {
  const current = await readOwner(lockPath);
  if (expectedToken ? current?.ownerToken !== expectedToken : current !== null) return false;
  const quarantine = `${lockPath}.stale-${Date.now()}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(lockPath));
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

export async function recoverStaleHubMaintenance(
  hubRoot: string,
  { allowRestoreJournal = false }: { allowRestoreJournal?: boolean } = {},
) {
  if (!allowRestoreJournal && await pathExists(hubRestoreJournalPath(hubRoot))) return false;
  const state = await readHubMaintenance(hubRoot);
  if (!state.active) return false;
  if (state.owner) {
    if (state.ownerAlive) return false;
    return quarantineLock(state.lockPath, state.owner.ownerToken);
  }
  if (state.ageMs < INCOMPLETE_LOCK_TTL_MS) return false;
  return quarantineLock(state.lockPath, null);
}

export async function acquireHubMaintenance(
  hubRoot: string,
  operation: string,
  { allowRestoreJournal = false }: { allowRestoreJournal?: boolean } = {},
): Promise<HubMaintenanceLease> {
  const resolvedHubRoot = path.resolve(hubRoot);
  const lockPath = hubMaintenanceLockPath(resolvedHubRoot);
  if (!allowRestoreJournal && await pathExists(hubRestoreJournalPath(resolvedHubRoot))) {
    throw Object.assign(
      new Error(`interrupted Hub restore requires recovery before maintenance can start (${hubRestoreJournalPath(resolvedHubRoot)})`),
      { code: "HUB_RESTORE_RECOVERY_REQUIRED" },
    );
  }
  const owner: HubMaintenanceOwner = {
    format: "cpb-hub-maintenance/v1",
    ownerToken: randomUUID(),
    operation: String(operation || "maintenance"),
    hubRoot: resolvedHubRoot,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await writeJsonDurableAtomic(path.join(lockPath, "owner.json"), owner);
      await fsyncDirectory(path.dirname(lockPath));
      return {
        lockPath,
        owner,
        release: () => releaseHubMaintenance(lockPath, owner.ownerToken),
      };
    } catch (error) {
      if (created) {
        const failed = `${lockPath}.failed-${owner.ownerToken}`;
        await rename(lockPath, failed).catch(() => undefined);
        await rm(failed, { recursive: true, force: true }).catch(() => undefined);
      }
      if (errnoCode(error) !== "EEXIST") throw error;
      if (await recoverStaleHubMaintenance(resolvedHubRoot, { allowRestoreJournal })) continue;
      const state = await readHubMaintenance(resolvedHubRoot);
      const heldBy = state.active && state.owner
        ? `${state.owner.operation} pid ${state.owner.pid} on ${state.owner.host}`
        : "an incomplete maintenance owner";
      throw Object.assign(new Error(`Hub maintenance lock is already held by ${heldBy}`), {
        code: "HUB_MAINTENANCE_ACTIVE",
      });
    }
  }
  throw new Error(`could not acquire Hub maintenance lock: ${lockPath}`);
}

async function releaseHubMaintenance(lockPath: string, ownerToken: string) {
  const owner = await readOwner(lockPath);
  if (owner?.ownerToken !== ownerToken) return false;
  const released = `${lockPath}.released-${ownerToken}`;
  try {
    await rename(lockPath, released);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(lockPath));
  await rm(released, { recursive: true, force: true });
  return true;
}
