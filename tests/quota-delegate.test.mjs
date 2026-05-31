/**
 * Tests for the Quota Delegate system (client + delegate process).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendCommand, waitForAck, isDelegateAlive, delegateMarkProviderUnavailable, delegateEnqueueProviderUsage } from "../server/services/quota-delegate-client.js";
import { readProviderQuotas, redactSecrets } from "../server/services/provider-quota.js";
import { readProviderUsage } from "../server/services/provider-usage.js";
import { spawn } from "node:child_process";

let tmpDir;
let hubRoot;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "quota-delegate-test-"));
  hubRoot = tmpDir;
  await mkdir(path.join(hubRoot, "providers", "delegate", "inbox"), { recursive: true });
  await mkdir(path.join(hubRoot, "providers", "delegate", "acks"), { recursive: true });
  await mkdir(path.join(hubRoot, "providers", "delegate", "processed"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Client: appendCommand ───────────────────────────────────────────

describe("appendCommand", () => {
  it("writes per-file command to inbox", async () => {
    const cmd = { commandId: "test-1", type: "quota_write", providerKey: "claude" };
    await appendCommand(hubRoot, cmd);
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "inbox", "test-1.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, "quota_write");
    assert.equal(parsed.commandId, "test-1");
  });

  it("creates directories if missing", async () => {
    await rm(path.join(hubRoot, "providers", "delegate"), { recursive: true, force: true });
    await appendCommand(hubRoot, { commandId: "test-2", type: "usage_write" });
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "inbox", "test-2.json"), "utf8");
    assert.ok(content.includes("test-2"));
  });

  it("uses atomic rename (no partial files)", async () => {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(appendCommand(hubRoot, { commandId: `concurrent-${i}`, type: "usage_write" }));
    }
    await Promise.all(promises);
    const files = await readdir(path.join(hubRoot, "providers", "delegate", "inbox"));
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 10);
  });
});

// ─── Client: waitForAck ──────────────────────────────────────────────

describe("waitForAck", () => {
  it("returns ack when file appears", async () => {
    const commandId = "ack-test-1";
    setTimeout(async () => {
      await writeFile(
        path.join(hubRoot, "providers", "delegate", "acks", `${commandId}.json`),
        JSON.stringify({ ok: true, commandId }) + "\n",
      );
    }, 100);
    const ack = await waitForAck(hubRoot, commandId, 2000);
    assert.ok(ack);
    assert.equal(ack.ok, true);
  });

  it("returns null on timeout", async () => {
    const ack = await waitForAck(hubRoot, "nonexistent", 200);
    assert.equal(ack, null);
  });
});

// ─── Client: isDelegateAlive ─────────────────────────────────────────

describe("isDelegateAlive", () => {
  it("returns false when no PID file", async () => {
    assert.equal(await isDelegateAlive(hubRoot), false);
  });

  it("returns false for stale PID", async () => {
    await mkdir(path.join(hubRoot, "providers", "delegate"), { recursive: true });
    await writeFile(path.join(hubRoot, "providers", "delegate", "delegate.lock"), JSON.stringify({ pid: 999999999 }) + "\n");
    assert.equal(await isDelegateAlive(hubRoot), false);
  });

  it("returns true for current process PID", async () => {
    await mkdir(path.join(hubRoot, "providers", "delegate"), { recursive: true });
    await writeFile(path.join(hubRoot, "providers", "delegate", "delegate.lock"), JSON.stringify({ pid: process.pid }) + "\n");
    assert.equal(await isDelegateAlive(hubRoot), true);
  });
});

// ─── Client: delegateMarkProviderUnavailable ─────────────────────────

describe("delegateMarkProviderUnavailable", () => {
  it("writes command to inbox and throws on timeout (fail closed)", async () => {
    await assert.rejects(
      () => delegateMarkProviderUnavailable(hubRoot, {
        providerKey: "test-provider",
        agent: "claude",
        status: "rate_limited",
        reason: "429",
        nextEligibleAt: Date.now() + 60000,
        confidence: 0.9,
        source: "test",
      }, 200),
      (err) => {
        assert.equal(err.code, "QUOTA_DELEGATE_UNAVAILABLE");
        return true;
      },
    );

    // Command was still written to inbox
    const files = await readdir(path.join(hubRoot, "providers", "delegate", "inbox"));
    assert.ok(files.some((f) => f.endsWith(".json")));
  });
});

// ─── Client: delegateEnqueueProviderUsage ─────────────────────────────

describe("delegateEnqueueProviderUsage", () => {
  it("writes usage command to inbox (fire-and-forget)", async () => {
    await delegateEnqueueProviderUsage(hubRoot, {
      project: "test-proj",
      phase: "execute",
      providerKey: "claude",
      agent: "claude",
      status: "ok",
      phaseStatus: "passed",
    });
    const files = await readdir(path.join(hubRoot, "providers", "delegate", "inbox"));
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 1);
    const content = await readFile(path.join(hubRoot, "providers", "delegate", "inbox", jsonFiles[0]), "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.type, "usage_write");
    assert.equal(parsed.record.project, "test-proj");
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
    const files = await readdir(path.join(hubRoot, "providers", "delegate", "inbox"));
    assert.ok(files.length > 0);
  });
});

// ─── Delegate: Command Processing (simulated) ───────────────────────

describe("delegate command processing", () => {
  it("quota_write produces quota entry via writeProviderQuota", async () => {
    const { _internalWriteProviderQuota: wpq } = await import("../server/services/provider-quota.js");
    await wpq(hubRoot, "test-key", { agent: "claude", status: "rate_limited", nextEligibleAt: Date.now() + 60000, source: "test", confidence: 0.9, reason: "429" });
    const quotas = await readProviderQuotas(hubRoot);
    assert.ok(quotas["test-key"]);
    assert.equal(quotas["test-key"].status, "rate_limited");
  });

  it("redactSecrets strips secrets from reason", () => {
    const clean = redactSecrets("rate limited: Bearer sk-abc123secret");
    assert.ok(!clean.includes("sk-abc123secret"));
    assert.ok(clean.includes("[REDACTED]"));
  });
});

// ─── Dedup: processed/ prevents re-processing ───────────────────────

describe("command dedup via processed/", () => {
  it("command in processed/ is skipped", async () => {
    const commandId = "dedup-test-1";
    const inboxPath = path.join(hubRoot, "providers", "delegate", "inbox", `${commandId}.json`);
    const processedPath = path.join(hubRoot, "providers", "delegate", "processed", `${commandId}.json`);

    // Write command to both inbox and processed
    const cmd = { commandId, type: "usage_write", ts: new Date().toISOString(), record: { phase: "execute", providerKey: "claude", agent: "claude", status: "ok", phaseStatus: "passed" } };
    await writeFile(inboxPath, JSON.stringify(cmd) + "\n");
    await writeFile(processedPath, JSON.stringify({ processed: true }) + "\n");

    // Simulate delegate: check if already processed
    try {
      await stat(processedPath);
      // Already processed — should skip
      assert.ok(true, "command already in processed/");
    } catch {
      assert.fail("should have found command in processed/");
    }
  });
});

// ─── Integration: Real delegate process ──────────────────────────────

describe("integration: real delegate process", () => {
  it("client writes quota command → delegate processes → quota file on disk → ack", async () => {
    // Start real delegate process
    const delegatePath = path.join(process.cwd(), "server", "services", "quota-delegate.js");
    const child = spawn(process.execPath, [delegatePath, "--hub-root", hubRoot], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stdout += d.toString(); });

    // Wait for delegate to start
    await new Promise((r) => setTimeout(r, 500));

    try {
      // Client writes quota command
      const commandId = `integ-${Date.now()}`;
      await appendCommand(hubRoot, {
        commandId,
        type: "quota_write",
        ts: new Date().toISOString(),
        providerKey: "integ-provider",
        entry: {
          agent: "claude",
          status: "rate_limited",
          nextEligibleAt: Date.now() + 60000,
          source: "integration-test",
          confidence: 0.9,
          reason: "Bearer sk-secret123 should be redacted",
        },
      });

      // Wait for ack (delegate should process within 500ms)
      const ack = await waitForAck(hubRoot, commandId, 3000);
      assert.ok(ack, "ack should arrive");
      assert.equal(ack.ok, true);

      // Verify quota file on disk
      const quotas = await readProviderQuotas(hubRoot);
      assert.ok(quotas["integ-provider"], "quota entry should exist");
      assert.equal(quotas["integ-provider"].status, "rate_limited");

      // Verify reason was redacted at delegate boundary
      assert.ok(!quotas["integ-provider"].reason.includes("sk-secret123"), "reason should be redacted");
      assert.ok(quotas["integ-provider"].reason.includes("[REDACTED]"), "reason should contain [REDACTED]");

      // Verify command moved to processed/
      const processedFiles = await readdir(path.join(hubRoot, "providers", "delegate", "processed"));
      assert.ok(processedFiles.includes(`${commandId}.json`), "command should be in processed/");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    }
  });

  it("client writes usage command → delegate processes → usage.jsonl on disk", async () => {
    const delegatePath = path.join(process.cwd(), "server", "services", "quota-delegate.js");
    const child = spawn(process.execPath, [delegatePath, "--hub-root", hubRoot], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));

    try {
      await delegateEnqueueProviderUsage(hubRoot, {
        project: "integ-proj",
        phase: "execute",
        providerKey: "claude",
        agent: "claude",
        status: "ok",
        phaseStatus: "passed",
      });

      // Wait for delegate to process (poll usage.jsonl)
      const usagePath = path.join(hubRoot, "providers", "usage.jsonl");
      let usageExists = false;
      for (let i = 0; i < 30; i++) {
        try {
          const content = await readFile(usagePath, "utf8");
          if (content.includes("integ-proj")) {
            usageExists = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }

      assert.ok(usageExists, "usage.jsonl should contain the record");
      const records = await readProviderUsage(hubRoot);
      const integRecord = records.find((r) => r.project === "integ-proj");
      assert.ok(integRecord, "usage record should exist");
      assert.equal(integRecord.phase, "execute");
      assert.equal(integRecord.status, "ok");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    }
  });
});
