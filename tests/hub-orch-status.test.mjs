import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { enqueue, updateEntry } from "../server/services/hub-queue.js";

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("Hub orchestrator status", () => {
  it("reports the live leader lock instead of the short-lived status process", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-orch-status-"));

    try {
      await writeJson(path.join(hubRoot, "orchestrator", "leader.lock", "leader.json"), {
        hubId: "live-hub",
        host: os.hostname(),
        pid: process.pid,
        epoch: 42,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const orchestrator = new HubOrchestrator(hubRoot, process.cwd());
      const status = await orchestrator.status();

      assert.equal(status.orchestrator.status, "running");
      assert.equal(status.orchestrator.hubId, "live-hub");
      assert.equal(status.orchestrator.epoch, 42);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("uses queue entries, not historical assignments, for queue counts", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-orch-queue-status-"));

    try {
      const active = await enqueue(hubRoot, { projectId: "alpha", description: "active" });
      await updateEntry(hubRoot, active.id, {
        status: "in_progress",
        claimedBy: "worker-alpha",
        claimedAt: new Date().toISOString(),
      });

      await writeJson(path.join(hubRoot, "assignments", "a-old-failure", "state.json"), {
        assignmentId: "a-old-failure",
        entryId: "old-failure",
        projectId: "alpha",
        status: "failed",
      });
      const blocked = await enqueue(hubRoot, { projectId: "beta", description: "blocked" });
      await updateEntry(hubRoot, blocked.id, {
        status: "blocked",
        reason: "human approval required",
      });

      const orchestrator = new HubOrchestrator(hubRoot, process.cwd());
      const status = await orchestrator.status();

      assert.equal(status.queue.running, 1);
      assert.equal(status.queue.failed, 0);
      assert.equal(status.queue.blocked, 1);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});
