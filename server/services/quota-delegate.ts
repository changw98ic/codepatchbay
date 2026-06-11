#!/usr/bin/env node
/**
 * Quota Delegate — long-running process for quota/usage writes.
 *
 * Reads command files from {hubRoot}/providers/delegate/inbox/,
 * processes them, writes acks for quota commands. Started/stopped by hub-cli.js.
 *
 * Single-instance: exclusive lock file prevents duplicate delegates.
 * Atomic claim: inbox → processing → processed (no double-process race).
 *
 * Usage: node quota-delegate.js --hub-root <path>
 */

import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, _internalWriteProviderQuota, _internalMarkProviderAvailable } from "./provider-quota.js";
import { _internalAppendUsageLine } from "./provider-usage.js";

const POLL_INTERVAL_MS = Number(process.env.CPB_DELEGATE_POLL_MS || 100);
const STALE_ACK_MS = Number(process.env.CPB_DELEGATE_ACK_TTL_MS || 60_000);

let shuttingDown = false;
let lockFd = null;

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function processingDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "processing");
}

function processedDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "processed");
}

function acksDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "acks");
}

function lockFilePath(hubRoot) {
  return path.join(delegateDir(hubRoot), "delegate.lock");
}

function ackFilePath(hubRoot, commandId) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

// ─── Single-Instance Lock ────────────────────────────────────────────

