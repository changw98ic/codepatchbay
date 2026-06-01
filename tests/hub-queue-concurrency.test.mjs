import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProjectQueueStatus, claimEligible, enqueue, loadQueue } from "../server/services/hub-queue.js";
import { Scheduler } from "../server/orchestrator/scheduler.js";

describe("Hub queue project concurrency", () => {
  it("allows two mutating entries per project by default", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-queue-concurrency-"));

    try {
      await enqueue(hubRoot, { projectId: "alpha", description: "first" });
      await enqueue(hubRoot, { projectId: "alpha", description: "second" });

      const first = await claimEligible(hubRoot, { workerId: "worker-a" });
      assert.equal(first.entry?.description, "first");

      const queueAfterFirstClaim = await loadQueue(hubRoot);
      const projectStatus = buildProjectQueueStatus(queueAfterFirstClaim.entries);
      assert.equal(projectStatus.alpha.activeMutating, 1);
      assert.equal(projectStatus.alpha.eligiblePending, 1);

      const second = await claimEligible(hubRoot, { workerId: "worker-b" });
      assert.equal(second.entry?.description, "second");
      assert.equal(second.reason, null);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("uses project-specific mutating concurrency when scheduling", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-project-limit-"));

    try {
      const alphaActive = await enqueue(hubRoot, { projectId: "alpha", description: "alpha active" });
      await enqueue(hubRoot, { projectId: "alpha", description: "alpha pending" });
      await enqueue(hubRoot, { projectId: "beta", description: "beta pending" });

      const { updateEntry } = await import("../server/services/hub-queue.js");
      await updateEntry(hubRoot, alphaActive.id, {
        status: "in_progress",
        claimedBy: "worker-alpha",
        claimedAt: new Date().toISOString(),
      });

      const scheduler = new Scheduler(hubRoot, {
        assignmentStore: { getAssignment: async () => null },
        workerStore: {},
        getProjectFn: async (_hubRoot, projectId) => ({
          id: projectId,
          concurrency: { maxActivePerProject: projectId === "alpha" ? 1 : 2 },
        }),
      });

      const candidate = await scheduler.nextCandidate();
      assert.equal(candidate.description, "beta pending");
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("stops scheduling when the global active mutating cap is reached", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-global-limit-"));

    try {
      const alphaActive = await enqueue(hubRoot, { projectId: "alpha", description: "alpha active" });
      const betaActive = await enqueue(hubRoot, { projectId: "beta", description: "beta active" });
      await enqueue(hubRoot, { projectId: "gamma", description: "gamma pending" });

      const { updateEntry } = await import("../server/services/hub-queue.js");
      for (const entry of [alphaActive, betaActive]) {
        await updateEntry(hubRoot, entry.id, {
          status: "in_progress",
          claimedBy: `worker-${entry.projectId}`,
          claimedAt: new Date().toISOString(),
        });
      }

      const scheduler = new Scheduler(hubRoot, {
        assignmentStore: { getAssignment: async () => null },
        workerStore: {},
        maxActiveTotal: 2,
      });

      const candidate = await scheduler.nextCandidate();
      assert.equal(candidate, null);
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("does not impose a Hub-wide active cap by default", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-no-global-limit-"));

    try {
      const activeEntries = [];
      for (const projectId of ["alpha", "beta", "gamma", "delta"]) {
        activeEntries.push(await enqueue(hubRoot, { projectId, description: `${projectId} active` }));
      }
      await enqueue(hubRoot, { projectId: "epsilon", description: "epsilon pending" });

      const { updateEntry } = await import("../server/services/hub-queue.js");
      for (const entry of activeEntries) {
        await updateEntry(hubRoot, entry.id, {
          status: "in_progress",
          claimedBy: `worker-${entry.projectId}`,
          claimedAt: new Date().toISOString(),
        });
      }

      const scheduler = new Scheduler(hubRoot, {
        assignmentStore: { getAssignment: async () => null },
        workerStore: {},
      });

      const candidate = await scheduler.nextCandidate();
      assert.equal(candidate?.description, "epsilon pending");

      const claimed = await claimEligible(hubRoot, { workerId: "worker-epsilon" });
      assert.equal(claimed.entry?.description, "epsilon pending");
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});
