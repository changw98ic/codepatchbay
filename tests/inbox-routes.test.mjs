import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { inboxRoutes } from "../server/routes/inbox.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob, failJob, completeJob, FAILURE_CODES } from "../server/services/job-store.js";

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

describe("inboxRoutes", () => {
  it("GET /inbox returns empty list when no jobs exist", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      const res = await app.inject({ method: "GET", url: "/api/inbox" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.items.length, 0);
      assert.equal(body.total, 0);
      assert.ok(Array.isArray(body.projects));
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox returns jobs across projects", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePathA = path.join(tmpRoot, "source-a");
    const sourcePathB = path.join(tmpRoot, "source-b");
    const runtimeRootA = path.join(tmpRoot, "runtime", "proj-a");
    const runtimeRootB = path.join(tmpRoot, "runtime", "proj-b");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePathA, { recursive: true });
      await mkdir(sourcePathB, { recursive: true });
      await registerProject(hubRoot, { id: "proj-a", sourcePath: sourcePathA, projectRuntimeRoot: runtimeRootA });
      await registerProject(hubRoot, { id: "proj-b", sourcePath: sourcePathB, projectRuntimeRoot: runtimeRootB });

      await createJob(cpbRoot, {
        project: "proj-a",
        task: "Task A",
        workflow: "standard",
        dataRoot: runtimeRootA,
      });
      await createJob(cpbRoot, {
        project: "proj-b",
        task: "Task B",
        workflow: "standard",
        dataRoot: runtimeRootB,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.items.length, 2);
      assert.ok(body.items.some((r) => r.project === "proj-a"));
      assert.ok(body.items.some((r) => r.project === "proj-b"));
      assert.ok(body.projects.includes("proj-a"));
      assert.ok(body.projects.includes("proj-b"));
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox filters by status", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });

      const jobA = await createJob(cpbRoot, {
        project: "proj",
        task: "Running task",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });
      await failJob(cpbRoot, "proj", jobA.jobId, {
        reason: "test failure",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot: runtimeRoot,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox?status=failed" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].status, "failed");
      assert.equal(body.items[0].project, "proj");
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox filters by project", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });
      await createJob(cpbRoot, {
        project: "proj",
        task: "Task for proj",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox?project=proj" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.items.length >= 1);
      assert.ok(body.items.every((r) => r.project === "proj"));
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox/:requestId returns job detail with retry chain", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });

      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Detail test",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });

      const res = await app.inject({ method: "GET", url: `/api/inbox/${job.jobId}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.id, job.jobId);
      assert.equal(body.type, "pipeline");
      assert.equal(body.project, "proj");
      assert.equal(body.task, "Detail test");
      assert.ok(body.pipelineState);
      assert.ok(Array.isArray(body.retryChain));
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox/:requestId returns 404 for unknown id", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      const res = await app.inject({ method: "GET", url: "/api/inbox/nonexistent-id" });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox/projects returns per-project counts", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });
      await createJob(cpbRoot, {
        project: "proj",
        task: "Count test",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox/projects" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const proj = body.projects.find((p) => p.name === "proj");
      assert.ok(proj, "project should be listed");
      assert.ok(proj.counts.total >= 1);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox returns review sessions as review-type rows", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const reviewsDir = path.join(cpbRoot, "cpb-task", "reviews");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(reviewsDir, { recursive: true });
      const session = {
        sessionId: "rev-test-0001",
        project: "test-proj",
        intent: "Test review intent",
        status: "user_review",
        round: 2,
        reviews: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(reviewsDir, "rev-test-0001.json"),
        JSON.stringify(session),
      );

      const res = await app.inject({ method: "GET", url: "/api/inbox" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const reviewRow = body.items.find((r) => r.id === "rev-test-0001");
      assert.ok(reviewRow, "review row should exist");
      assert.equal(reviewRow.type, "review");
      assert.equal(reviewRow.project, "test-proj");
      assert.equal(reviewRow.task, "Test review intent");
      assert.equal(reviewRow.status, "blocked");
      assert.equal(reviewRow.priority, "P0");
      assert.equal(reviewRow.retryCount, 2);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox/:requestId returns review detail with rounds", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const reviewsDir = path.join(cpbRoot, "cpb-task", "reviews");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(reviewsDir, { recursive: true });
      const session = {
        sessionId: "rev-detail-0001",
        project: "proj-x",
        intent: "Check review detail",
        status: "user_review",
        round: 1,
        plan: "The plan is simple.",
        reviews: [
          { round: 1, codex: "looks fine", codexIssues: [{ severity: "minor", description: "nit" }] },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeFile(
        path.join(reviewsDir, "rev-detail-0001.json"),
        JSON.stringify(session),
      );

      const res = await app.inject({ method: "GET", url: "/api/inbox/rev-detail-0001" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.type, "review");
      assert.equal(body.plan, "The plan is simple.");
      assert.ok(Array.isArray(body.reviewRounds));
      assert.equal(body.reviewRounds.length, 1);
      assert.equal(body.reviewRounds[0].issues.length, 1);
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("priority assignment: failed jobs get P0, running P1, completed P2", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });

      const runningJob = await createJob(cpbRoot, {
        project: "proj",
        task: "Running task",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });

      const failedJob = await createJob(cpbRoot, {
        project: "proj",
        task: "Failed task",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });
      await failJob(cpbRoot, "proj", failedJob.jobId, {
        reason: "test",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot: runtimeRoot,
      });

      const completedJob = await createJob(cpbRoot, {
        project: "proj",
        task: "Completed task",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });
      await completeJob(cpbRoot, "proj", completedJob.jobId, {
        dataRoot: runtimeRoot,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);

      const failed = body.items.find((r) => r.status === "failed");
      const running = body.items.find((r) => r.status === "running" || r.status === "pending");
      const completed = body.items.find((r) => r.status === "completed" || r.status === "passed");

      if (failed) assert.equal(failed.priority, "P0");
      if (completed) assert.equal(completed.priority, "P2");
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
