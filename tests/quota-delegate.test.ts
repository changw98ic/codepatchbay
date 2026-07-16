import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  delegateEnqueueProviderUsage,
  delegateMarkProviderUnavailable,
  isDelegateAlive,
} from "../server/services/quota-delegate-client.js";
import { QuotaStatus, readProviderQuotas } from "../server/services/provider-quota.js";
import { readProviderUsage } from "../server/services/provider-usage.js";

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for quota delegate");
}

test("quota delegate processes provider quota and usage IPC commands", async (t) => {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-quota-delegate-"));
  const scriptPath = fileURLToPath(new URL("../server/services/quota-delegate.js", import.meta.url));
  let output = "";
  const child = spawn(process.execPath, [scriptPath, "--hub-root", hubRoot], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url)), ".."),
    env: { ...process.env, CPB_HUB_ROOT: hubRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  t.after(() => {
    if (child.pid) child.kill("SIGTERM");
  });

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`quota delegate exited early with ${child.exitCode}: ${output}`);
    }
    return isDelegateAlive(hubRoot);
  });

  const nextEligibleAt = Date.now() + 60_000;
  const entry = await delegateMarkProviderUnavailable(hubRoot, {
    providerKey: "claude:glm",
    agent: "claude-glm",
    variant: "glm",
    status: QuotaStatus.RATE_LIMITED,
    nextEligibleAt,
    source: "unit-test",
    confidence: 0.9,
    reason: "429 from provider",
  });
  assert.equal(entry.providerKey, "claude:glm");
  assert.equal(entry.status, QuotaStatus.RATE_LIMITED);

  const quotas = await readProviderQuotas(hubRoot);
  assert.equal(quotas["claude:glm"].agent, "claude-glm");
  assert.equal(quotas["claude:glm"].nextEligibleAt, nextEligibleAt);

  await delegateEnqueueProviderUsage(hubRoot, {
    project: "flow",
    jobId: "job-routing-history",
    attemptId: "attempt-2",
    taskCategory: "bugfix",
    retryCount: 2,
    jobRetryCount: 1,
    phaseRetryCount: 1,
    isRetry: true,
    phase: "execute",
    role: "executor",
    providerKey: "claude:glm",
    agent: "claude-glm",
    variant: "glm",
    status: "rate_limited",
    phaseStatus: "failed",
    failureKind: "timeout",
    durationMs: 42,
    source: "unit-test",
  });
  await waitFor(async () => (await readProviderUsage(hubRoot)).length === 1);
  const usage = await readProviderUsage(hubRoot);
  assert.equal(usage[0].providerKey, "claude:glm");
  assert.equal(usage[0].status, "rate_limited");
  assert.equal(usage[0].jobId, "job-routing-history");
  assert.equal(usage[0].attemptId, "attempt-2");
  assert.equal(usage[0].taskCategory, "bugfix");
  assert.equal(usage[0].retryCount, 2);
  assert.equal(usage[0].jobRetryCount, 1);
  assert.equal(usage[0].phaseRetryCount, 1);
  assert.equal(usage[0].isRetry, true);
  assert.equal(usage[0].failureKind, "timeout");
  assert.match(String(usage[0].recordedAt), /^\d{4}-\d{2}-\d{2}T/);

  const lock = JSON.parse(await readFile(path.join(hubRoot, "providers", "delegate", "delegate.lock"), "utf8"));
  assert.equal(lock.pid, child.pid);
});
