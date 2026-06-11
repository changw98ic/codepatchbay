import path from "node:path";

import { listJobsAcrossRuntimeRoots } from "../services/job/job-store.js";
import { jobToQueueRow, jobToPipelineState } from "../services/job/job-projection.js";
import { listQueue } from "../services/hub/hub-queue.js";
import { listSessions, getSession } from "../services/review/review-session.js";
import { buildReviewBundle } from "../services/review/review-session.js";
import { acceptReviewBundle, rejectReviewBundle, isReviewLoopError } from "../services/review/review-session.js";
import { resolveProjectDataRoot } from "../services/runtime.js";
import { runtimeDataRoot } from "../services/runtime.js";
import { getProject } from "../services/hub/hub-registry.js";
import { broadcast } from "../services/infra.js";
import { buildAttentionProjection } from "../services/hub/hub-registry.js";
import { collectRuntimeHealth } from "../services/runtime.js";

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 };
type LooseRecord = Record<string, any>;

function sendReviewLoopError(reply, error) {
  if (!isReviewLoopError(error)) throw error;
  return reply.code(error.statusCode).send({ error: error.message, code: error.code });
}

function priorityForStatus(status) {
  if (["failed", "blocked"].includes(status)) return "P0";
  if (["running", "in_progress"].includes(status)) return "P1";
  return "P2";
}

function requestRowFromJob(job) {
  const row = jobToQueueRow(job);
  const priority = job.priority || priorityForStatus(row.status);
  return {
    id: row.jobId,
    type: "pipeline",
    project: row.project,
    task: row.task,
    status: row.status,
    rawStatus: row.rawStatus,
    priority,
    phase: row.phase,
    currentPhase: row.currentPhase,
    retryCount: row.retryCount,
    source: row.source,
    nextHumanAction: row.nextHumanAction,
    pr: row.pr,
    failureCode: row.failureCode,
    failurePhase: row.failurePhase,
    cancelRequested: row.cancelRequested,
    redirectContext: row.redirectContext,
    riskLevel: row.riskLevel,
    verificationDepth: row.verificationDepth,
    adversarialRequired: row.adversarialRequired,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    lastActivityMessage: row.lastActivityMessage,
  };
}

function requestRowFromQueueEntry(entry) {
  const riskMap = entry.metadata?.riskMap || entry.metadata?.riskmap || {};
  const status = entry.status === "in_progress" ? "running"
    : entry.status === "scheduled" ? "queued"
    : entry.status || "pending";
  const priority = entry.priority || priorityForStatus(status);
  return {
    id: entry.id,
    type: "queued",
    project: entry.projectId,
    task: entry.description || entry.metadata?.task,
    status,
    rawStatus: entry.status,
    priority,
    phase: null,
    currentPhase: null,
    retryCount: 0,
    source: { type: entry.metadata?.sourceType || "manual", label: entry.metadata?.sourceType || "Manual", issueNumber: null, repo: null, channel: null },
    nextHumanAction: null,
    pr: null,
    failureCode: null,
    failurePhase: null,
    cancelRequested: false,
    redirectContext: null,
    riskLevel: entry.metadata?.riskLevel ?? riskMap.riskLevel ?? null,
    verificationDepth: entry.metadata?.verificationDepth ?? riskMap.verificationDepth ?? null,
    adversarialRequired: entry.metadata?.adversarialRequired ?? riskMap.adversarialRequired ?? false,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastActivityAt: null,
    lastActivityMessage: null,
  };
}

