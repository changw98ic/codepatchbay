import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  requestApprovalGate,
  approveGate,
  timeoutApprovalGate,
} from "../server/services/approval-gate.js";
import { appendEvent } from "../server/services/event-store.js";

let tmpDir;
let cpbRoot;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "approval-gate-test-"));
  cpbRoot = tmpDir;
});

afterEach(async () => {
  // Wait for fire-and-forget rebuildExperienceIndex to finish
  await new Promise((r) => setTimeout(r, 100));
  await rm(tmpDir, { recursive: true, force: true });
});

async function seedJob(project, jobId) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    ts: new Date().toISOString(),
  });
}

describe("requestApprovalGate", () => {
  it("transitions job to the exact waiting.approval status", async () => {
    await seedJob("proj", "j1");
    const job = await requestApprovalGate(cpbRoot, "proj", "j1", {
      operation: "PR",
      phase: "execute",
      reason: "PR needs review",
    });

    assert.equal(job.status, "waiting.approval");
    assert.equal(job.blockedReason, "PR needs review");
    assert.equal(job.approval.operation, "PR");
    assert.equal(job.approval.phase, "execute");
  });
});

describe("approveGate", () => {
  it("releases a waiting.approval job without fuzzy blockedReason matching", async () => {
    await seedJob("proj", "j10");
    await requestApprovalGate(cpbRoot, "proj", "j10", {
      operation: "shell",
      phase: "execute",
      reason: "manual approval required",
    });

    const job = await approveGate(cpbRoot, "proj", "j10", {
      actor: { userId: "reviewer" },
    });

    assert.equal(job.status, "running");
    assert.equal(job.blockedReason, null);
    assert.equal(job.approval, null);
  });
});

describe("timeoutApprovalGate", () => {
  it("blocks a timed-out approval with an explicit reason", async () => {
    await seedJob("proj", "j20");
    await requestApprovalGate(cpbRoot, "proj", "j20", {
      operation: "merge",
      timeoutAt: new Date(Date.now() - 1000).toISOString(),
    });

    const job = await timeoutApprovalGate(cpbRoot, "proj", "j20", {
      reason: "no response in 30min",
    });

    assert.equal(job.status, "blocked");
    assert.equal(job.blockedReason, "no response in 30min");
    assert.ok(job.approval.timedOutAt);
  });
});
