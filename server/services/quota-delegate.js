#!/usr/bin/env node
/**
 * Quota Delegate — long-running process for quota/usage writes.
 *
 * Reads command files from {hubRoot}/providers/delegate/inbox/,
 * processes them, writes acks for quota commands. Started/stopped by hub-cli.js.
 *
 * Usage: node quota-delegate.js --hub-root <path>
 */

import { mkdir, readdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, writeProviderQuota, markProviderAvailable } from "./provider-quota.js";

const POLL_INTERVAL_MS = Number(process.env.CPB_DELEGATE_POLL_MS || 100);
const STALE_ACK_MS = 60_000;

let shuttingDown = false;

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function processedDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "processed");
}

function acksDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "acks");
}

function ackFilePath(hubRoot, commandId) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
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
      const result = await writeProviderQuota(hubRoot, cmd.providerKey, entry);
      if (cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: true, entry: result });
      }
      break;
    }

    case "usage_write": {
      const record = cmd.record || {};
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
        quota: record.quota || null,
        usage: record.usage || null,
        fallback: record.fallback || null,
        providerAttempts: record.providerAttempts || null,
        source: record.source || null,
      };
      await appendUsageLine(hubRoot, entry);
      // No ack for usage writes
      break;
    }

    case "quota_available": {
      await markProviderAvailable(hubRoot, cmd.providerKey);
      if (cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: true });
      }
      break;
    }

    default:
      break;
  }
}

// ─── Usage JSONL Append ──────────────────────────────────────────────

async function appendUsageLine(hubRoot, record) {
  const filePath = path.join(hubRoot, "providers", "usage.jsonl");
  const line = `${JSON.stringify(record)}\n`;
  try {
    await appendFile(filePath, line, "utf8");
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, line, "utf8");
  }
}

// ─── Inbox Processing ────────────────────────────────────────────────

async function processInbox(hubRoot) {
  const inbox = inboxDir(hubRoot);
  const processed = processedDir(hubRoot);
  await mkdir(inbox, { recursive: true });
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
    const commandId = file.replace(/\.json$/, "");

    // Dedup: skip if already processed
    try {
      await stat(path.join(processed, file));
      // Already processed — remove from inbox
      await unlink(commandPath).catch(() => null);
      continue;
    } catch {
      // Not yet processed — proceed
    }

    // Read and parse command
    let cmd;
    try {
      const content = await readFile(commandPath, "utf8");
      cmd = JSON.parse(content);
    } catch {
      // Malformed command — move to processed to avoid retry loop
      await rename(commandPath, path.join(processed, file)).catch(() => null);
      continue;
    }

    // Verify commandId matches filename (防篡改)
    if (cmd.commandId && cmd.commandId !== commandId) {
      await rename(commandPath, path.join(processed, file)).catch(() => null);
      continue;
    }

    // Process
    try {
      await processCommand(hubRoot, cmd);
    } catch (err) {
      console.error(`quota-delegate: command error (${commandId}): ${err.message}`);
    }

    // Move to processed (dedup marker)
    try {
      await rename(commandPath, path.join(processed, file));
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

  await mkdir(delegateDir(hubRoot), { recursive: true });
  await mkdir(inboxDir(hubRoot), { recursive: true });
  await mkdir(processedDir(hubRoot), { recursive: true });
  await mkdir(acksDir(hubRoot), { recursive: true });

  await cleanupStaleAcks(hubRoot);

  process.on("SIGTERM", () => { shuttingDown = true; });
  process.on("SIGINT", () => { shuttingDown = true; });

  console.log(`quota-delegate: started (hubRoot=${hubRoot})`);

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

  console.log("quota-delegate: stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(`quota-delegate: fatal: ${err.message}`);
  process.exit(1);
});
