import { mkdir, readFile, writeFile, rmdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 20_000;

export class LeaderLock {
  constructor(hubRoot) {
    this.lockDir = path.join(hubRoot, "orchestrator", "leader.lock");
    this.leaderFile = path.join(this.lockDir, "leader.json");
    this.epochFile = path.join(hubRoot, "orchestrator", "epoch.json");
    this.hubId = `${os.hostname()}-${process.pid}`;
    this.epoch = 0;
    this._renewTimer = null;
  }

  async acquire() {
    const existing = await this._readLeader();
    if (existing && !this._isExpired(existing)) {
      throw new Error(`leader lock held by ${existing.hubId} (expires ${existing.expiresAt})`);
    }

    // Steal or create lock
    if (existing) {
      await rm(this.lockDir, { recursive: true, force: true });
    }
    await mkdir(path.dirname(this.lockDir), { recursive: true });
    await mkdir(this.lockDir);

    // Increment epoch
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
    await writeFile(this.leaderFile, JSON.stringify(leader, null, 2) + "\n", "utf8");
    return leader;
  }

  async renew() {
    const current = await this._readLeader();
    if (!current || current.hubId !== this.hubId) {
      return false;
    }
    current.heartbeatAt = new Date().toISOString();
    current.expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    await writeFile(this.leaderFile, JSON.stringify(current, null, 2) + "\n", "utf8");
    return true;
  }

  startRenewal() {
    this._renewTimer = setInterval(async () => {
      const ok = await this.renew();
      if (!ok) {
        clearInterval(this._renewTimer);
        this._renewTimer = null;
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
    await writeFile(this.epochFile, JSON.stringify({ epoch: next, updatedAt: new Date().toISOString() }) + "\n", "utf8");
    return next;
  }

  getEpoch() { return this.epoch; }
  getHubId() { return this.hubId; }
}
