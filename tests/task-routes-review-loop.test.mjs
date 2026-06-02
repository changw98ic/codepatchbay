import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { taskRoutes } from "../server/routes/tasks.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob, completeJob, getJob } from "../server/services/job-store.js";
import { listQueue } from "../server/services/hub-queue.js";

async function buildApp({ cpbRoot, hubRoot } = {}) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = cpbRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(taskRoutes, { prefix: "/api" });
  return app;
}

describe("task review bundle loop routes", () => {
  it("rejects a task review bundle and links the correction queue entry to the original job", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-task-review-loop-"));
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
        task: "Correct task route bundle",
        workflow: "standard",
        dataRoot,
      });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot });

      const response = await app.inject({
        method: "POST",
        url: `/api/tasks/proj/jobs/${job.jobId}/review-bundle/reject`,
        payload: {
          actor: "tester",
          feedback: "The implementation missed the Inbox route.",
        },
      });
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.rejected, true);
      assert.equal(body.round, 1);

      const updated = await getJob(cpbRoot, "proj", job.jobId, { dataRoot });
      assert.equal(updated.reviewLoop.latest.correctionQueueEntryId, body.correctionQueueEntry.id);

      const entries = await listQueue(hubRoot);
      const correction = entries.find((entry) => entry.id === body.correctionQueueEntry.id);
      assert.ok(correction);
      assert.equal(correction.metadata.originJobId, job.jobId);
      assert.equal(correction.metadata.originalBundleId, body.bundleId);
      assert.equal(correction.metadata.sourceContext.reviewLoop.originalJobId, job.jobId);
      assert.match(correction.metadata.sourceContext.correction.failureReason, /Inbox route/);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns 409 instead of queuing correction work for nonterminal jobs", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-task-review-loop-active-"));
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
        task: "Still running task route bundle",
        workflow: "standard",
        dataRoot,
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/tasks/proj/jobs/${job.jobId}/review-bundle/reject`,
        payload: {
          actor: "tester",
          feedback: "Should wait for terminal state.",
        },
      });
      assert.equal(response.statusCode, 409);
      const body = JSON.parse(response.body);
      assert.equal(body.code, "REVIEW_JOB_NOT_TERMINAL");

      const entries = await listQueue(hubRoot);
      assert.equal(entries.length, 0);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns 404 for missing review bundle jobs", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-task-review-loop-missing-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const dataRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: dataRoot });

      const response = await app.inject({
        method: "POST",
        url: "/api/tasks/proj/jobs/job-does-not-exist/review-bundle/accept",
        payload: { actor: "tester" },
      });
      assert.equal(response.statusCode, 404);
      const body = JSON.parse(response.body);
      assert.equal(body.code, "REVIEW_JOB_NOT_FOUND");
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
