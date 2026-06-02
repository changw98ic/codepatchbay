import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sensible from "@fastify/sensible";

import { inboxRoutes } from "../server/routes/inbox.js";
import { registerProject } from "../server/services/hub-registry.js";
import { createJob, failJob, completeJob, completePhase, retryJob, FAILURE_CODES } from "../server/services/job-store.js";

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

  it("GET /inbox keeps project options and counts independent from limit", async () => {
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
        task: "Newest task",
        workflow: "standard",
        ts: "2026-06-02T00:02:00.000Z",
        dataRoot: runtimeRootA,
      });
      await createJob(cpbRoot, {
        project: "proj-b",
        task: "Older task",
        workflow: "standard",
        ts: "2026-06-02T00:01:00.000Z",
        dataRoot: runtimeRootB,
      });

      const res = await app.inject({ method: "GET", url: "/api/inbox?limit=1" });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.items.length, 1);
      assert.equal(body.total, 2);
      assert.ok(body.projects.includes("proj-a"));
      assert.ok(body.projects.includes("proj-b"));
      const counted = Object.values(body.statusCounts).reduce((sum, count) => sum + count, 0);
      assert.equal(counted, 2);
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

  it("GET /inbox/:requestId returns pipeline artifact drill-down content", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const wikiInbox = path.join(runtimeRoot, "wiki", "inbox");
    const wikiOutputs = path.join(runtimeRoot, "wiki", "outputs");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await mkdir(wikiInbox, { recursive: true });
      await mkdir(wikiOutputs, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });

      const job = await createJob(cpbRoot, {
        project: "proj",
        task: "Artifact detail test",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });
      await writeFile(path.join(wikiInbox, "plan-001.md"), "# Plan\n\nBuild the thing.", "utf8");
      await writeFile(path.join(wikiOutputs, "deliverable-001.md"), "# Deliverable\n\nChanged src/app.js.", "utf8");
      await writeFile(path.join(wikiOutputs, "verdict-001.md"), JSON.stringify({ status: "pass", reason: "Looks good." }), "utf8");
      await completePhase(cpbRoot, "proj", job.jobId, { phase: "plan", artifact: "plan-001", dataRoot: runtimeRoot });
      await completePhase(cpbRoot, "proj", job.jobId, { phase: "execute", artifact: "deliverable-001", dataRoot: runtimeRoot });
      await completePhase(cpbRoot, "proj", job.jobId, { phase: "verify", artifact: "verdict-001", dataRoot: runtimeRoot });
      await completeJob(cpbRoot, "proj", job.jobId, { dataRoot: runtimeRoot });

      const res = await app.inject({ method: "GET", url: `/api/inbox/${job.jobId}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.match(body.plan, /Build the thing/);
      assert.match(body.deliverable, /Changed src\/app\.js/);
      assert.equal(body.artifacts.plan.path, path.join(wikiInbox, "plan-001.md"));
      assert.match(body.artifacts.plan.content, /Build the thing/);
      assert.equal(body.artifacts.deliverable.path, path.join(wikiOutputs, "deliverable-001.md"));
      assert.match(body.artifacts.deliverable.content, /Changed src\/app\.js/);
      assert.equal(body.artifacts.verdict.path, path.join(wikiOutputs, "verdict-001.md"));
      assert.equal(body.artifacts.verdict.parsed.status, "pass");
      assert.ok(body.reviewBundle);
      assert.equal(body.reviewBundle.bundleType, "local_review");
      assert.ok(body.reviewBundle.links.artifacts.some((entry) => entry.kind === "plan"));
    } finally {
      await app.close();
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("GET /inbox/:requestId returns full multi-level retry lineage", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cpb-inbox-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const hubRoot = path.join(tmpRoot, "hub");
    const sourcePath = path.join(tmpRoot, "source");
    const runtimeRoot = path.join(tmpRoot, "runtime", "proj");
    const app = await buildApp({ cpbRoot, hubRoot });

    try {
      await mkdir(sourcePath, { recursive: true });
      await registerProject(hubRoot, { id: "proj", sourcePath, projectRuntimeRoot: runtimeRoot });

      const first = await createJob(cpbRoot, {
        project: "proj",
        task: "Retry lineage test",
        workflow: "standard",
        dataRoot: runtimeRoot,
      });
      await failJob(cpbRoot, "proj", first.jobId, {
        reason: "first failure",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "execute",
        dataRoot: runtimeRoot,
      });
      const second = await retryJob(cpbRoot, "proj", first.jobId, { dataRoot: runtimeRoot, ts: "2026-06-02T00:01:00.000Z" });
      await failJob(cpbRoot, "proj", second.jobId, {
        reason: "second failure",
        code: FAILURE_CODES.RECOVERABLE,
        phase: "verify",
        dataRoot: runtimeRoot,
      });
      const third = await retryJob(cpbRoot, "proj", second.jobId, { dataRoot: runtimeRoot, ts: "2026-06-02T00:02:00.000Z" });

      const res = await app.inject({ method: "GET", url: `/api/inbox/${first.jobId}` });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.retryChain.map((entry) => entry.jobId), [first.jobId, second.jobId, third.jobId]);
      assert.deepEqual(body.retryChain.map((entry) => entry.isCurrent), [true, false, false]);
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
