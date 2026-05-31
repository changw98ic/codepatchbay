/**
 * Tests for the Quota Delegate system (client + delegate process).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendCommand, waitForAck, isDelegateAlive, delegateMarkProviderUnavailable, delegateEnqueueProviderUsage } from "../server/services/quota-delegate-client.js";
import { readProviderQuotas, markProviderUnavailable, writeProviderQuota } from "../server/services/provider-quota.js";

let tmpDir;
let hubRoot;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "quota-delegate-test-"));
  hubRoot = tmpDir;
  await mkdir(path.join(hubRoot, "providers", "delegate", "acks"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Client: appendCommand ───────────────────────────────────────────

describe("appendCommand", () => {
  it("appends JSONL line to commands.jsonl", async () => {
    await appendCommand(hubRoot, { type: "quota_write", commandId: "test-1", providerKey: "claude" });
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, "quota_write");
    assert.equal(parsed.commandId, "test-1");
    assert.equal(parsed.providerKey, "claude");
  });

  it("creates directory if missing", async () => {
    await rm(path.join(hubRoot, "providers", "delegate"), { recursive: true, force: true });
    await appendCommand(hubRoot, { type: "usage_write", commandId: "test-2" });
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    assert.ok(content.includes("test-2"));
  });

  it("serializes concurrent appends", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(appendCommand(hubRoot, { type: "usage_write", commandId: `concurrent-${i}` }));
    }
    await Promise.all(promises);
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 10);
    // All unique
    const ids = new Set(lines.map((l) => JSON.parse(l).commandId));
    assert.equal(ids.size, 10);
  });
});

// ─── Client: waitForAck ──────────────────────────────────────────────

describe("waitForAck", () => {
  it("returns ack when file appears", async () => {
    const ackDir = path.join(hubRoot, "providers", "delegate", "acks");
    const commandId = "ack-test-1";

    // Write ack after a short delay
    setTimeout(async () => {
      await writeFile(path.join(ackDir, `${commandId}.json`), JSON.stringify({ ok: true, commandId }) + "\n");
    }, 100);

    const ack = await waitForAck(hubRoot, commandId, 2000);
    assert.ok(ack);
    assert.equal(ack.ok, true);
    assert.equal(ack.commandId, commandId);
  });

  it("returns null on timeout", async () => {
    const ack = await waitForAck(hubRoot, "nonexistent", 200);
    assert.equal(ack, null);
  });
});

// ─── Client: isDelegateAlive ─────────────────────────────────────────

describe("isDelegateAlive", () => {
  it("returns false when no PID file exists", async () => {
    const alive = await isDelegateAlive(hubRoot);
    assert.equal(alive, false);
  });

  it("returns false for stale PID", async () => {
    await mkdir(path.join(hubRoot, "state"), { recursive: true });
    await writeFile(
      path.join(hubRoot, "state", "quota-delegate.json"),
      JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }) + "\n",
    );
    const alive = await isDelegateAlive(hubRoot);
    assert.equal(alive, false);
  });

  it("returns true for current process PID", async () => {
    await mkdir(path.join(hubRoot, "state"), { recursive: true });
    await writeFile(
      path.join(hubRoot, "state", "quota-delegate.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
    );
    const alive = await isDelegateAlive(hubRoot);
    assert.equal(alive, true);
  });
});

// ─── Client: delegateMarkProviderUnavailable ─────────────────────────

describe("delegateMarkProviderUnavailable", () => {
  it("writes command and falls back when no ack arrives", async () => {
    let fallbackCalled = false;
    const fallback = async (hr, opts) => {
      fallbackCalled = true;
      // Direct write
      await markProviderUnavailable(hr, opts);
      return { fallback: true };
    };

    const result = await delegateMarkProviderUnavailable(hubRoot, {
      providerKey: "test-provider",
      agent: "claude",
      status: "rate_limited",
      reason: "429 too many requests",
      nextEligibleAt: Date.now() + 60000,
      confidence: 0.9,
      source: "test",
    }, fallback, 200); // short timeout for test

    // Command was appended
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    assert.ok(content.includes("quota_write"));
    assert.ok(content.includes("test-provider"));

    // Fallback was called (no delegate running)
    assert.equal(fallbackCalled, true);
    assert.deepEqual(result, { fallback: true });
  });

  it("returns null when no ack and no fallback", async () => {
    const result = await delegateMarkProviderUnavailable(hubRoot, {
      providerKey: "test-provider",
      agent: "claude",
      status: "rate_limited",
      reason: "test",
    }, null, 200); // short timeout

    // No ack, no fallback → null
    assert.equal(result, null);
  });
});

// ─── Client: delegateEnqueueProviderUsage ─────────────────────────────

describe("delegateEnqueueProviderUsage", () => {
  it("writes usage command (fire-and-forget)", async () => {
    await delegateEnqueueProviderUsage(hubRoot, {
      project: "test-proj",
      phase: "execute",
      providerKey: "claude",
      agent: "claude",
      status: "ok",
      phaseStatus: "passed",
    });

    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.type, "usage_write");
    assert.equal(parsed.record.project, "test-proj");
    assert.equal(parsed.record.phase, "execute");
  });

  it("does not throw on missing directory", async () => {
    await rm(path.join(hubRoot, "providers", "delegate"), { recursive: true, force: true });
    await delegateEnqueueProviderUsage(hubRoot, {
      phase: "plan",
      providerKey: "codex",
      agent: "codex",
      status: "ok",
      phaseStatus: "passed",
    });
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    assert.ok(content.includes("codex"));
  });
});

// ─── Delegate: Command Processing (simulated) ───────────────────────

describe("delegate command processing", () => {
  it("quota_write command produces quota entry", async () => {
    // Simulate what the delegate does: writeProviderQuota
    const { writeProviderQuota: wpq } = await import("../server/services/provider-quota.js");
    await wpq(hubRoot, "test-key", {
      agent: "claude",
      status: "rate_limited",
      nextEligibleAt: Date.now() + 60000,
      source: "test",
      confidence: 0.9,
      reason: "429",
    });

    const quotas = await readProviderQuotas(hubRoot);
    assert.ok(quotas["test-key"]);
    assert.equal(quotas["test-key"].status, "rate_limited");
    assert.equal(quotas["test-key"].agent, "claude");
  });

  it("redactSecrets is applied to quota reason", async () => {
    const { redactSecrets } = await import("../server/services/provider-quota.js");
    const dirty = "rate limited: Bearer sk-abc123secret";
    const clean = redactSecrets(dirty);
    assert.ok(!clean.includes("sk-abc123secret"));
    assert.ok(clean.includes("[REDACTED]"));
  });
});

// ─── Integration: Command + Ack flow ─────────────────────────────────

describe("integration: command + ack", () => {
  it("full flow: append quota command, simulate delegate, verify ack", async () => {
    const commandId = "integ-test-1";

    // 1. Client appends command
    await appendCommand(hubRoot, {
      commandId,
      type: "quota_write",
      ts: new Date().toISOString(),
      providerKey: "integ-provider",
      entry: {
        agent: "claude",
        status: "rate_limited",
        nextEligibleAt: Date.now() + 60000,
        source: "test",
        confidence: 0.9,
        reason: "test reason",
      },
    });

    // 2. Read command (simulate delegate reading)
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    const cmd = JSON.parse(content.trim());
    assert.equal(cmd.commandId, commandId);
    assert.equal(cmd.type, "quota_write");

    // 3. Simulate delegate processing
    const { writeProviderQuota: wpq, readProviderQuotas: rpq } = await import("../server/services/provider-quota.js");
    await wpq(hubRoot, cmd.providerKey, cmd.entry);

    // 4. Simulate delegate writing ack
    const ackDir = path.join(hubRoot, "providers", "delegate", "acks");
    await mkdir(ackDir, { recursive: true });
    await writeFile(
      path.join(ackDir, `${commandId}.json`),
      JSON.stringify({ ok: true, commandId, processedAt: new Date().toISOString() }) + "\n",
    );

    // 5. Client reads ack
    const ack = await waitForAck(hubRoot, commandId, 500);
    assert.ok(ack);
    assert.equal(ack.ok, true);

    // 6. Verify quota was persisted
    const quotas = await rpq(hubRoot);
    assert.ok(quotas["integ-provider"]);
    assert.equal(quotas["integ-provider"].status, "rate_limited");
  });
});

// ─── Crash Recovery ──────────────────────────────────────────────────

describe("crash recovery", () => {
  it("unprocessed commands survive in JSONL file", async () => {
    // Write some commands
    for (let i = 0; i < 5; i++) {
      await appendCommand(hubRoot, { type: "usage_write", commandId: `crash-${i}`, record: { phase: "execute", providerKey: "claude", agent: "claude", status: "ok", phaseStatus: "passed" } });
    }

    // Read commands from offset 0 (simulating restart)
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "commands.jsonl"), "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 5);

    // Write offset simulating "processed 3 of 5"
    await writeFile(
      path.join(hubRoot, "providers", "delegate", "offset.json"),
      JSON.stringify({ byteOffset: 200 }) + "\n",
    );

    // Re-read offset
    const offset = JSON.parse(await readFile(path.join(hubRoot, "providers", "delegate", "offset.json"), "utf8"));
    assert.equal(offset.byteOffset, 200);
    // Remaining commands (from offset 200 onward) would be processed on restart
  });
});

// ─── Fallback Behavior ───────────────────────────────────────────────

describe("fallback behavior", () => {
  it("delegateMarkProviderUnavailable calls fallback when no delegate", async () => {
    let fallbackOpts = null;
    const fallback = async (hr, opts) => {
      fallbackOpts = opts;
      return { direct: true };
    };

    const result = await delegateMarkProviderUnavailable(hubRoot, {
      providerKey: "fb-test",
      agent: "claude",
      status: "window_exhausted",
      reason: "5h window exhausted",
    }, fallback, 200); // short timeout

    assert.deepEqual(result, { direct: true });
    assert.ok(fallbackOpts);
    assert.equal(fallbackOpts.providerKey, "fb-test");
  });

  it("delegateEnqueueProviderUsage does not throw on failure", async () => {
    // Even with a bad hubRoot, it should not throw
    await delegateEnqueueProviderUsage("/nonexistent/path", {
      phase: "execute",
      providerKey: "claude",
      agent: "claude",
      status: "ok",
      phaseStatus: "passed",
    });
    // No assertion needed — just verifying no throw
  });
});
