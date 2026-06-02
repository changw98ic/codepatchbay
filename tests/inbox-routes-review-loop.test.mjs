import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { inboxRoutes } from "../server/routes/inbox.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob, completeJob } from "../server/services/job-store.js";
import { listQueue } from "../server/services/hub-queue.js";

async function buildApp({ cpbRoot, hubRoot } = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(inboxRoutes, { prefix: "/api" });
  return app;
}

describe("inbox review bundle loop routes", () => {
  it("POST reject persists a bundle round and exposes the correction queue entry", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-review-loop-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Correct this reviewed bundle",
        workflow: "standard",
        dataRoot,
      });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot });

      const rejected = await app.inject({
        method: "POST",
        url: `/api/inbox/${job.jobId}/review-bundle/reject`,
        payload: {
          actor: "tester",
          feedback: "The acceptance path is not covered.",
        },
      });
      assert.equal(rejected.statusCode, 200);
      const rejectedBody = JSON.parse(rejected.body);
      assert.equal(rejectedBody.rejected, true);
      assert.equal(rejectedBody.round, 1);
      assert.ok(rejectedBody.correctionQueueEntry.id);

      const detail = await app.inject({ method: "GET", url: `/api/inbox/${job.jobId}` });
      assert.equal(detail.statusCode, 200);
      const detailBody = JSON.parse(detail.body);
      assert.equal(detailBody.reviewLoop.rounds.length, 1);
      assert.equal(detailBody.reviewLoop.rounds[0].verdict, "rejected");
      assert.equal(detailBody.reviewLoop.rounds[0].correctionQueueEntryId, rejectedBody.correctionQueueEntry.id);

      const entries = await listQueue(hubRoot);
      const correction = entries.find((entry) => entry.id === rejectedBody.correctionQueueEntry.id);
      assert.ok(correction, "correction queue entry should exist");
      assert.equal(correction.metadata.sourceContext.correction.previousJobId, job.jobId);
      assert.equal(correction.metadata.sourceContext.correction.reviewRound, 1);
      assert.match(correction.metadata.sourceContext.correction.failureReason, /acceptance path/);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("POST accept persists a bundle round without queuing correction work", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-review-loop-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Accept this reviewed bundle",
        workflow: "standard",
        dataRoot,
      });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot });

      const accepted = await app.inject({
        method: "POST",
        url: `/api/inbox/${job.jobId}/review-bundle/accept`,
        payload: { actor: "tester", feedback: "ship it" },
      });
      assert.equal(accepted.statusCode, 200);
      const acceptedBody = JSON.parse(accepted.body);
      assert.equal(acceptedBody.accepted, true);
      assert.equal(acceptedBody.round, 1);

      const detail = await app.inject({ method: "GET", url: `/api/inbox/${job.jobId}` });
      assert.equal(detail.statusCode, 200);
      const detailBody = JSON.parse(detail.body);
      assert.equal(detailBody.reviewLoop.rounds.length, 1);
      assert.equal(detailBody.reviewLoop.rounds[0].verdict, "accepted");
      assert.equal(detailBody.reviewLoop.rounds[0].correctionQueueEntryId, null);

      const entries = await listQueue(hubRoot);
      assert.equal(entries.length, 0);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("POST reject returns 409 for a nonterminal job and does not enqueue correction work", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-review-loop-active-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Still running inbox bundle",
        workflow: "standard",
        dataRoot,
      });

      const rejected = await app.inject({
        method: "POST",
        url: `/api/inbox/${job.jobId}/review-bundle/reject`,
        payload: {
          actor: "tester",
          feedback: "Should wait for terminal state.",
        },
      });
      assert.equal(rejected.statusCode, 409);
      const body = JSON.parse(rejected.body);
      assert.equal(body.code, "REVIEW_JOB_NOT_TERMINAL");

      const entries = await listQueue(hubRoot);
      assert.equal(entries.length, 0);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