function requestRowFromReview(session) {
  const statusMap = {
    idle: "queued", researching: "running", planning: "running", reviewing: "running",
    revising: "running", user_review: "blocked", dispatched: "running",
    completed: "completed", merge_failed: "failed", expired: "cancelled", cancelled: "cancelled",
  };
  const status = statusMap[session.status] || session.status;
  const priority = session.status === "user_review" ? "P0" : priorityForStatus(status);
  return {
    id: session.sessionId,
    type: "review",
    project: session.project,
    task: session.intent,
    status,
    rawStatus: session.status,
    priority,
    phase: session.status,
    currentPhase: session.status,
    retryCount: session.round || 0,
    source: { type: "review", label: "Review Session", issueNumber: null, repo: null, channel: null },
    nextHumanAction: session.status === "user_review" ? { kind: "approval", label: "Review and approve/reject" } : null,
    pr: null,
    failureCode: null,
    failurePhase: null,
    cancelRequested: false,
    redirectContext: null,
    riskLevel: null,
    verificationDepth: null,
    adversarialRequired: false,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastActivityAt: session.updatedAt,
    lastActivityMessage: null,
  };
}

export function inboxRoutes(fastify) {
  fastify.get("/inbox", async (req) => {
    const cpbRoot = req.cpbRoot;
    const hubRoot = req.cpbHubRoot;
    const { status, priority, project, type, limit, sort } = req.query;
    const attentionOnly = ["1", "true"].includes(String(req.query.attentionOnly || ""));

    const [jobs, queueEntries, reviews] = await Promise.all([
      listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []),
      hubRoot ? listQueue(hubRoot).catch(() => []) : [],
      listSessions(cpbRoot).catch(() => []),
    ]);

    const runtimeHealth = await resolveRuntimeHealth(req, cpbRoot);
    const attentionItems = buildAttentionProjection({
      jobs,
      queueEntries,
      reviews,
      runtimeHealth,
    });
    const allRows = attentionOnly
      ? attentionRows(attentionItems)
      : attachAttention(buildRequestRows(jobs, queueEntries, reviews), attentionItems);
    let rows = [...allRows];

    if (status) {
      const statuses = new Set(status.split(","));
      rows = rows.filter((r) => statuses.has(r.status));
    }
    if (priority) {
      const priorities = new Set(priority.split(","));
      rows = rows.filter((r) => priorities.has(r.priority));
    }
    if (project) {
      const projects = new Set(project.split(","));
      rows = rows.filter((r) => r.project && projects.has(r.project));
    }
    if (type) {
      const types = new Set(type.split(","));
      rows = rows.filter((r) => types.has(r.type));
    }

    if (!attentionOnly) rows = sortRequestRows(rows, sort);

    const total = rows.length;
    const projects = [...new Set(allRows.map((r) => r.project).filter(Boolean))].sort();
    const statusCounts = {};
    for (const r of rows) {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    }
    const maxLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 200));
    rows = rows.slice(0, maxLimit);

    return { items: rows, projects, statusCounts, total };
  });

  fastify.get("/inbox/:requestId", async (req, reply) => {
    const cpbRoot = req.cpbRoot;
    const hubRoot = req.cpbHubRoot;
    const { requestId } = req.params;

    // Try job first (most common case)
    const allJobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []);
    const job = allJobs.find((j) => j.jobId === requestId);
    if (job) {
      const row = jobToQueueRow(job);
      const pipelineState = jobToPipelineState(job);
      const retryChain = buildRetryChain(allJobs, job);
      const reviewBundle = await buildInboxReviewBundle(cpbRoot, hubRoot, job);
      const artifacts = artifactsFromReviewBundle(reviewBundle);

      return {
        id: job.jobId,
        type: "pipeline",
        project: job.project,
        task: job.task,
        status: row.status,
        rawStatus: row.rawStatus,
        priority: job.priority || priorityForStatus(row.status),
        source: row.source,
        nextHumanAction: row.nextHumanAction,
        pr: row.pr,
        pipelineState,
        retryChain,
        reviewBundle,
        reviewLoop: job.reviewLoop || { rounds: [], latest: null },
        plan: artifacts.plan?.content || null,
        deliverable: artifacts.deliverable?.content || null,
        verdict: artifacts.verdict?.parsed || null,
        artifacts,
        workflow: job.workflow || "standard",
        retryCount: row.retryCount,
        failureCode: row.failureCode,
        failurePhase: row.failurePhase,
        cancelRequested: row.cancelRequested,
        redirectContext: row.redirectContext,
        riskLevel: row.riskLevel,
        verificationDepth: row.verificationDepth,
        adversarialRequired: row.adversarialRequired,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        lastActivityAt: row.lastActivityAt,
        lastActivityMessage: row.lastActivityMessage,
      };
    }

    // Try queue entry
    if (hubRoot) {
      const queueEntries = await listQueue(hubRoot).catch(() => []);
      const entry = queueEntries.find((e) => e.id === requestId);
      if (entry) {
        const queueRow = requestRowFromQueueEntry(entry);
        return {
          ...queueRow,
          metadata: entry.metadata || {},
        };
      }
    }

    // Try review session
    const session = await getSession(cpbRoot, requestId);
    if (session) {
      const reviewRow = requestRowFromReview(session);
      return {
        ...reviewRow,
        research: session.research,
        plan: session.plan,
        reviewRounds: (session.reviews || []).map((r) => ({
          round: r.round,
          codex: r.codex || null,
          claude: r.claude || null,
          issues: (r.codexIssues || []).concat(r.claudeIssues || []).map((i) => ({
            severity: i.severity || "minor",
            description: i.description || "",
            file: i.file || null,
            line: i.line || null,
          })),
        })),
        budget: session.budget,
        userVerdict: session.userVerdict,
      };
    }

    return reply.code(404).send({ error: "Request not found" });
  });

  fastify.post("/inbox/:requestId/review-bundle/accept", async (req, reply) => {
    const cpbRoot = req.cpbRoot;
    const hubRoot = req.cpbHubRoot;
    const { requestId } = req.params;
    const { actor = "inbox", feedback = "" } = req.body || {};

    const allJobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []);
    const job = allJobs.find((j) => j.jobId === requestId);
    if (!job) return reply.code(404).send({ error: "Request not found" });

    const dataRoot = await resolveProjectDataRoot(cpbRoot, job.project, {
      hubRoot,
      dataRoot: job.dataRoot || null,
    });
    let result;
    try {
      result = await acceptReviewBundle(cpbRoot, job.project, job.jobId, {
        actor,
        feedback,
        dataRoot,
      } as LooseRecord);
    } catch (error) {
      return sendReviewLoopError(reply, error);
    }
    broadcast({ type: "review_bundle:accepted", project: job.project, jobId: job.jobId, round: result.round });
    return result;
  });

  fastify.post("/inbox/:requestId/review-bundle/reject", async (req, reply) => {
    const cpbRoot = req.cpbRoot;
    const hubRoot = req.cpbHubRoot;
    const { requestId } = req.params;
    const { actor = "inbox", feedback = "" } = req.body || {};
    if (!String(feedback || "").trim()) return reply.code(400).send({ error: "feedback required" });
    if (!hubRoot) return reply.code(400).send({ error: "hubRoot required" });

    const allJobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []);
    const job = allJobs.find((j) => j.jobId === requestId);
    if (!job) return reply.code(404).send({ error: "Request not found" });

    const project = await getProject(hubRoot, job.project).catch(() => null);
    const dataRoot = await resolveProjectDataRoot(cpbRoot, job.project, {
      hubRoot,
      dataRoot: job.dataRoot || project?.projectRuntimeRoot || null,
    });
    let result;
    try {
      result = await rejectReviewBundle(cpbRoot, job.project, job.jobId, {
        actor,
        feedback,
        hubRoot,
        sourcePath: project?.sourcePath || job.sourcePath || null,
        dataRoot,
      } as LooseRecord);
    } catch (error) {
      return sendReviewLoopError(reply, error);
    }
    broadcast({
      type: "review_bundle:rejected",
      project: job.project,
      jobId: job.jobId,
      round: result.round,
      retryQueueEntryId: result.retryQueueEntry?.id,
    });
    return result;
  });

  fastify.get("/inbox/projects", async (req) => {
    const cpbRoot = req.cpbRoot;
    const hubRoot = req.cpbHubRoot;

    const [jobs, queueEntries, reviews] = await Promise.all([
      listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []),
      hubRoot ? listQueue(hubRoot).catch(() => []) : [],
      listSessions(cpbRoot).catch(() => []),
    ]);

    const projectMap = new Map();

    function ensure(name) {
      if (!name) return;
      if (!projectMap.has(name)) {
        projectMap.set(name, { name, counts: { total: 0, running: 0, failed: 0, blocked: 0, completed: 0, queued: 0 } });
      }
    }

    function bump(name, status) {
      ensure(name);
      const p = projectMap.get(name);
      p.counts.total++;
      const key = status === "in_progress" ? "running"
        : status === "scheduled" ? "queued"
        : ["completed", "failed", "blocked", "running", "queued"].includes(status) ? status : "queued";
      if (p.counts[key] !== undefined) p.counts[key]++;
    }

    for (const j of jobs) bump(j.project, j.status);
    for (const e of queueEntries) bump(e.projectId, e.status);
    for (const s of reviews) bump(s.project, s.status === "user_review" ? "blocked" : s.status);

    return { projects: [...projectMap.values()] };
  });
}

