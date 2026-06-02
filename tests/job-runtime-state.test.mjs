import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { taskRoutes } from "../server/routes/tasks.js";
import { readEvents } from "../server/services/event-store.js";
import { registerProject } from "../server/services/hub-registry.js";
import {
  createJob,
  failJob,
  FAILURE_CODES,
  getJob,
  listJobs,
  retryJob,
  startPhase,
} from "../server/services/job-store.js";

async function withRuntimeRoot(testFn) {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-runtime-state-"));
  const cpbRoot = path.join(tmpRoot, "cpb");
  const hubRoot = path.join(tmpRoot, "hub");
  const sourcePath = path.join(tmpRoot, "source");
  const dataRoot = path.join(tmpRoot, "runtime", "proj");

  try {
    await mkdir(sourcePath, { recursive: true });
    await registerProject(hubRoot, {
      id: "proj",
      sourcePath,
      projectRuntimeRoot: dataRoot,
    });
    return await testFn({ tmpRoot, cpbRoot, hubRoot, sourcePath, dataRoot });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function buildApp({ cpbRoot, hubRoot }) {
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

function findListedJob(jobs, jobId) {
  return jobs.find((job) => job.jobId === jobId);
}

describe("job runtime state projection", () => {
  it("terminally cancels HTTP task cancel requests and keeps the job index in sync", async () => {
    await withRuntimeRoot(async ({ cpbRoot, hubRoot, dataRoot }) => {
      const app = await buildApp({ cpbRoot, hubRoot });
      try {
        const job = await createJob(cpbRoot, {
          project: "proj",
          task: "cancel me",
          workflow: "standard",
          dataRoot,
        });
        await startPhase(cpbRoot, "proj", job.jobId, {
          phase: "execute",
          leaseId: "lease-cancel",
          dataRoot,
        });

        const response = await app.inject({
          method: "POST",
          url: "/api/tasks/proj/cancel",
          payload: { jobId: job.jobId, reason: "user asked" },
        });

        assert.equal(response.statusCode, 200);
        const body = JSON.parse(response.body);
        assert.equal(body.status, "cancelled");
        assert.equal(body.cancelRequested, true);
        assert.equal(body.cancelReason, "user asked");
        assert.equal(body.leaseId, null);

        const fromGet = await getJob(cpbRoot, "proj", job.jobId, { dataRoot });
        assert.equal(fromGet.status, "cancelled");

        const fromList = findListedJob(await listJobs(cpbRoot, { project: "proj", dataRoot }), job.jobId);
        assert.equal(fromList?.status, "cancelled");
        assert.equal(fromList?.cancelReason, "user asked");
      } finally {
        await app.close();
      }
    });
  });

  it("preserves recovery retry budget and enforces the inherited maxRetries limit", async () => {
    await withRuntimeRoot(async ({ cpbRoot, dataRoot }) => {
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "retry me",
        workflow: "standard",
        dataRoot,
      });
      await failJob(cpbRoot, "proj", job.jobId, {
        reason: "recoverable failure",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot,
      });

      const recovery = await retryJob(cpbRoot, "proj", job.jobId, {
        maxRetries: 1,
        dataRoot,
      });

      assert.equal(recovery.recoveryOf, job.jobId);
      assert.equal(recovery.lineage.parentJobId, job.jobId);
      assert.equal(recovery.retryCount, 1);
      assert.equal(recovery.maxRetries, 1);

      await failJob(cpbRoot, "proj", recovery.jobId, {
        reason: "still failing",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot,
      });

      await assert.rejects(
        () => retryJob(cpbRoot, "proj", recovery.jobId, { dataRoot }),
        /retry limit exceeded: 2\/1/,
      );
    });
  });

  it("records pool exhaustion through an authoritative terminal path with checkpoint and index parity", async () => {
    await withRuntimeRoot(async ({ cpbRoot, dataRoot }) => {
      const { poolExhaustedJob } = await import("../server/services/job-store.js");
      assert.equal(typeof poolExhaustedJob, "function");

      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "pool me",
        workflow: "standard",
        dataRoot,
      });
      await startPhase(cpbRoot, "proj", job.jobId, {
        phase: "execute",
        leaseId: "lease-pool",
        dataRoot,
      });

      const ts = "2026-06-02T04:00:00.000Z";
      const failed = await poolExhaustedJob(cpbRoot, "proj", job.jobId, {
        reason: "ACP pool exhausted",
        providerKey: "codex",
        agent: "codex",
        elapsedMs: 42,
        phase: "execute",
        ts,
        dataRoot,
      });

      assert.equal(failed.status, "failed");
      assert.equal(failed.failureCode, "pool_exhausted");
      assert.equal(failed.failurePhase, "execute");
      assert.equal(failed.retryable, true);
      assert.equal(failed.updatedAt, ts);

      const fromGet = await getJob(cpbRoot, "proj", job.jobId, { dataRoot });
      assert.equal(fromGet.status, "failed");
      assert.equal(fromGet.failureCode, "pool_exhausted");

      const fromList = findListedJob(await listJobs(cpbRoot, { project: "proj", dataRoot }), job.jobId);
      assert.equal(fromList?.status, "failed");
      assert.equal(fromList?.failureCode, "pool_exhausted");

      const events = await readEvents(cpbRoot, "proj", job.jobId, { dataRoot });
      const poolEvent = events.find((event) => event.type === "pool_exhausted");
      assert.equal(poolEvent?.ts, ts);
      assert.equal(poolEvent?.timestamp, undefined);
    });
  });
});
