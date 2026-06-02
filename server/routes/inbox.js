import { listJobsAcrossRuntimeRoots, getJob } from "../services/job-store.js";
import { jobToQueueRow, jobToPipelineState } from "../services/job-projection.js";
import { listQueue } from "../services/hub-queue.js";
import { listSessions, getSession } from "../services/review-session.js";
import { listJobsFromIndex } from "../services/jobs-index.js";

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 };

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    lastActivityMessage: row.lastActivityMessage,
  };
}

function requestRowFromQueueEntry(entry) {
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

    const [jobs, queueEntries, reviews] = await Promise.all([
      listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot }).catch(() => []),
      hubRoot ? listQueue(hubRoot).catch(() => []) : [],
      listSessions(cpbRoot).catch(() => []),
    ]);

    let rows = [];

    for (const job of jobs) {
      rows.push(requestRowFromJob(job));
    }

    const jobIds = new Set(jobs.map((j) => j.jobId));
    for (const entry of queueEntries) {
      if (!entry.id || jobIds.has(entry.id)) continue;
      rows.push(requestRowFromQueueEntry(entry));
    }

    for (const session of reviews) {
      if (!session.sessionId) continue;
      rows.push(requestRowFromReview(session));
    }

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

    const sortField = sort === "oldest" ? "createdAt" : "updatedAt";
    rows.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 9;
      const pb = PRIORITY_ORDER[b.priority] ?? 9;
      if (pa !== pb) return pa - pb;
      const ta = a[sortField] ? new Date(a[sortField]).getTime() : 0;
      const tb = b[sortField] ? new Date(b[sortField]).getTime() : 0;
      return sort === "oldest" ? (ta - tb) : (tb - ta);
    });

    const maxLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 200));
    rows = rows.slice(0, maxLimit);

    const projects = [...new Set(rows.map((r) => r.project).filter(Boolean))];
    const statusCounts = {};
    for (const r of rows) {
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
    }

    return { items: rows, projects, statusCounts, total: rows.length };
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
        workflow: job.workflow || "standard",
        retryCount: row.retryCount,
        failureCode: row.failureCode,
        failurePhase: row.failurePhase,
        cancelRequested: row.cancelRequested,
        redirectContext: row.redirectContext,
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

function buildRetryChain(allJobs, job) {
  const chain = [job];
  let current = job;

  // Walk backwards through parent lineage
  while (current.lineage?.parentJobId) {
    const parent = allJobs.find((j) => j.jobId === current.lineage.parentJobId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }

  // Walk forwards: find children that point to this job
  const children = allJobs.filter((j) => j.lineage?.parentJobId === job.jobId);
  for (const child of children) {
    chain.push(child);
  }

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
