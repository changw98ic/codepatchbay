import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { saveSessionId, loadSessionId } from "../core/agents/session-cache.js";
import { cleanupAgentHomes } from "../core/agents/isolation.js";
import { registerDagWorkflow } from "../core/workflow/definition.js";
import { recoverJobs, readyNodesFor } from "../server/services/supervisor.js";

describe("Defects fixes verification", () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-defects-test-"));
    process.env.CPB_ROOT = tmpRoot;
  });

  afterEach(async () => {
    delete process.env.CPB_ROOT;
    try { await rm(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  it("session cache locking prevents stomping", async () => {
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(saveSessionId(tmpRoot, "claude", `sess-${i}`));
    }
    await assert.doesNotReject(Promise.all(promises));
    const cached = await loadSessionId(tmpRoot, "claude");
    assert.ok(cached?.sessionId);
  });

  it("agent home GC with injected lease check", async () => {
    const jobDirActive = path.join(tmpRoot, "cpb-task", "agent-homes", "claude", "job-active");
    const jobDirExpired = path.join(tmpRoot, "cpb-task", "agent-homes", "claude", "job-expired");
    await mkdir(jobDirActive, { recursive: true });
    await mkdir(jobDirExpired, { recursive: true });

    // Mark directories as old
    const oldTime = Date.now() - 48 * 60 * 60 * 1000;
    const oldDate = new Date(oldTime);
    const { utimes } = await import("node:fs/promises");
    await utimes(jobDirActive, oldDate, oldDate);
    await utimes(jobDirExpired, oldDate, oldDate);

    // Create an active lease file in leases/ matching job-active
    const leasesDir = path.join(tmpRoot, "cpb-task", "leases");
    await mkdir(leasesDir, { recursive: true });
    const leaseFile = path.join(leasesDir, "lease-job-active-execute.json");
    await writeFile(leaseFile, JSON.stringify({
      leaseId: "lease-job-active-execute",
      jobId: "job-active",
      phase: "execute",
      ownerToken: "token-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));

    const { readLease, isLeaseStale } = await import("../server/services/lease-manager.js");
    const cleaned = await cleanupAgentHomes(tmpRoot, {
      maxAgeMs: 24 * 60 * 60 * 1000,
      isLeaseActive: async (jobId) => {
        try {
          const files = await readdir(leasesDir);
          const prefix = `lease-${jobId}-`;
          for (const f of files) {
            if (f.startsWith(prefix) && f.endsWith(".json")) {
              const lease = await readLease(tmpRoot, path.basename(f, ".json"));
              if (lease !== null && !isLeaseStale(lease)) return true;
            }
          }
        } catch {}
        return false;
      },
    });
    assert.equal(cleaned, 1);

    try {
      await readFile(path.join(jobDirExpired, ".config"));
      assert.fail("job-expired should have been deleted");
    } catch (err) {
      assert.ok(err.code === "ENOENT");
    }

    const statActive = await utimes(jobDirActive, new Date(), new Date()).catch(() => null);
    assert.ok(statActive !== null, "job-active should still exist");
  });

  it("DAG workflow schedules parallel nodes concurrently", async () => {
    registerDagWorkflow("test-parallel-sched", {
      nodes: [
        { id: "node1", phase: "plan", dependsOn: [] },
        { id: "node2", phase: "execute", dependsOn: ["node1"] },
        { id: "node3", phase: "execute", dependsOn: ["node1"] },
      ],
      maxConcurrentNodes: 2,
    });

    const { createJob, getJob } = await import("../server/services/job-store.js");
    const { appendEvent, checkpointJob } = await import("../server/services/event-store.js");

    const job = await createJob(tmpRoot, {
      project: "my-project",
      workflow: "test-parallel-sched",
    });
    const jobId = job.jobId;

    await appendEvent(tmpRoot, "my-project", jobId, { type: "phase_started", jobId, phase: "node1", leaseId: `lease-${jobId}-node1` });
    await appendEvent(tmpRoot, "my-project", jobId, { type: "phase_completed", jobId, phase: "node1", artifact: "plan-001.md" });
    await appendEvent(tmpRoot, "my-project", jobId, { type: "phase_started", jobId, phase: "node2", leaseId: `lease-${jobId}-node2` });
    
    await checkpointJob(tmpRoot, "my-project", jobId);

    const state = await getJob(tmpRoot, "my-project", jobId);
    assert.deepEqual(state.completedNodes, ["node1"]);
    assert.deepEqual(state.runningNodes, ["node2"]);

    const readyInfo = readyNodesFor(state);
    assert.deepEqual(readyInfo.ready, ["node3"]);

    const recoverable = await recoverJobs(tmpRoot);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].jobId, jobId);
  });

  it("job-store metrics resolution resolves executor object to string name", async () => {
    const { createJob, completePhase, completeJob } = await import("../server/services/job-store.js");
    const executorObj = {
      root: "/path/to/claude/root",
      packageName: "claude",
      version: "1.0.0",
    };
    const job = await createJob(tmpRoot, {
      project: "my-project",
      workflow: "standard",
      executor: executorObj,
    });
    const jobId = job.jobId;

    const { startPhase } = await import("../server/services/job-store.js");
    await startPhase(tmpRoot, "my-project", jobId, { phase: "execute", attempt: 1, leaseId: "lease-1" });
    await completePhase(tmpRoot, "my-project", jobId, { phase: "execute" });

    // Verify it recorded performance under the resolved string name "claude"
    const { readdir: rd } = await import("node:fs/promises");
    const perfDir = path.join(tmpRoot, "cpb-task", "performance");
    const filesBefore = await rd(perfDir);
    assert.ok(filesBefore.includes("claude.jsonl"), "Should create claude.jsonl performance file");
    assert.ok(!filesBefore.includes("[object Object].jsonl"), "Should NOT create [object Object].jsonl performance file");

    // Add a verdict for the completeJob check
    const { appendEvent } = await import("../server/services/event-store.js");
    await appendEvent(tmpRoot, "my-project", jobId, {
      type: "phase_completed",
      jobId,
      project: "my-project",
      phase: "verdict",
      artifact: "PASS",
    });

    await completeJob(tmpRoot, "my-project", jobId);

    const filesAfter = await rd(perfDir);
    assert.ok(filesAfter.includes("claude-quality.jsonl"), "Should create claude-quality.jsonl performance file");
    assert.ok(!filesAfter.includes("[object Object]-quality.jsonl"), "Should NOT create [object Object]-quality.jsonl file");
  });
});
