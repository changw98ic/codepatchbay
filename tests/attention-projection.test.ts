import assert from "node:assert/strict";
import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { test } from "node:test";

import { appendEvent } from "../server/services/event-store.js";
import { createJob, failJob } from "../server/services/job-store.js";
import { enqueue, updateEntry } from "../server/services/hub-queue.js";
import { rebuildJobsIndex } from "../server/services/jobs-index.js";
import { inboxRoutes } from "../server/routes/inbox.js";
import { hubRoutes } from "../server/routes/hub.js";
import { buildAttentionProjection } from "../server/services/attention-projection.js";
import { createSession, updateSession } from "../server/services/review-session.js";
import { tempRoot } from "./helpers.js";

async function makeApp(route, { cpbRoot, hubRoot, runtimeHealth = null }) {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.addHook("onRequest", (req, _reply, done) => {
    const request = req as typeof req & Record<string, any>;
    request.cpbRoot = cpbRoot;
    request.cpbHubRoot = hubRoot;
    request.runtimeHealth = runtimeHealth;
    done();
  });
  await app.register(route);
  await app.ready();
  return app;
}

function bodyOf(response) {
  return JSON.parse(response.body);
}

test("buildAttentionProjection ranks by severity, kind, age, priority, and id", () => {
  const items = buildAttentionProjection({
    jobs: [
      {
        jobId: "job-workflow-newer",
        project: "proj-a",
        task: "newer failed workflow",
        status: "failed",
        priority: "P0",
        failureCode: "FATAL",
        updatedAt: "2026-06-11T12:00:00.000Z",
      },
      {
        jobId: "job-workflow-older",
        project: "proj-a",
        task: "older failed workflow",
        status: "failed",
        priority: "P2",
        failureCode: "FATAL",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
      {
        jobId: "job-dag-failed",
        project: "proj-a",
        task: "failed dag node",
        status: "running",
        priority: "P0",
        failureCode: "node_error",
        failurePhase: "verify",
        updatedAt: "2026-06-10T09:00:00.000Z",
        nodeStates: {
          verify: {
            status: "failed",
            phase: "verify",
            reason: "verification failed",
            failedAt: "2026-06-10T09:00:00.000Z",
          },
        },
      },
    ],
    queueEntries: [
      {
        id: "queue-rate-limit",
        projectId: "proj-b",
        description: "rate limited queue item",
        status: "agent_rate_limited",
        priority: "P1",
        updatedAt: "2026-06-09T10:00:00.000Z",
      },
      {
        id: "queue-codegraph",
        projectId: "proj-b",
        description: "codegraph blocked queue item",
        status: "codegraph_unavailable",
        priority: "P1",
        updatedAt: "2026-06-11T11:00:00.000Z",
      },
      {
        id: "queue-approval",
        projectId: "proj-c",
        description: "approval queue item",
        status: "waiting_approval",
        priority: "P0",
        updatedAt: "2026-06-08T10:00:00.000Z",
      },
    ],
    reviews: [
      {
        sessionId: "review-ready",
        project: "proj-d",
        intent: "review completed work",
        status: "user_review",
        updatedAt: "2026-06-07T10:00:00.000Z",
      },
    ],
    runtimeHealth: {
      queueBlockingCounts: { codegraph_unavailable: 2, agent_rate_limited: 3 },
      jobsIndexDivergence: { count: 4, severity: "warning" },
      staleJobs: 2,
      warnings: [{ code: "release_version_mismatch", message: "runtime release is stale" }],
    },
  });

  assert.deepEqual(items.map((item) => item.kind), [
    "stale_runtime",
    "jobs_index_divergent",
    "codegraph_unavailable",
    "codegraph_unavailable",
    "agent_rate_limited",
    "agent_rate_limited",
    "workflow_failed",
    "workflow_failed",
    "dag_node_failed",
    "waiting_approval",
    "review_ready",
  ]);
  assert.equal(items.find((item) => item.kind === "jobs_index_divergent").severity, "warning");
  assert.deepEqual(
    items.filter((item) => item.kind === "workflow_failed").map((item) => item.id),
    ["proj-a:workflow_failed:job-workflow-older", "proj-a:workflow_failed:job-workflow-newer"],
  );
});

test("buildAttentionProjection dedupes queue and job evidence for the same work", () => {
  const [item] = buildAttentionProjection({
    jobs: [
      {
        jobId: "job-shared-1",
        queueEntryId: "queue-shared-1",
        project: "proj-a",
        task: "shared work",
        status: "blocked",
        priority: "P0",
        failureCode: "codegraph_unavailable",
        updatedAt: "2026-06-11T09:00:00.000Z",
      },
    ],
    queueEntries: [
      {
        id: "queue-shared-1",
        projectId: "proj-a",
        description: "shared work",
        status: "codegraph_unavailable",
        priority: "P1",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
    ],
    reviews: [],
    runtimeHealth: null,
  });

  assert.equal(item.kind, "codegraph_unavailable");
  assert.deepEqual(item.evidence.map((evidence) => evidence.type).sort(), ["job", "queue"]);
  assert.equal(item.severity, "critical");
});

test("buildAttentionProjection recognizes dotted waiting.approval statuses", () => {
  const items = buildAttentionProjection({
    jobs: [
      {
        jobId: "job-approval",
        project: "proj-a",
        task: "job approval",
        status: "waiting.approval",
        updatedAt: "2026-06-11T09:00:00.000Z",
      },
    ],
    queueEntries: [
      {
        id: "queue-approval",
        projectId: "proj-b",
        description: "queue approval",
        status: "waiting.approval",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
    ],
    reviews: [],
    runtimeHealth: null,
  });

  assert.deepEqual(items.map((item) => item.kind), ["waiting_approval", "waiting_approval"]);
  assert.deepEqual(items.map((item) => item.id), [
    "proj-a:waiting_approval:job-approval",
    "proj-b:waiting_approval:queue-approval",
  ]);
});

test("inbox attentionOnly projects dotted waiting.approval jobs and queue entries", async () => {
  const cpbRoot = await tempRoot("cpb-attention-approval-cpb");
  const hubRoot = await tempRoot("cpb-attention-approval-hub");

  await createJob(cpbRoot, {
    project: "proj-approval",
    task: "job approval",
    jobId: "job-approval",
    ts: "2026-06-11T08:00:00.000Z",
  });
  await appendEvent(cpbRoot, "proj-approval", "job-approval", {
    type: "approval_required",
    jobId: "job-approval",
    project: "proj-approval",
    phase: "execute",
    reason: "needs approval",
    ts: "2026-06-11T09:00:00.000Z",
  });
  await rebuildJobsIndex(cpbRoot);

  const queueEntry = await enqueue(hubRoot, {
    projectId: "proj-queue-approval",
    description: "queue approval",
    priority: "P1",
  });
  await updateEntry(hubRoot, queueEntry.id, {
    status: "waiting.approval",
    updatedAt: "2026-06-11T10:00:00.000Z",
  });

  const app = await makeApp(inboxRoutes, {
    cpbRoot,
    hubRoot,
    runtimeHealth: { jobsIndexDivergence: { count: 0, severity: "ok" }, staleJobs: 0, queueBlockingCounts: {} },
  });

  const body = bodyOf(await app.inject({ method: "GET", url: "/inbox?attentionOnly=1&limit=10" }));
  const approvalRows = body.items.filter((item) => item.attention?.kind === "waiting_approval");
  assert.equal(approvalRows.length, 2);
  assert.deepEqual(
    approvalRows.map((item) => item.attention.evidence[0].type).sort(),
    ["job", "queue"],
  );

  await app.close();
});

test("buildAttentionProjection does not promote non-blocking release metadata warnings to critical runtime attention", () => {
  const items = buildAttentionProjection({
    jobs: [],
    queueEntries: [],
    reviews: [],
    runtimeHealth: {
      queueBlockingCounts: {},
      jobsIndexDivergence: { count: 0, severity: "ok" },
      staleJobs: 0,
      blockers: [],
      warnings: [{ code: "launcher_release_unknown", message: "Launcher release metadata is not available" }],
    },
  });

  assert.equal(items.some((item) => item.kind === "stale_runtime"), false);
});

test("buildAttentionProjection uses lexical id as final tie-break", () => {
  const items = buildAttentionProjection({
    jobs: [
      {
        jobId: "b-failed",
        project: "proj-a",
        task: "b",
        status: "failed",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
      {
        jobId: "a-failed",
        project: "proj-a",
        task: "a",
        status: "failed",
        updatedAt: "2026-06-11T10:00:00.000Z",
      },
    ],
    queueEntries: [],
    reviews: [],
    runtimeHealth: null,
  });

  assert.deepEqual(items.map((item) => item.id), [
    "proj-a:workflow_failed:a-failed",
    "proj-a:workflow_failed:b-failed",
  ]);
});

test("inbox attentionOnly returns canonical attention rows and preserves legacy nextHumanAction otherwise", async () => {
  const cpbRoot = await tempRoot("cpb-attention-inbox-cpb");
  const hubRoot = await tempRoot("cpb-attention-inbox-hub");

  await createJob(cpbRoot, {
    project: "proj-failed",
    task: "failed job",
    jobId: "job-failed",
    ts: "2026-06-11T08:00:00.000Z",
  });
  await failJob(cpbRoot, "proj-failed", "job-failed", {
    reason: "boom",
    code: "FATAL",
    phase: "execute",
    ts: "2026-06-11T09:00:00.000Z",
  });

  const queueEntry = await enqueue(hubRoot, {
    projectId: "proj-queue",
    description: "queue is waiting",
    priority: "P1",
  });
  await updateEntry(hubRoot, queueEntry.id, {
    status: "codegraph_unavailable",
    updatedAt: "2026-06-11T07:00:00.000Z",
  });

  const runtimeHealth = {
    staleJobs: 1,
    jobsIndexDivergence: { count: 2, severity: "warning" },
  };
  const app = await makeApp(inboxRoutes, { cpbRoot, hubRoot, runtimeHealth });

  const attention = bodyOf(await app.inject({ method: "GET", url: "/inbox?attentionOnly=1&limit=5" }));
  assert.deepEqual(attention.items.map((item) => item.attention.kind), [
    "stale_runtime",
    "jobs_index_divergent",
    "codegraph_unavailable",
    "workflow_failed",
  ]);
  assert.equal(attention.total, 4);
  const indexDivergenceRow = attention.items.find((item) => item.attention.kind === "jobs_index_divergent");
  assert.equal(indexDivergenceRow.attention.severity, "warning");
  assert.equal(indexDivergenceRow.attention.nextHumanAction.kind, "repair_runtime");
  assert.equal(indexDivergenceRow.nextHumanAction, null);

  const all = bodyOf(await app.inject({ method: "GET", url: "/inbox?limit=20" }));
  const failedRow = all.items.find((item) => item.id === "job-failed");
  assert.equal(failedRow.nextHumanAction.kind, "retry");
  assert.equal(failedRow.attention.kind, "workflow_failed");
  assert.equal(failedRow.attention.nextHumanAction.kind, "retry");

  await app.close();
});

test("inbox attaches dag_node_failed and review_ready attention without route-specific remapping", async () => {
  const cpbRoot = await tempRoot("cpb-attention-dag-cpb");
  const hubRoot = await tempRoot("cpb-attention-dag-hub");

  await createJob(cpbRoot, {
    project: "proj-dag",
    task: "dag work",
    jobId: "job-dag",
    ts: "2026-06-11T08:00:00.000Z",
  });
  await appendEvent(cpbRoot, "proj-dag", "job-dag", {
    type: "dag_node_failed",
    jobId: "job-dag",
    project: "proj-dag",
    nodeId: "verify",
    phase: "verify",
    reason: "verification failed",
    code: "VERIFY_FAILED",
    ts: "2026-06-11T09:00:00.000Z",
  });
  await failJob(cpbRoot, "proj-dag", "job-dag", {
    reason: "verification failed",
    code: "VERIFY_FAILED",
    phase: "verify",
    ts: "2026-06-11T09:01:00.000Z",
  });

  const review = await createSession(cpbRoot, { project: "proj-review", intent: "inspect patch" });
  await updateSession(cpbRoot, review.sessionId, { status: "user_review" }, { skipTransitionCheck: true });

  const app = await makeApp(inboxRoutes, { cpbRoot, hubRoot });
  const attention = bodyOf(await app.inject({ method: "GET", url: "/inbox?attentionOnly=1" }));

  const dag = attention.items.find((item) => item.attention.kind === "dag_node_failed");
  assert.equal(dag.id, "proj-dag:dag_node_failed:job-dag:verify");
  assert.equal(dag.attention.evidence[0].id, "job-dag:verify");

  const reviewReady = attention.items.find((item) => item.attention.kind === "review_ready");
  assert.equal(reviewReady.id, `proj-review:review_ready:${review.sessionId}`);
  assert.equal(reviewReady.attention.nextHumanAction.kind, "approve");

  await app.close();
});

test("hub dashboard summary delegates attention to the canonical projection", async () => {
  const cpbRoot = await tempRoot("cpb-attention-hub-cpb");
  const hubRoot = await tempRoot("cpb-attention-hub-hub");
  const runtimeHealth = {
    staleJobs: 1,
    queueBlockingCounts: { agent_rate_limited: 1 },
  };
  const app = await makeApp(hubRoutes, { cpbRoot, hubRoot, runtimeHealth });

  const summary = bodyOf(await app.inject({ method: "GET", url: "/hub/dashboard-summary?limit=5" }));
  assert.deepEqual(summary.attention.items.map((item) => item.kind), [
    "stale_runtime",
    "agent_rate_limited",
  ]);
  assert.equal(summary.attention.total, 2);
  assert.equal(summary.attention.countsBySeverity.critical, 1);

  await app.close();
});