function buildRequestRows(jobs, queueEntries, reviews) {
  const rows = [];
  for (const job of jobs) rows.push(requestRowFromJob(job));

  const jobIds = new Set(jobs.map((j) => j.jobId));
  for (const entry of queueEntries) {
    if (!entry.id || jobIds.has(entry.id)) continue;
    rows.push(requestRowFromQueueEntry(entry));
  }

  for (const session of reviews) {
    if (!session.sessionId) continue;
    rows.push(requestRowFromReview(session));
  }
  return rows;
}

async function resolveRuntimeHealth(req, cpbRoot) {
  if (req.runtimeHealth) return req.runtimeHealth;
  return collectRuntimeHealth({
    cpbRoot,
    executorRoot: req.cpbExecutorRoot || cpbRoot,
  }).catch(() => null);
}

function attentionRows(attentionItems) {
  return attentionItems.map((attention) => ({
    id: attention.id,
    type: "attention",
    project: attention.project,
    task: attention.title,
    status: "attention",
    rawStatus: attention.kind,
    priority: attention.severity === "critical" ? "P0" : attention.severity === "warning" ? "P1" : "P2",
    phase: null,
    currentPhase: null,
    retryCount: 0,
    source: { type: "attention", label: attention.kind.replace(/_/g, " "), issueNumber: null, repo: null, channel: null },
    nextHumanAction: null,
    pr: null,
    failureCode: attention.kind,
    failurePhase: null,
    cancelRequested: false,
    redirectContext: null,
    riskLevel: null,
    verificationDepth: null,
    adversarialRequired: false,
    createdAt: attention.updatedAt,
    updatedAt: attention.updatedAt,
    lastActivityAt: attention.updatedAt,
    lastActivityMessage: attention.reason,
    attention,
  }));
}

