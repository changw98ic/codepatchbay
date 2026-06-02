import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerProject } from "../server/services/hub-registry.js";
import { createJob, completeJob, getJob } from "../server/services/job-store.js";
import { listQueue } from "../server/services/hub-queue.js";
import { acceptReviewBundle, rejectReviewBundle } from "../server/services/review-loop.js";

describe("review loop service", () => {
  it("persists bundle review rounds and queues rejected bundle correction context", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-loop-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Fix rejected review bundle",
        workflow: "standard",
        planMode: "full",
        dataRoot,
        sourceContext: { type: "manual", queueEntryId: "q-origin" },
      });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot });

      const rejected = await rejectReviewBundle(cpbRoot, "proj", job.jobId, {
        actor: "tester",
        feedback: "Tests are missing for the edge case.",
        hubRoot,
        sourcePath,
        dataRoot,
      });
      assert.equal(rejected.rejected, true);
      assert.equal(rejected.round, 1);

      const updated = await getJob(cpbRoot, "proj", job.jobId, { dataRoot });
      assert.equal(updated.reviewLoop.rounds.length, 1);
      assert.equal(updated.reviewLoop.latest.verdict, "rejected");
      assert.equal(updated.reviewLoop.latest.correctionQueueEntryId, rejected.correctionQueueEntry.id);

      const queueEntries = await listQueue(hubRoot);
      const correction = queueEntries.find((entry) => entry.id === rejected.correctionQueueEntry.id);
      assert.ok(correction, "correction queue entry should exist");
      assert.equal(correction.type, "review_bundle_correction");
      assert.equal(correction.priority, "P0");
      assert.equal(correction.metadata.originJobId, job.jobId);
      assert.equal(correction.metadata.reviewRound, 1);
      assert.equal(correction.metadata.sourceContext.correction.failureKind, "human_rejected_review_bundle");
      assert.equal(correction.metadata.sourceContext.correction.previousJobId, job.jobId);
      assert.match(correction.metadata.sourceContext.correction.failureReason, /edge case/);
      assert.equal(correction.metadata.sourceContext.reviewLoop.correctionQueueEntryId, correction.id);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("prevents duplicate human decisions on the same review bundle", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-loop-duplicate-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Accept once",
        workflow: "standard",
        planMode: "full",
        dataRoot,
      });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot });

      const accepted = await acceptReviewBundle(cpbRoot, "proj", job.jobId, {
        actor: "tester",
        feedback: "looks good",
        dataRoot,
      });
      assert.equal(accepted.accepted, true);
      assert.equal(accepted.round, 1);

      await assert.rejects(
        () => rejectReviewBundle(cpbRoot, "proj", job.jobId, {
          actor: "tester",
          feedback: "second decision should be rejected",
          hubRoot,
          sourcePath,
          dataRoot,
        }),
        (error) => error?.code === "REVIEW_BUNDLE_ALREADY_REVIEWED" && error?.statusCode === 409,
      );

      const queueEntries = await listQueue(hubRoot);
      assert.equal(queueEntries.length, 0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects review bundle actions before the job reaches a terminal state", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-review-loop-active-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Still running",
        workflow: "standard",
        planMode: "full",
        dataRoot,
      });

      await assert.rejects(
        () => acceptReviewBundle(cpbRoot, "proj", job.jobId, { actor: "tester", dataRoot }),
        /terminal/,
      );
      await assert.rejects(
        () => rejectReviewBundle(cpbRoot, "proj", job.jobId, {
          actor: "tester",
          feedback: "Do not fork active jobs.",
          hubRoot,
          sourcePath,
          dataRoot,
        }),
        /terminal/,
      );

      const queueEntries = await listQueue(hubRoot);
      assert.equal(queueEntries.length, 0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
