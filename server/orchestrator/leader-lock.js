import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeJsonAtomic } from "../services/fs-utils.js";

const DEFAULT_TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 20_000;

export class LeaderLock {
  constructor(hubRoot) {
    this.lockDir = path.join(hubRoot, "orchestrator", "leader.lock");
    this.leaderFile = path.join(this.lockDir, "leader.json");
    this.epochFile = path.join(hubRoot, "orchestrator", "epoch.json");
    this.quarantineDir = path.join(hubRoot, "orchestrator", "leader.quarantine");
    this.hubId = `${os.hostname()}-${process.pid}`;
    this.epoch = 0;
    this._renewTimer = null;
  }

  async acquire() {
    const existing = await this._readLeader();

    if (existing && !this._isExpired(existing)) {
      throw new Error(`leader lock held by ${existing.hubId} (expires ${existing.expiresAt})`);
    }

    // Steal stale lock atomically: rename to quarantine first
    if (existing) {
      await mkdir(this.quarantineDir, { recursive: true });
      const quarantineName = `stale-${existing.hubId}-${Date.now()}`;
      try {
        await rename(this.lockDir, path.join(this.quarantineDir, quarantineName));
      } catch {
        // Lock disappeared between read and rename — race lost, another Hub stole it
        const recheck = await this._readLeader();
        if (recheck && !this._isExpired(recheck)) {
          throw new Error(`leader lock stolen by ${recheck.hubId}`);
        }
        // If rename failed but lock is still stale, force cleanup
        await rm(this.lockDir, { recursive: true, force: true });
      }
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

    // Lock acquired — now safe to increment epoch (P1-3 fix: epoch only after lock held)
    this.epoch = await this._incrementEpoch();

    const leader = {
      hubId: this.hubId,
      host: os.hostname(),
      pid: process.pid,
      epoch: this.epoch,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
    };
    await writeJsonAtomic(this.leaderFile, leader);
    return leader;
  }

  async renew() {
    const current = await this._readLeader();
    if (!current || current.hubId !== this.hubId) {
      return false;
    }
    current.heartbeatAt = new Date().toISOString();
    current.expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    await writeJsonAtomic(this.leaderFile, current);
    return true;
  }

  /**
   * Start periodic renewal. Calls onLost() if renewal fails (lock stolen/expired).
   */
  startRenewal(onLost) {
    this._onLost = onLost;
    this._renewTimer = setInterval(async () => {
      const ok = await this.renew();
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
      const current = await this._readLeader();
      if (current?.hubId === this.hubId) {
        await rm(this.lockDir, { recursive: true, force: true });
      }
    } catch { /* already released */ }
  }

  /**
   * Check if this Hub still holds the leader lock (for epoch fencing).
   */
  async stillHeld() {
    const current = await this._readLeader();
    return current?.hubId === this.hubId;
  }

  async _readLeader() {
    try {
      return JSON.parse(await readFile(this.leaderFile, "utf8"));
    } catch {
      return null;
    }
  }

  _isExpired(leader) {
    return Date.now() > new Date(leader.expiresAt).getTime();
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

  getEpoch() { return this.epoch; }
  getHubId() { return this.hubId; }
}

export async function readLeaderStatus(hubRoot) {
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

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function isLeaderAlive(leader) {
  const expiresAt = leader?.expiresAt ? new Date(leader.expiresAt).getTime() : NaN;
  if (!leader || !Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  if (!leader.pid || leader.host !== os.hostname()) return true;
  try {
    process.kill(leader.pid, 0);
    return true;
  } catch {
    return false;
  }
}