function attachAttention(rows, attentionItems) {
  const byEvidence = new Map();
  for (const attention of attentionItems) {
    for (const entry of attention.evidence || []) {
      const baseId = String(entry.id || "").split(":")[0];
      if (!baseId || byEvidence.has(baseId)) continue;
      byEvidence.set(baseId, attention);
    }
  }
  return rows.map((row) => ({
    ...row,
    ...(byEvidence.has(row.id) ? { attention: byEvidence.get(row.id) } : {}),
  }));
}

function sortRequestRows(rows, sort) {
  const sortField = sort === "oldest" ? "createdAt" : "updatedAt";
  return [...rows].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 9;
    const pb = PRIORITY_ORDER[b.priority] ?? 9;
    if (pa !== pb) return pa - pb;
    const ta = a[sortField] ? new Date(a[sortField]).getTime() : 0;
    const tb = b[sortField] ? new Date(b[sortField]).getTime() : 0;
    return sort === "oldest" ? (ta - tb) : (tb - ta);
  });
}

async function buildInboxReviewBundle(cpbRoot, hubRoot, job) {
  try {
    const dataRoot = await resolveProjectDataRoot(cpbRoot, job.project, {
      hubRoot,
      dataRoot: job.dataRoot || null,
    });
    const wikiDir = job.wikiDir || runtimeWikiDirFor(cpbRoot, dataRoot);
    const bundle = await buildReviewBundle(cpbRoot, job.project, job.jobId, {
      dataRoot,
      wikiDir,
      worktreePath: job.worktree || null,
    });
    return {
      schemaVersion: bundle.schemaVersion,
      bundleType: bundle.bundleType,
      generatedAt: bundle.generatedAt,
      status: bundle.status,
      links: bundle.links || { eventLog: null, artifacts: [] },
      artifacts: bundle.links?.artifacts || [],
      evidence: {
        plan: bundle.evidence?.plan
          ? { path: bundle.evidence.plan.path, content: bundle.evidence.plan.content }
          : null,
        deliverable: bundle.evidence?.deliverable
          ? { path: bundle.evidence.deliverable.path, content: bundle.evidence.deliverable.content }
          : null,
        verdict: bundle.evidence?.verdict || null,
        review: bundle.evidence?.review || null,
        diffStat: bundle.evidence?.diffStat || null,
        changedFiles: bundle.evidence?.changedFiles || [],
      },
      timeline: bundle.timeline || [],
    };
  } catch (err) {
    return {
      error: err.message || "review bundle unavailable",
      links: { eventLog: null, artifacts: [] },
      artifacts: [],
      evidence: {
        plan: null,
        deliverable: null,
        verdict: null,
        review: null,
        diffStat: null,
        changedFiles: [],
      },
      timeline: [],
    };
  }
}

