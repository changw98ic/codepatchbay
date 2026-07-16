#!/usr/bin/env node
/**
 * Quota Delegate — single-writer IPC process for provider quota and usage state.
 *
 * The client writes command JSON files under {hubRoot}/providers/delegate/inbox.
 * This process serializes writes to provider quota/usage files and emits ack files
 * for commands that require confirmation.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { _internalMarkProviderUnavailable } from "./provider-quota.js";
import { _internalAppendUsageLine } from "./provider-usage.js";
import { recordValue, type LooseRecord } from "../../shared/types.js";
import { assertHubWritable } from "../../shared/hub-maintenance.js";

const POLL_MS = Number(process.env.CPB_DELEGATE_POLL_MS || 50);

function argValue(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function delegateDir(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function acksDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "acks");
}

function lockFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "delegate.lock");
}

function ackFilePath(hubRoot: string, commandId: string) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function writeLock(hubRoot: string) {
  await mkdir(delegateDir(hubRoot), { recursive: true });
  await writeFile(lockFilePath(hubRoot), JSON.stringify({
    pid: process.pid,
    hubRoot,
    startedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

async function cleanupLock(hubRoot: string) {
  try {
    const current = JSON.parse(await readFile(lockFilePath(hubRoot), "utf8"));
    if (current?.pid === process.pid) await rm(lockFilePath(hubRoot), { force: true });
  } catch {
    // Lock cleanup is best effort during shutdown.
  }
}

async function writeAck(hubRoot: string, commandId: string, ack: LooseRecord) {
  await mkdir(acksDir(hubRoot), { recursive: true });
  await writeFile(ackFilePath(hubRoot, commandId), JSON.stringify({
    commandId,
    ts: new Date().toISOString(),
    ...ack,
  }, null, 2) + "\n", "utf8");
}

async function processCommand(hubRoot: string, filePath: string) {
  let commandId = path.basename(filePath, ".json");
  try {
    const command = recordValue(JSON.parse(await readFile(filePath, "utf8")));
    commandId = stringValue(command.commandId, commandId);
    const type = stringValue(command.type);

    if (type === "quota_write") {
      const providerKey = stringValue(command.providerKey);
      const entry = recordValue(command.entry);
      if (!providerKey) throw new Error("quota_write command missing providerKey");
      const updated = await _internalMarkProviderUnavailable(hubRoot, {
        providerKey,
        agent: stringValue(entry.agent, providerKey),
        variant: nullableString(entry.variant),
        status: stringValue(entry.status, "unknown"),
        nextEligibleAt: nullableNumber(entry.nextEligibleAt),
        source: stringValue(entry.source, "quota-delegate"),
        confidence: nullableNumber(entry.confidence) ?? 1,
        reason: stringValue(entry.reason),
      });
      await writeAck(hubRoot, commandId, { ok: true, entry: updated });
      return;
    }

    if (type === "usage_write") {
      await _internalAppendUsageLine(hubRoot, recordValue(command.record));
      await writeAck(hubRoot, commandId, { ok: true });
      return;
    }

    throw new Error(`unknown delegate command type: ${type || "(missing)"}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeAck(hubRoot, commandId, { ok: false, error: message }).catch(() => null);
  } finally {
    await rm(filePath, { force: true }).catch(() => null);
  }
}

async function processInbox(hubRoot: string) {
  await mkdir(inboxDir(hubRoot), { recursive: true });
  const entries = await readdir(inboxDir(hubRoot)).catch(() => []);
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.includes(".tmp-")) continue;
    await processCommand(hubRoot, path.join(inboxDir(hubRoot), entry));
  }
}

export async function runQuotaDelegate(hubRoot: string) {
  await writeLock(hubRoot);
  console.log(`quota-delegate: started pid=${process.pid} hubRoot=${hubRoot}`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    while (!stopping) {
      await processInbox(hubRoot);
      await sleep(POLL_MS);
    }
  } finally {
    await cleanupLock(hubRoot);
    console.log("quota-delegate: stopped");
  }
}

async function main() {
  const rawHubRoot = argValue(process.argv, "--hub-root") || process.env.CPB_HUB_ROOT || "";
  if (!rawHubRoot) {
    throw new Error("quota delegate requires --hub-root or CPB_HUB_ROOT");
  }
  const hubRoot = path.resolve(rawHubRoot);
  await assertHubWritable(hubRoot);
  await runQuotaDelegate(hubRoot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
