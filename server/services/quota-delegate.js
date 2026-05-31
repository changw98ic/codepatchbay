#!/usr/bin/env node
/**
 * Quota Delegate — long-running process for quota/usage writes.
 *
 * Tails {hubRoot}/providers/delegate/commands.jsonl, processes commands,
 * sends acks for quota writes. Started/stopped by hub-cli.js.
 *
 * Usage: node quota-delegate.js --hub-root <path>
 */

import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, readProviderQuotas, writeProviderQuota, markProviderAvailable } from "./provider-quota.js";

const POLL_INTERVAL_MS = Number(process.env.CPB_DELEGATE_POLL_MS || 100);
const STALE_ACK_MS = 60_000;

let shuttingDown = false;

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot) {
  return path.join(hubRoot, "providers", "delegate");
}

function commandsFilePath(hubRoot) {
  return path.join(delegateDir(hubRoot), "commands.jsonl");
}

function offsetFilePath(hubRoot) {
  return path.join(delegateDir(hubRoot), "offset.json");
}

function acksDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "acks");
}

function ackFilePath(hubRoot, commandId) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

// ─── Offset Tracking ─────────────────────────────────────────────────

async function loadOffset(hubRoot) {
  try {
    const data = JSON.parse(await readFile(offsetFilePath(hubRoot), "utf8"));
    return data.byteOffset || 0;
  } catch {
    return 0;
  }
}

async function saveOffset(hubRoot, offset) {
  const dir = delegateDir(hubRoot);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `offset.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, JSON.stringify({ byteOffset: offset, updatedAt: new Date().toISOString() }) + "\n", "utf8");
  await rename(tmp, offsetFilePath(hubRoot));
}

// ─── Command Tailing ─────────────────────────────────────────────────

async function readNewCommands(hubRoot, byteOffset) {
  try {
    const fh = await (await import("node:fs/promises")).open(commandsFilePath(hubRoot), "r");
    try {
      const size = (await fh.stat()).size;
      if (size <= byteOffset) return { commands: [], newOffset: byteOffset };

      const buf = Buffer.alloc(size - byteOffset);
      await fh.read(buf, 0, buf.length, byteOffset);
      const text = buf.toString("utf8");
      const lines = text.split("\n").filter(Boolean);
      const commands = [];
      for (const line of lines) {
        try { commands.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      return { commands, newOffset: size };
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err.code === "ENOENT") return { commands: [], newOffset: byteOffset };
    throw err;
  }
}

// ─── Ack Writing ─────────────────────────────────────────────────────

async function writeAck(hubRoot, commandId, ack) {
  const dir = acksDir(hubRoot);
  await mkdir(dir, { recursive: true });
  const ackData = { ...ack, commandId, processedAt: new Date().toISOString() };
  const tmp = path.join(dir, `${commandId}.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, JSON.stringify(ackData) + "\n", "utf8");
  await rename(tmp, ackFilePath(hubRoot, commandId));
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
      // Redact secrets at the delegate boundary (item 8)
      const entry = { ...cmd.entry };
      if (entry.reason) entry.reason = redactSecrets(entry.reason);

      const result = await writeProviderQuota(hubRoot, cmd.providerKey, entry);
      if (cmd.commandId) {
        await writeAck(hubRoot, cmd.commandId, { ok: true, entry: result });
      }
      break;
    }

    case "usage_write": {
      // Append to usage.jsonl directly (no ack needed)
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
      // Unknown command type — skip
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

// ─── Main Loop ───────────────────────────────────────────────────────

async function main() {
  const hubRoot = process.argv.includes("--hub-root")
    ? process.argv[process.argv.indexOf("--hub-root") + 1]
    : process.env.CPB_HUB_ROOT;

  if (!hubRoot) {
    console.error("quota-delegate: --hub-root or CPB_HUB_ROOT required");
    process.exit(1);
  }

  // Ensure directories exist
  await mkdir(delegateDir(hubRoot), { recursive: true });
  await mkdir(acksDir(hubRoot), { recursive: true });

  let offset = await loadOffset(hubRoot);

  // Clean stale acks on startup
  await cleanupStaleAcks(hubRoot);

  // Signal handlers
  process.on("SIGTERM", () => {
    shuttingDown = true;
  });
  process.on("SIGINT", () => {
    shuttingDown = true;
  });

  console.log(`quota-delegate: started (hubRoot=${hubRoot}, offset=${offset})`);

  while (!shuttingDown) {
    try {
      const { commands, newOffset } = await readNewCommands(hubRoot, offset);
      for (const cmd of commands) {
        if (shuttingDown) break;
        await processCommand(hubRoot, cmd).catch((err) => {
          console.error(`quota-delegate: command error: ${err.message}`);
        });
      }
      if (newOffset !== offset) {
        offset = newOffset;
        await saveOffset(hubRoot, offset);
      }
    } catch (err) {
      console.error(`quota-delegate: loop error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Graceful shutdown: drain remaining commands
  try {
    const { commands } = await readNewCommands(hubRoot, offset);
    for (const cmd of commands) {
      await processCommand(hubRoot, cmd).catch(() => null);
    }
    await saveOffset(hubRoot, offset + Buffer.byteLength(JSON.stringify(commands), "utf8"));
  } catch { /* best-effort drain */ }

  console.log("quota-delegate: stopped");
  process.exit(0);
}

main().catch((err) => {
  console.error(`quota-delegate: fatal: ${err.message}`);
  process.exit(1);
});
