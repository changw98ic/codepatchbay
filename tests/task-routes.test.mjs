import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { taskRoutes } from "../server/routes/tasks.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob, failJob, FAILURE_CODES } from "../server/services/job-store.js";

async function buildApp({ cpbRoot = "/tmp/cpb-test-root", hubRoot = "/tmp/cpb-test-hub" } = {}) {
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

describe("taskRoutes retry", () => {
  it("queues manual pipeline tasks with the current task body contract", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-task-routes-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath });

      const response = await app.inject({
        method: "POST",
        url: "/api/tasks/proj/pipeline",
        payload: {
          task: "Run a manual project pipeline",
          workflow: "standard",
          planMode: "full",
          autoFinalize: false,
        },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.queued, true);
      assert.equal(body.entry.projectId, "proj");
      assert.equal(body.entry.description, "Run a manual project pipeline");
      assert.equal(body.entry.metadata.autoFinalize, false);
      assert.equal(body.entry.metadata.planMode, "full");
      assert.equal(body.entry.metadata.issueUrl, null);
      assert.equal(body.entry.metadata.issueNumber, null);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("rejects retry job ids that do not use the CPB job id format", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tasks/proj/retry/not-a-job",
        payload: { force: true },
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Invalid job id/);
    } finally {
      await app.close();
    }
  });

  it("retries a failed job using the project runtime root", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-task-routes-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const projectRuntimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot });
      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "retry me",
        workflow: "standard",
        dataRoot: projectRuntimeRoot,
      });
      await failJob(cpbRoot, "proj", job.jobId, {
        reason: "recoverable failure",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot: projectRuntimeRoot,
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/tasks/proj/retry/${job.jobId}`,
        payload: { force: true },
      });

      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.recoveryOf, job.jobId);
      assert.equal(body.project, "proj");
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
