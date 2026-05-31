/**
 * Quota Delegate Client — IPC client for the quota delegate process.
 *
 * Sends structured commands as individual files to {hubRoot}/providers/delegate/inbox/.
 * Each command is a file named {commandId}.json, written via atomic rename.
 * Quota writes use strong ack (poll for ack file); usage writes are fire-and-forget.
 * Fails closed when delegate is unavailable (no fallback to direct writes).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ACK_POLL_MS = Number(process.env.CPB_DELEGATE_ACK_POLL_MS || 50);
const ACK_TIMEOUT_MS = Number(process.env.CPB_DELEGATE_ACK_TIMEOUT_MS || 5000);

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function acksDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "acks");
}

function commandFilePath(hubRoot, commandId) {
  return path.join(inboxDir(hubRoot), `${commandId}.json`);
}

function ackFilePath(hubRoot, commandId) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

function pidFilePath(hubRoot) {
  return path.join(hubRoot, "state", "quota-delegate.json");
}

// ─── Command Write (per-file, atomic rename) ─────────────────────────

export async function appendCommand(hubRoot, command) {
  const dir = inboxDir(hubRoot);
  await mkdir(dir, { recursive: true });
  const filePath = commandFilePath(hubRoot, command.commandId);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(command) + "\n", "utf8");
  await rename(tmp, filePath);
}

// ─── Ack Polling ─────────────────────────────────────────────────────

export async function waitForAck(hubRoot, commandId, timeoutMs = ACK_TIMEOUT_MS) {
  const ackPath = ackFilePath(hubRoot, commandId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const content = await readFile(ackPath, "utf8");
      return JSON.parse(content);
    } catch {
      await new Promise((r) => setTimeout(r, ACK_POLL_MS));
    }
  }
  return null;
}

// ─── Delegate Liveness ───────────────────────────────────────────────

export async function isDelegateAlive(hubRoot) {
  try {
    const state = JSON.parse(await readFile(pidFilePath(hubRoot), "utf8"));
    if (!state.pid) return false;
    process.kill(state.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── High-Level APIs ─────────────────────────────────────────────────

/**
 * Mark a provider as unavailable via the delegate.
 * Strong ack: blocks until delegate confirms the quota write.
 * Fails closed: returns null if delegate is unavailable (no fallback).
 */
export async function delegateMarkProviderUnavailable(hubRoot, opts, ackTimeoutMs) {
  const commandId = randomUUID();
  const command = {
    commandId,
    type: "quota_write",
    ts: new Date().toISOString(),
    providerKey: opts.providerKey,
    entry: {
      agent: opts.agent,
      variant: opts.variant || null,
      status: opts.status,
      nextEligibleAt: opts.nextEligibleAt ?? null,
      source: opts.source || "delegate-client",
      confidence: opts.confidence ?? 1,
      reason: opts.reason || "",
    },
  };

  await appendCommand(hubRoot, command);
  const ack = await waitForAck(hubRoot, commandId, ackTimeoutMs || ACK_TIMEOUT_MS);
  if (!ack?.ok) {
    const err = new Error("quota delegate unavailable; provider state not recorded");
    err.code = "QUOTA_DELEGATE_UNAVAILABLE";
    throw err;
  }
  return ack.entry;
}

/**
 * Enqueue a usage record via the delegate.
 * Fire-and-forget: no ack, no waiting.
 */
export async function delegateEnqueueProviderUsage(hubRoot, record) {
  const commandId = randomUUID();
  const command = {
    commandId,
    type: "usage_write",
    ts: new Date().toISOString(),
    record: {
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
    },
  };

  await appendCommand(hubRoot, command).catch(() => null);
}
