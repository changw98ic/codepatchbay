/**
 * Quota Delegate Client — IPC client for the quota delegate process.
 *
 * Sends structured commands to {hubRoot}/providers/delegate/commands.jsonl.
 * Quota writes use strong ack (poll for ack file); usage writes are fire-and-forget.
 * Falls back to direct writes if delegate is unavailable.
 */

import { appendFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ACK_POLL_MS = Number(process.env.CPB_DELEGATE_ACK_POLL_MS || 50);
const ACK_TIMEOUT_MS = Number(process.env.CPB_DELEGATE_ACK_TIMEOUT_MS || 5000);

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot) {
  return path.join(hubRoot, "providers", "delegate");
}

function commandsFilePath(hubRoot) {
  return path.join(delegateDir(hubRoot), "commands.jsonl");
}

function acksDir(hubRoot) {
  return path.join(delegateDir(hubRoot), "acks");
}

function ackFilePath(hubRoot, commandId) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

function pidFilePath(hubRoot) {
  return path.join(hubRoot, "state", "quota-delegate.json");
}

// ─── Command Append ──────────────────────────────────────────────────

// In-process queue to prevent interleaved JSONL writes
const _appendQueues = new Map();

export async function appendCommand(hubRoot, command) {
  const filePath = commandsFilePath(hubRoot);
  const prev = _appendQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => null).then(async () => {
    const line = `${JSON.stringify(command)}\n`;
    try {
      await appendFile(filePath, line, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        await mkdir(delegateDir(hubRoot), { recursive: true });
        await writeFile(filePath, line, "utf8");
      } else {
        throw err;
      }
    }
  });
  _appendQueues.set(filePath, next.catch(() => null));
  return next;
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
      // Not yet — wait and retry
      await new Promise((r) => setTimeout(r, ACK_POLL_MS));
    }
  }
  return null; // timeout
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
 * Falls back to direct write if delegate is unavailable.
 */
export async function delegateMarkProviderUnavailable(hubRoot, opts, directFallback, ackTimeoutMs) {
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

  // Poll for ack
  const ack = await waitForAck(hubRoot, commandId, ackTimeoutMs || ACK_TIMEOUT_MS);
  if (ack?.ok) return ack.entry;

  // Fallback: delegate is down or timed out
  if (directFallback) {
    return directFallback(hubRoot, opts);
  }
  return null;
}

/**
 * Enqueue a usage record via the delegate.
 * Fire-and-forget: no ack, no waiting.
 */
export async function delegateEnqueueProviderUsage(hubRoot, record) {
  const command = {
    commandId: randomUUID(),
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
