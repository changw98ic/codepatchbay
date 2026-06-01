import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildProjectQueueStatus, claimEligible, enqueue, loadQueue } from "../server/services/hub-queue.js";

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
});
