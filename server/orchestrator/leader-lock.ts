import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, rename, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { LooseRecord } from "../../shared/types.js";
import { writeJsonAtomic } from "../../shared/fs-utils.js";
import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
  type RedisLeaderStatus,
} from "../../shared/hub-state-redis.js";
import { processLeaderFence, registerProcessLeaderFence } from "../../shared/hub-leader-fence.js";

const DEFAULT_TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 20_000;

function dateInput(value: unknown): string | number | Date | null {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) return value;
  return null;
}

function numericPid(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class LeaderLock {
  hubRoot: string;
  lockDir: string;
  leaderFile: string;
  epochFile: string;
  quarantineDir: string;
  hubId: string;
  lockToken: string;
  epoch: number;
  _renewTimer: NodeJS.Timeout | null;
  _onLost?: () => void;
  _redisBackend: HubRedisStateBackend | null | undefined;

  constructor(hubRoot: string) {
    this.hubRoot = path.resolve(hubRoot);
    this.lockDir = path.join(this.hubRoot, "orchestrator", "leader.lock");
    this.leaderFile = path.join(this.lockDir, "leader.json");
    this.epochFile = path.join(this.hubRoot, "orchestrator", "epoch.json");
    this.quarantineDir = path.join(this.hubRoot, "orchestrator", "leader.quarantine");
    this.hubId = `${os.hostname()}-${process.pid}`;
    this.lockToken = randomUUID();
    this.epoch = 0;
    this._renewTimer = null;
    this._redisBackend = undefined;
  }

  async acquire() {
    const redis = await this._redisState();
    if (redis) {
      if (processLeaderFence(redis.identityFingerprint)) {
        throw Object.assign(
          new Error("this process has a retired Redis leader fence; start a new process before reacquiring leadership"),
          { code: "HUB_LEADER_PROCESS_RESTART_REQUIRED" },
        );
      }
      const result = await redis.acquireLeader({
        hubId: this.hubId,
        lockToken: this.lockToken,
        host: os.hostname(),
        pid: process.pid,
      }, DEFAULT_TTL_MS);
      if (!result.acquired) {
        throw new Error(`leader lock held by ${result.leader.hubId || "unknown"} (expires ${result.leader.expiresAt || "unknown"})`);
      }
      this.epoch = result.leader.epoch;
      registerProcessLeaderFence(redis.identityFingerprint, this._fence());
      return redisLeaderRecord(result.leader);
    }

    const existing = await this._readLeader();

    if (existing && !this._isExpired(existing)) {
      throw new Error(`leader lock held by ${existing.hubId} (expires ${existing.expiresAt})`);
    }

    // Steal stale lock atomically: rename to quarantine first. A released lock
    // is no longer needed for forensics and can be removed after the rename.
    if (existing) {
      const quarantined = await this._quarantineCurrentLock(existing.releasedAt ? "released" : "stale");
      if (existing.releasedAt) await rm(quarantined, { recursive: true, force: true });
    } else {
      await this._recoverIncompleteLock();
    }

    // mkdir as sole atomic acquire primitive
    await mkdir(path.dirname(this.lockDir), { recursive: true });
    try {
      await mkdir(this.lockDir);
    } catch (err) {
      if (err.code === "EEXIST") {
        throw new Error(`leader lock contention: another Hub acquired the lock`);
      }
      throw err;
    }

    const startedAt = new Date().toISOString();
    const provisional = {
      hubId: this.hubId,
      host: os.hostname(),
      pid: process.pid,
      epoch: 0,
      lockToken: this.lockToken,
      initializing: true,
      startedAt,
      heartbeatAt: startedAt,
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    };

    try {
      // Publish ownership before any fallible epoch work. If the process dies
      // after mkdir but before this write, acquire() recovers the incomplete
      // directory after the same TTL instead of wedging leadership forever.
      await writeJsonAtomic(this.leaderFile, provisional);

      // Lock acquired — now safe to increment epoch (epoch only after lock held).
      this.epoch = await this._incrementEpoch();
      const leader = {
        ...provisional,
        epoch: this.epoch,
        initializing: false,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
      };
      if (!await this._writeLeaderGuarded(leader, false)) {
        throw new Error("leader lock ownership changed before acquisition committed");
      }
      return leader;
    } catch (error) {
      await this._expireOwnedInitialization(error);
      throw error;
    }
  }

  async renew() {
    const redis = await this._redisState();
    if (redis) return (await redis.renewLeader(this._fence(), DEFAULT_TTL_MS)).renewed;

    const current = await this._readLeader();
    if (!this._isCurrentLeader(current)) {
      return false;
    }
    current.heartbeatAt = new Date().toISOString();
    current.expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    return this._writeLeaderGuarded(current, true);
  }

  /**
   * Start periodic renewal. Calls onLost() if renewal fails (lock stolen/expired).
   */
  startRenewal(onLost: () => void) {
    this._onLost = onLost;
    this._renewTimer = setInterval(async () => {
      let ok = false;
      try {
        ok = await this.renew();
      } catch {
        ok = false;
      }
      if (!ok) {
        clearInterval(this._renewTimer);
        this._renewTimer = null;
        if (this._onLost) this._onLost();
      }
    }, RENEW_INTERVAL_MS);
    this._renewTimer.unref();
  }

  stopRenewal() {
    if (this._renewTimer) {
      clearInterval(this._renewTimer);
      this._renewTimer = null;
    }
  }

  async release() {
    this.stopRenewal();
    try {
      const redis = await this._redisState();
      if (redis) {
        const fence = this._fence();
        // Keep the released fence armed in this process. stop() does not join
        // in-flight tick/janitor callbacks, so clearing it would let their
        // later queue mutations silently downgrade to unfenced writes. This
        // process must exit before another LeaderLock can acquire the backend.
        return await redis.releaseLeader(fence);
      }

      const current = await this._readLeader();
      if (!this._matchesCurrentIdentity(current)) return false;
      const releasedAt = new Date().toISOString();
      return this._writeLeaderGuarded({
        ...current,
        releasedAt,
        heartbeatAt: releasedAt,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }, true);
    } catch {
      return false;
    }
  }

  /**
   * Check if this Hub still holds the leader lock (for epoch fencing).
   */
  async stillHeld() {
    const redis = await this._redisState();
    if (redis) {
      const current = await redis.readLeader();
      return current.alive
        && current.hubId === this.hubId
        && current.lockToken === this.lockToken
        && current.epoch === this.epoch;
    }

    const current = await this._readLeader();
    return this._isCurrentLeader(current);
  }

  async _redisState() {
    if (this._redisBackend !== undefined) return this._redisBackend;
    this._redisBackend = await openPinnedHubRedisStateBackend({
      configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
      hubRoot: this.hubRoot,
    });
    return this._redisBackend;
  }

  _fence() {
    return { hubId: this.hubId, lockToken: this.lockToken, epoch: this.epoch };
  }

  async _readLeader() {
    try {
      return JSON.parse(await readFile(this.leaderFile, "utf8"));
    } catch {
      return null;
    }
  }

  _isExpired(leader: LooseRecord | null) {
    const expiresAtValue = dateInput(leader?.expiresAt);
    const expiresAt = expiresAtValue ? new Date(expiresAtValue).getTime() : NaN;
    return !Number.isFinite(expiresAt) || Date.now() > expiresAt;
  }

  _matchesCurrentIdentity(leader: LooseRecord | null) {
    return Boolean(
      leader
      && this.epoch > 0
      && leader.hubId === this.hubId
      && leader.lockToken === this.lockToken
      && Number(leader.epoch) === this.epoch,
    );
  }

  _matchesLockToken(leader: LooseRecord | null) {
    return Boolean(
      leader
      && leader.hubId === this.hubId
      && leader.lockToken === this.lockToken,
    );
  }

  _isCurrentLeader(leader: LooseRecord | null) {
    return this._matchesCurrentIdentity(leader) && !this._isExpired(leader);
  }

  async _incrementEpoch() {
    let current = 0;
    try {
      const data = JSON.parse(await readFile(this.epochFile, "utf8"));
      current = data.epoch || 0;
    } catch { /* first time */ }
    const next = current + 1;
    await mkdir(path.dirname(this.epochFile), { recursive: true });
    await writeJsonAtomic(this.epochFile, { epoch: next, updatedAt: new Date().toISOString() });
    return next;
  }

  async _quarantineCurrentLock(reason: "stale" | "released" | "incomplete") {
    await mkdir(this.quarantineDir, { recursive: true });
    const target = path.join(this.quarantineDir, `${reason}-${Date.now()}-${randomUUID()}`);
    try {
      await rename(this.lockDir, target);
      return target;
    } catch (error) {
      throw new Error(`leader lock ${reason} quarantine lost a contention race`, { cause: error });
    }
  }

  async _recoverIncompleteLock() {
    let lockStat;
    try {
      lockStat = await stat(this.lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }

    const ageMs = Math.max(0, Date.now() - lockStat.mtimeMs);
    if (ageMs <= DEFAULT_TTL_MS) {
      throw new Error(`leader lock is initializing (${Math.round(ageMs)}ms old)`);
    }
    await this._quarantineCurrentLock("incomplete");
    return true;
  }

  async _writeLeaderGuarded(next: LooseRecord, requireEpoch: boolean) {
    const tempPath = path.join(this.lockDir, `.leader-${this.lockToken}-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(tempPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      // The temp file is created before the identity check. If a contender
      // renames this lock directory at any later point, the temp file moves
      // with the old directory and rename(tempPath, leaderFile) fails instead
      // of overwriting the replacement leader at the reused pathname.
      const current = await this._readLeader();
      const ownsCurrent = requireEpoch
        ? this._matchesCurrentIdentity(current)
        : this._matchesLockToken(current);
      if (!ownsCurrent) return false;

      try {
        await rename(tempPath, this.leaderFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    } finally {
      if (created) await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async _expireOwnedInitialization(error: unknown) {
    try {
      const current = await this._readLeader();
      if (!this._matchesLockToken(current)) return false;
      const failedAt = new Date().toISOString();
      return this._writeLeaderGuarded({
        ...current,
        initializing: false,
        initializationFailedAt: failedAt,
        initializationFailure: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        heartbeatAt: failedAt,
        expiresAt: new Date(Date.now() - 1).toISOString(),
      }, false);
    } catch {
      return false;
    }
  }

  getEpoch() { return this.epoch; }
  getHubId() { return this.hubId; }
}

export async function readLeaderStatus(hubRoot: string) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
  if (redis) {
    const leader = await redis.readLeader();
    return {
      status: leader.alive ? "running" : "stopped",
      hubId: leader.hubId,
      epoch: leader.epoch,
      pid: leader.pid,
      heartbeatAt: leader.heartbeatAt,
      expiresAt: leader.expiresAt,
    };
  }

  const lockDir = path.join(hubRoot, "orchestrator", "leader.lock");
  const leaderFile = path.join(lockDir, "leader.json");
  const epochFile = path.join(hubRoot, "orchestrator", "epoch.json");
  const leader = await readJsonOrNull(leaderFile);
  const epochState = await readJsonOrNull(epochFile);
  const leaderAlive = isLeaderAlive(leader);

  return {
    status: leaderAlive ? "running" : "stopped",
    hubId: leader?.hubId || null,
    epoch: leader?.epoch || epochState?.epoch || 0,
    pid: leader?.pid || null,
    heartbeatAt: leader?.heartbeatAt || null,
    expiresAt: leader?.expiresAt || null,
  };
}

function redisLeaderRecord(leader: RedisLeaderStatus) {
  return {
    hubId: leader.hubId,
    host: leader.host,
    pid: leader.pid,
    epoch: leader.epoch,
    lockToken: leader.lockToken,
    initializing: false,
    startedAt: leader.startedAt,
    heartbeatAt: leader.heartbeatAt,
    expiresAt: leader.expiresAt,
  };
}

async function readJsonOrNull(file: string): Promise<LooseRecord | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function isLeaderAlive(leader: LooseRecord | null) {
  const expiresAtValue = dateInput(leader?.expiresAt);
  const expiresAt = expiresAtValue ? new Date(expiresAtValue).getTime() : NaN;
  if (
    !leader
    || leader.initializing
    || leader.releasedAt
    || !Number.isFinite(expiresAt)
    || Date.now() > expiresAt
  ) return false;
  const pid = numericPid(leader.pid);
  if (!pid || leader.host !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