function runtimeWikiDirFor(cpbRoot, dataRoot) {
  if (!dataRoot) return null;
  const resolvedDataRoot = path.resolve(dataRoot);
  if (resolvedDataRoot === path.resolve(runtimeDataRoot(cpbRoot))) return null;
  return path.join(resolvedDataRoot, "wiki");
}

function artifactsFromReviewBundle(bundle) {
  const artifactByKind = new Map<string, LooseRecord>((bundle?.artifacts || []).map((artifact) => [artifact.kind, artifact]));
  return {
    plan: bundle?.evidence?.plan
      ? { ...(artifactByKind.get("plan") || {}), path: bundle.evidence.plan.path, content: bundle.evidence.plan.content }
      : null,
    deliverable: bundle?.evidence?.deliverable
      ? { ...(artifactByKind.get("deliverable") || {}), path: bundle.evidence.deliverable.path, content: bundle.evidence.deliverable.content }
      : null,
    verdict: bundle?.evidence?.verdict
      ? { ...(artifactByKind.get("verdict") || {}), parsed: bundle.evidence.verdict }
      : null,
    review: bundle?.evidence?.review
      ? { ...(artifactByKind.get("review") || {}), content: bundle.evidence.review }
      : null,
  };
}

function buildRetryChain(allJobs, job) {
  const byId = new Map(allJobs.map((j) => [j.jobId, j]));
  let root = job;

  while (root.lineage?.parentJobId) {
    const parent = byId.get(root.lineage.parentJobId);
    if (!parent) break;
    root = parent;
  }

  const chain = [];
  const seen = new Set();
  function visit(current) {
    if (!current?.jobId || seen.has(current.jobId)) return;
    seen.add(current.jobId);
    chain.push(current);
    const children = allJobs
      .filter((j) => j.lineage?.parentJobId === current.jobId)
      .sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
    for (const child of children) visit(child);
  }
  visit(root);

  return chain.map((j) => ({
    jobId: j.jobId,
    status: j.status,
    phase: j.phase,
    failureCode: j.failureCode || null,
    failurePhase: j.failurePhase || null,
    retryCount: j.retryCount || 0,
    attempt: j.attempt || null,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    isCurrent: j.jobId === job.jobId,
  }));
}