async function acquireLock(hubRoot) {
  const lockPath = lockFilePath(hubRoot);
  await mkdir(delegateDir(hubRoot), { recursive: true });

  try {
    const fd = await open(lockPath, "wx");
    await writeFile(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    return fd;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Lock exists — check if owner is alive
    try {
      const content = await readFile(lockPath, "utf8");
      const lock = JSON.parse(content);
      if (lock.pid) {
        try {
          process.kill(lock.pid, 0);
          // Owner is alive — another delegate is running
          console.error(`quota-delegate: another instance running (pid: ${lock.pid}), exiting`);
          process.exit(0);
        } catch {
          // Stale lock — remove and retry
        }
      }
      await unlink(lockPath);
    } catch {
      // Malformed or unreadable lock — remove and retry
      await unlink(lockPath).catch(() => null);
    }
    // Retry acquisition
    const fd = await open(lockPath, "wx");
    await writeFile(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    return fd;
  }
}

async function releaseLock() {
  if (lockFd) {
    try { await lockFd.close(); } catch { /* ignore */ }
    lockFd = null;
  }
  await unlink(lockFilePath(process.env.CPB_HUB_ROOT || "")).catch(() => null);
}

// ─── Ack Writing ─────────────────────────────────────────────────────

async function writeAck(hubRoot, commandId, ack) {
  const dir = acksDir(hubRoot);
  await mkdir(dir, { recursive: true });
  const ackData = { ...ack, commandId, processedAt: new Date().toISOString() };
  const ackPath = ackFilePath(hubRoot, commandId);
  const tmp = `${ackPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(ackData) + "\n", "utf8");
  await rename(tmp, ackPath);
}

// ─── Crash Recovery: move processing/ → inbox/ ───────────────────────

async function recoverProcessing(hubRoot) {
  const processing = processingDir(hubRoot);
  const inbox = inboxDir(hubRoot);
  try {
    const files = await readdir(processing);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    for (const file of jsonFiles) {
      try {
        await rename(path.join(processing, file), path.join(inbox, file));
      } catch {
        // May already be claimed by another delegate — ignore
      }
    }
    if (jsonFiles.length > 0) {
      console.log(`quota-delegate: recovered ${jsonFiles.length} command(s) from processing/`);
    }
  } catch { /* dir may not exist yet */ }
}

// ─── Stale Ack Cleanup ───────────────────────────────────────────────

async function cleanupStaleAcks(hubRoot) {
  try {
    const dir = acksDir(hubRoot);
    const files = await readdir(dir);
    const now = Date.now();
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const filePath = path.join(dir, file);
        const s = await stat(filePath);
        if (now - s.mtimeMs > STALE_ACK_MS) {
          await unlink(filePath);
        }
      } catch { /* ignore */ }
    }
  } catch { /* dir may not exist yet */ }
}

// ─── Command Processing ──────────────────────────────────────────────

async function processCommand(hubRoot, cmd) {
  if (!cmd || !cmd.type) return;

  switch (cmd.type) {
    case "quota_write": {
      const entry = { ...cmd.entry };
      if (entry.reason) entry.reason = redactSecrets(entry.reason);
      const result = await _internalWriteProviderQuota(hubRoot, cmd.providerKey, entry);
      if (cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: true, entry: result });
      }
      break;
    }

    case "usage_write": {
      const record = cmd.record || {};
      // Redact secrets in nested reason fields at delegate boundary
      const quota = record.quota ? { ...record.quota, reason: redactSecrets(record.quota.reason) } : null;
      const fallback = record.fallback ? { ...record.fallback, reason: redactSecrets(record.fallback.reason) } : null;
      const providerAttempts = record.providerAttempts
        ? record.providerAttempts.map((a) => ({ ...a, reason: redactSecrets(a.reason) }))
        : null;
      const entry = {
        ts: record.ts || cmd.ts || new Date().toISOString(),
        project: record.project || null,
        issueNumber: record.issueNumber ?? null,
        attempt: record.attempt ?? null,
        phase: record.phase,
        role: record.role || null,
        providerKey: record.providerKey,
        agent: record.agent,
        variant: record.variant || null,
        providerRegion: record.providerRegion || null,
        providerAdapter: record.providerAdapter || null,
        status: record.status,
        phaseStatus: record.phaseStatus,
        durationMs: record.durationMs ?? null,
        quota,
        usage: record.usage || null,
        fallback,
        providerAttempts,
        source: record.source || null,
      };
      await _internalAppendUsageLine(hubRoot, entry);
      // No ack for usage writes
      break;
    }

    case "quota_available": {
      await _internalMarkProviderAvailable(hubRoot, cmd.providerKey);
      if (cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: true });
      }
      break;
    }

    default:
      break;
  }
}

// ─── Inbox Processing (atomic claim) ─────────────────────────────────

async function processInbox(hubRoot) {
  const inbox = inboxDir(hubRoot);
  const processing = processingDir(hubRoot);
  const processed = processedDir(hubRoot);
  await mkdir(inbox, { recursive: true });
  await mkdir(processing, { recursive: true });
  await mkdir(processed, { recursive: true });

  let files;
  try {
    files = await readdir(inbox);
  } catch {
    return;
  }

  // Sort for deterministic ordering
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  for (const file of jsonFiles) {
    if (shuttingDown) break;

    const commandPath = path.join(inbox, file);
    const processingPath = path.join(processing, file);
    const processedPath = path.join(processed, file);
    const commandId = file.replace(/\.json$/, "");

    // Dedup: skip if already processed
    try {
      await stat(processedPath);
      await unlink(commandPath).catch(() => null);
      continue;
    } catch {
      // Not yet processed — proceed
    }

    // Atomic claim: move inbox → processing (prevents double-process by another delegate)
    try {
      await rename(commandPath, processingPath);
    } catch {
      // Another delegate claimed it, or file vanished — skip
      continue;
    }

    // Read and parse command from processing/
    let cmd;
    try {
      const content = await readFile(processingPath, "utf8");
      cmd = JSON.parse(content);
    } catch {
      // Malformed command — move to processed to avoid retry loop
      await rename(processingPath, processedPath).catch(() => null);
      continue;
    }

    // Verify commandId matches filename (防篡改)
    if (cmd.commandId && cmd.commandId !== commandId) {
      await rename(processingPath, processedPath).catch(() => null);
      continue;
    }

    // Process
    try {
      await processCommand(hubRoot, cmd);
    } catch (err) {
      console.error(`quota-delegate: command error (${commandId}): ${err.message}`);
      // On quota_write failure, write error ack so client doesn't hang
      if (cmd.type === "quota_write" && cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: false, error: err.message }).catch(() => null);
      }
    }

    // Move processing → processed (dedup marker)
    try {
      await rename(processingPath, processedPath);
    } catch {
      // May already be moved — ignore
    }
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────

async function main() {
  const hubRoot = process.argv.includes("--hub-root")
    ? process.argv[process.argv.indexOf("--hub-root") + 1]
    : process.env.CPB_HUB_ROOT;

  if (!hubRoot) {
    console.error("quota-delegate: --hub-root or CPB_HUB_ROOT required");
    process.exit(1);
  }

  // Store hubRoot for lock cleanup on exit
  process.env.CPB_HUB_ROOT = hubRoot;

  await mkdir(delegateDir(hubRoot), { recursive: true });
  await mkdir(inboxDir(hubRoot), { recursive: true });
  await mkdir(processingDir(hubRoot), { recursive: true });
  await mkdir(processedDir(hubRoot), { recursive: true });
  await mkdir(acksDir(hubRoot), { recursive: true });

  // Single-instance lock
  lockFd = await acquireLock(hubRoot);

  await cleanupStaleAcks(hubRoot);
  await recoverProcessing(hubRoot);

  process.on("SIGTERM", () => { shuttingDown = true; });
  process.on("SIGINT", () => { shuttingDown = true; });
  process.on("exit", () => { releaseLock(); });

  console.log(`quota-delegate: started (hubRoot=${hubRoot}, pid=${process.pid})`);

  while (!shuttingDown) {
    try {
      await processInbox(hubRoot);
    } catch (err) {
      console.error(`quota-delegate: loop error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Graceful shutdown: drain remaining
  try {
    await processInbox(hubRoot);
  } catch { /* best-effort */ }

  await releaseLock();
  console.log("quota-delegate: stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(`quota-delegate: fatal: ${err.message}`);
  process.exit(1);
});
