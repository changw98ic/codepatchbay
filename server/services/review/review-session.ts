/**
 * Review Session — session lifecycle, bundle building, and review loop.
 *
 * Merged from:
 *   - review-session.ts   (session CRUD, budget, idempotency)
 *   - review-bundle.ts    (bundle assembly from git + artifacts)
 *   - review-loop.ts      (accept/reject bundle, retry queue)
 */

// ─── review-session.ts ────────────────────────────────────────────
import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveHubRoot } from "../hub/hub-registry.js";

const LOCK_MAX_ATTEMPTS = 10;
const LOCK_BASE_DELAY_MS = 10;

async function withFileLock(lockDir, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false });
    } catch (err) {
      if (err.code === "EEXIST" && attempt < LOCK_MAX_ATTEMPTS) {
        const jitter = Math.random() * LOCK_BASE_DELAY_MS;
        await new Promise((r) => setTimeout(r, LOCK_BASE_DELAY_MS + jitter));
        continue;
      }
      if (err.code === "EEXIST") {
        throw new Error(
          `lock contention: failed to acquire ${lockDir} after ${LOCK_MAX_ATTEMPTS} attempts`,
        );
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const VALID_TRANSITIONS = {
  idle: ["researching"],
  researching: ["planning", "expired"],
  planning: ["reviewing", "expired"],
  reviewing: ["revising", "user_review", "expired"],
  revising: ["reviewing", "expired"],
  user_review: ["dispatched", "expired", "merge_failed", "completed"],
  dispatched: ["merge_failed", "completed"],
  merge_failed: ["dispatched"],
  expired: [],
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid sessionId: must be a non-empty string");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return sessionId;
}

function reviewsDir(cpbRoot, options: Record<string, any> = {}) {
  const controlRoot = options.controlRoot || options.hubRoot;
  if (controlRoot) return path.join(path.resolve(controlRoot), "reviews");
  return path.join(resolveHubRoot(cpbRoot), "reviews");
}

function sessionFile(cpbRoot, sessionId, options: Record<string, any> = {}) {
  const safeId = validateSessionId(sessionId);
  const dir = reviewsDir(cpbRoot, options);
  const resolved = path.resolve(dir, `${safeId}.json`);
  const base = path.resolve(dir);
  if (!resolved.startsWith(base + path.sep) && resolved !== path.join(base, `${safeId}.json`)) {
    throw new Error("sessionId escapes reviews directory");
  }
  return resolved;
}

export function makeSessionId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `rev-${ts}-${suffix}`;
}

export async function createSession(cpbRoot, { project, intent, ...options }: Record<string, any>) {
  const session = {
    sessionId: makeSessionId(),
    project,
    intent,
    status: "idle",
    round: 0,
    research: { codex: null, claude: null },
    plan: null,
    reviews: [],
    userVerdict: null,
    jobId: null,
    queueEntryId: null,
    budget: {
      maxRounds: parseInt(process.env.CPB_REVIEW_MAX_ROUNDS || "5", 10),
      maxPromptBytes: parseInt(process.env.CPB_REVIEW_MAX_PROMPT_BYTES || "120000", 10),
      maxAcpCalls: parseInt(process.env.CPB_REVIEW_MAX_ACP_CALLS || "30", 10),
      usedAcpCalls: 0,
      usedPromptBytes: 0,
    },
    idempotency: {
      startKey: null,
      dispatchKey: null,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionFile(cpbRoot, session.sessionId, options), JSON.stringify(session, null, 2) + "\n", "utf8");
  return session;
}

export async function getSession(cpbRoot, sessionId, options: Record<string, any> = {}) {
  validateSessionId(sessionId);
  try {
    const raw = await readFile(sessionFile(cpbRoot, sessionId, options), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessions(cpbRoot, options: Record<string, any> = {}) {
  const dir = reviewsDir(cpbRoot, options);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const sessions = [];
  for (const name of entries.filter(f => f.endsWith(".json")).sort().reverse()) {
    try {
      const raw = await readFile(path.join(dir, name), "utf8");
      sessions.push(JSON.parse(raw));
    } catch {}
  }
  return sessions;
}

export async function updateSession(cpbRoot, sessionId, patch, options: Record<string, any> = {}) {
  const safeId = validateSessionId(sessionId);
  const { skipTransitionCheck = false } = options;

  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    if (!skipTransitionCheck && patch.status) {
      if (patch.status === session.status) {
        throw new Error(`already in status: ${session.status}`);
      }
      const allowed = VALID_TRANSITIONS[session.status];
      if (!allowed || !allowed.includes(patch.status)) {
        throw new Error(`invalid transition: ${session.status} → ${patch.status}`);
      }
    }

    const updated = {
      ...session,
      ...patch,
      sessionId: session.sessionId, // immutable
      project: session.project,
      intent: session.intent,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export async function cancelReviewSession(cpbRoot, sessionId, reason) {
  return updateSession(cpbRoot, sessionId, { status: "cancelled", detail: reason }, { skipTransitionCheck: true });
}

export function parseIssues(text) {
  if (!text || typeof text !== "string") return [];
  const issues = [];
  const regex = /\[P([0-3])\]\s*(.*?)(?=\n\[P[0-3]\]|$)/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    issues.push({
      severity: parseInt(match[1], 10),
      description: match[2].trim(),
    });
  }
  return issues;
}

export async function startSessionResearch(cpbRoot, sessionId, key, options: Record<string, any> = {}) {
  const safeId = validateSessionId(sessionId);
  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-start-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    const existingKey = session.idempotency?.startKey;
    if (existingKey === key) return session; // idempotent

    if (existingKey !== null && existingKey !== undefined) {
      throw new Error(`idempotency conflict: session already started with key ${existingKey}`);
    }

    if (session.status !== "idle") {
      throw new Error(`invalid transition: ${session.status} → researching`);
    }

    const updated = {
      ...session,
      status: "researching",
      idempotency: { ...session.idempotency, startKey: key },
      updatedAt: new Date().toISOString(),
    };
    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export async function noteReviewAcpCall(cpbRoot, sessionId, { agent, promptBytes }, options: Record<string, any> = {}) {
  const safeId = validateSessionId(sessionId);
  const dir = reviewsDir(cpbRoot, options);
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, `.lock-${safeId}`);
  return withFileLock(lockDir, async () => {
    const session = await getSession(cpbRoot, sessionId, options);
    if (!session) throw new Error(`review session not found: ${sessionId}`);

    const budget = {
      ...session.budget,
      usedAcpCalls: (session.budget?.usedAcpCalls || 0) + 1,
      usedPromptBytes: (session.budget?.usedPromptBytes || 0) + (promptBytes || 0),
    };

    const updated = {
      ...session,
      budget,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(sessionFile(cpbRoot, sessionId, options), JSON.stringify(updated, null, 2) + "\n", "utf8");
    return updated;
  });
}

export function assertReviewBudget(session) {
  const budget = session.budget;
  if (!budget) return session;
  if (budget.usedAcpCalls >= budget.maxAcpCalls) {
    throw new Error(`budget exhausted: usedAcpCalls(${budget.usedAcpCalls}) >= maxAcpCalls(${budget.maxAcpCalls})`);
  }
  if (budget.usedPromptBytes >= budget.maxPromptBytes) {
    throw new Error(`budget exhausted: usedPromptBytes(${budget.usedPromptBytes}) >= maxPromptBytes(${budget.usedPromptBytes})`);
  }
  return session;
}

// ─── review-bundle.ts ─────────────────────────────────────────────
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEventsReadOnly, materializeJob } from "../event/event-store.js";
import { buildArtifactIndex } from "../job/job-projection.js";
import { parseVerdictEnvelope } from "../../../core/workflow/verdict.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 };
  } catch (err) {
    if (!allowFailure) throw err;
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function getDiff(worktreePath, sourceHead) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getDiffStat(worktreePath, sourceHead) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", "--stat", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getChangedFiles(worktreePath, sourceHead) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, ["diff", "--name-only", sourceHead, "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

async function getUncommittedDiff(worktreePath) {
  const result = await runGit(worktreePath, ["diff", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getCurrentHead(repoPath) {
  const result = await runGit(repoPath, ["rev-parse", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function getLog(worktreePath, sourceHead, maxCount = 20) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, [
    "log", "--oneline", `${sourceHead}..HEAD`, `--max-count=${maxCount}`,
  ], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function buildReviewBundle(cpbRoot, project, jobId, {
  entry = null,
  job = null,
  sourcePath = null,
  worktreePath = null,
  dataRoot = null,
  wikiDir = null,
} = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  const jobState = materializeJob(events);

  const worktree = worktreePath || jobState.worktree || job?.worktree || null;
  const baseBranch = jobState.worktreeBaseBranch || job?.worktreeBaseBranch || "main";
  const branch = jobState.worktreeBranch || job?.worktreeBranch || null;

  const artifactIndex = await buildArtifactIndex(cpbRoot, project, jobId, { events, dataRoot, wikiDir });

  const planArtifact = artifactIndex.entries.find((e) => e.kind === "plan" && !e.broken);
  const deliverableArtifact = artifactIndex.entries.find((e) => e.kind === "deliverable" && !e.broken);
  const verdictArtifact = [...artifactIndex.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
  const reviewArtifact = artifactIndex.entries.find((e) => e.kind === "review" && !e.broken);
  const promptAudit = artifactIndex.entries
    .filter((e) => e.kind === "prompt")
    .map((e) => ({
      id: e.id,
      phase: e.phase || null,
      path: e.path,
      sha256: e.sha256,
      producerAgent: e.producerAgent || null,
      broken: e.broken,
      reason: e.reason || null,
    }));

  let planContent = null;
  if (planArtifact) {
    try { planContent = await readFile(planArtifact.path, "utf8"); } catch {}
  }

  let deliverableContent = null;
  if (deliverableArtifact) {
    try { deliverableContent = await readFile(deliverableArtifact.path, "utf8"); } catch {}
  }

  let verdictContent = null;
  let verdictParsed = null;
  if (verdictArtifact) {
    try {
      verdictContent = await readFile(verdictArtifact.path, "utf8");
      verdictParsed = parseVerdictEnvelope(verdictContent);
    } catch {}
  }

  let reviewContent = null;
  if (reviewArtifact) {
    try { reviewContent = await readFile(reviewArtifact.path, "utf8"); } catch {}
  }

  let diffEvidence = null;
  let diffStat = null;
  let changedFiles = [];
  let commitLog = [];
  let uncommittedDiff = null;

  if (worktree) {
    const sourceHead = sourcePath ? await getCurrentHead(sourcePath) : null;
    const wtHead = await getCurrentHead(worktree);
    const effectiveSourceHead = sourceHead || (wtHead ? `${wtHead}~1` : null);

    [diffEvidence, diffStat, changedFiles, commitLog, uncommittedDiff] = await Promise.all([
      getDiff(worktree, effectiveSourceHead),
      getDiffStat(worktree, effectiveSourceHead),
      getChangedFiles(worktree, effectiveSourceHead),
      getLog(worktree, effectiveSourceHead),
      getUncommittedDiff(worktree),
    ]);
  }

  const timeline = events.map((ev) => ({
    type: ev.type,
    ts: ev.ts || null,
    phase: ev.phase || null,
    agent: ev.agent || null,
    status: ev.status || null,
  }));

  const metadata = entry?.metadata || {};
  const taskDescription = entry?.description || jobState.task || job?.task || null;

  const bundle = {
    schemaVersion: 1,
    bundleType: "local_review",
    generatedAt: new Date().toISOString(),
    project,
    jobId,

    request: {
      task: taskDescription,
      workflow: metadata.workflow || jobState.workflow || "standard",
      planMode: metadata.planMode || jobState.planMode || "full",
      source: metadata.source || "cli",
      actor: metadata.actor || null,
      requestedAt: metadata.requestedAt || jobState.createdAt || null,
    },

    status: {
      jobStatus: jobState.status,
      completedPhases: jobState.completedPhases,
      failureCode: jobState.failureCode || null,
      failurePhase: jobState.failurePhase || null,
    },

    evidence: {
      plan: planContent ? { path: planArtifact?.path || null, content: planContent } : null,
      deliverable: deliverableContent ? { path: deliverableArtifact?.path || null, content: deliverableContent } : null,
      verdict: verdictParsed || (verdictContent ? { raw: verdictContent } : null),
      review: reviewContent || null,
      diff: diffEvidence || null,
      diffStat: diffStat || null,
      uncommittedDiff: uncommittedDiff || null,
      changedFiles,
      commitLog,
    },

    git: {
      worktree,
      branch,
      baseBranch,
      sourcePath: sourcePath || null,
    },

    timeline,

    dw: buildDwSection(jobState),

    promptAudit,

    links: {
      eventLog: `events/${project}/${jobId}.jsonl`,
      artifacts: artifactIndex.entries.map((e) => ({
        kind: e.kind,
        phase: e.phase || null,
        path: e.path,
        sha256: e.sha256,
        broken: e.broken,
      })),
    },
  };

  return bundle;
}

export async function writeReviewBundle(outputDir, bundle) {
  const slug = `${bundle.project}-${bundle.jobId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${slug}-review-bundle.json`;
  const filePath = path.join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
  return filePath;
}

/**
 * Build the DW (Dynamic Workflow) evidence section from materialized job state.
 */
function buildDwSection(jobState) {
  const dag = jobState.workflowDag;
  const dagNodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const dagEdges = Array.isArray(dag?.edges) ? dag.edges : [];

  return {
    riskMap: jobState.riskMap ?? null,
    workflowDag: dag
      ? {
          name: dag.name ?? jobState.workflow ?? null,
          nodeCount: dagNodes.length,
          edgeCount: dagEdges.length,
          nodes: dagNodes.map((n) => ({
            id: n.id ?? null,
            phase: n.phase ?? n.id ?? null,
            role: n.role ?? null,
          })),
        }
      : null,
    dynamicAgentPlan: jobState.dynamicAgentPlan ?? null,
    verdict: jobState.artifacts?.verdict
      ? { status: jobState.verdict ?? null, artifact: jobState.artifacts.verdict }
      : null,
    adversarialVerdict: jobState.adversarialVerdict ?? null,
    completionGate: jobState.completionGate ?? null,
  };
}

export function reviewBundleDir(hubRoot, project, jobId) {
  return path.join(hubRoot, "review-bundles", project);
}

export function reviewBundleDwContract() {
  return {
    includesRiskMap: true,
    includesWorkflowDag: true,
    includesDynamicAgentPlan: true,
    includesAdversarialVerdict: true,
    includesCompletionGate: true,
  };
}

// ─── review-loop.ts ───────────────────────────────────────────────
import { readEventsReadOnly as readEventsReadOnlyForLoop, appendEvent, checkpointJob } from "../event/event-store.js";
import { enqueue, updateEntry } from "../hub/hub-queue.js";
import { updateJobsIndexEntry } from "../job/job-store.js";

type AnyRecord = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function trimText(value, maxChars = 6000) {
  const text = String(value || "").trim();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function bundleIdFor(project, jobId) {
  return `rb-${project}-${jobId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

const REVIEWABLE_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

export class ReviewLoopError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "ReviewLoopError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isReviewLoopError(error: any) {
  return error instanceof ReviewLoopError || Boolean(error?.code && error?.statusCode);
}

function reviewLoopError(message, code, statusCode) {
  return new ReviewLoopError(message, code, statusCode);
}

function assertReviewableJob(job) {
  if (!REVIEWABLE_TERMINAL_STATUSES.has(job?.status)) {
    throw reviewLoopError(
      `review bundle can only be accepted or rejected after the job is terminal; current status: ${job?.status || "unknown"}`,
      "REVIEW_JOB_NOT_TERMINAL",
      409,
    );
  }
}

function assertReviewNotFinalized(loop) {
  const latestVerdict = loop?.latest?.verdict;
  if (latestVerdict === "accepted" || latestVerdict === "rejected") {
    throw reviewLoopError(
      `review bundle already ${latestVerdict}`,
      "REVIEW_BUNDLE_ALREADY_REVIEWED",
      409,
    );
  }
}

async function refreshJobIndex(cpbRoot, project, jobId, { dataRoot }: AnyRecord = {}) {
  const job = await checkpointJob(cpbRoot, project, jobId, { dataRoot })
    || materializeJob(await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot }));
  await updateJobsIndexEntry(cpbRoot, project, jobId, job, { dataRoot });
  return job;
}

function reviewLoopState(events) {
  const rounds = [];
  for (const event of events) {
    if (event.type === "review_bundle_accepted" || event.type === "review_bundle_rejected") {
      rounds.push({
        round: event.round ?? rounds.length + 1,
        verdict: event.verdict ?? (event.type === "review_bundle_accepted" ? "accepted" : "rejected"),
        feedback: event.feedback ?? null,
        retryQueueEntryId: event.retryQueueEntryId ?? null,
        bundleId: event.bundleId ?? null,
        actor: event.actor ?? null,
        createdAt: event.ts ?? null,
      });
    }
  }
  return { rounds, nextRound: rounds.length + 1, latest: rounds[rounds.length - 1] ?? null };
}

function retryPreviousOutput(bundle) {
  const chunks = [];
  if (bundle?.evidence?.verdict) {
    chunks.push(`Previous verdict:\n${typeof bundle.evidence.verdict === "string" ? bundle.evidence.verdict : JSON.stringify(bundle.evidence.verdict, null, 2)}`);
  }
  if (bundle?.evidence?.deliverable?.content) {
    chunks.push(`Previous deliverable:\n${bundle.evidence.deliverable.content}`);
  }
  if (bundle?.evidence?.plan?.content) {
    chunks.push(`Previous plan:\n${bundle.evidence.plan.content}`);
  }
  if (bundle?.evidence?.diffStat) {
    chunks.push(`Previous diff stat:\n${bundle.evidence.diffStat}`);
  }
  return trimText(chunks.join("\n\n"), 8000);
}

function buildRetrySourceContext(job, bundle, { round, feedback, actor, ts, retryQueueEntryId }: AnyRecord) {
  const base = job?.sourceContext && typeof job.sourceContext === "object" ? { ...job.sourceContext } : {};
  const dagResume = job?.dagResume && typeof job.dagResume === "object"
    ? {
        failedNodeId: job.dagResume.failedNodeId ?? null,
        resumeTarget: job.dagResume.resumeTarget ? { ...job.dagResume.resumeTarget } : null,
        completedNodeIds: Array.isArray(job.dagResume.completedNodeIds) ? [...job.dagResume.completedNodeIds] : [],
      }
    : base.dagResume && typeof base.dagResume === "object"
      ? {
          failedNodeId: base.dagResume.failedNodeId ?? null,
          resumeTarget: base.dagResume.resumeTarget ? { ...base.dagResume.resumeTarget } : null,
          completedNodeIds: Array.isArray(base.dagResume.completedNodeIds) ? [...base.dagResume.completedNodeIds] : [],
        }
      : null;
  const bundleId = bundleIdFor(job.project, job.jobId);
  const retry = {
    failureKind: "human_rejected_review_bundle",
    failureReason: feedback,
    previousOutput: retryPreviousOutput(bundle),
    previousJobId: job.jobId,
    previousPhase: dagResume?.resumeTarget?.phase || job.failurePhase || job.phase || null,
    previousNodeId: dagResume?.failedNodeId || dagResume?.resumeTarget?.nodeId || null,
    resumeTarget: dagResume?.resumeTarget ? { ...dagResume.resumeTarget } : null,
    completedNodeIds: dagResume?.completedNodeIds ? [...dagResume.completedNodeIds] : [],
    previousQueueEntryId: job.queueEntryId || base.queueEntryId || null,
    originalBundleId: bundleId,
    reviewRound: round,
    trigger: "review_bundle_rejected",
    actor,
    rejectedAt: ts,
    retryQueueEntryId,
    artifacts: job.artifacts || {},
  };
  return {
    ...base,
    ...(dagResume ? { dagResume } : {}),
    type: base.type || "review_bundle_retry",
    retry,
    reviewLoop: {
      originalJobId: job.jobId,
      originalBundleId: bundleId,
      round,
      retryQueueEntryId,
    },
    previousFailure: {
      kind: retry.failureKind,
      reason: retry.failureReason,
      jobId: job.jobId,
      phase: retry.previousPhase,
      nodeId: retry.previousNodeId,
      resumeTarget: retry.resumeTarget ? { ...retry.resumeTarget } : null,
      completedNodeIds: [...retry.completedNodeIds],
    },
  };
}

export async function getReviewLoop(cpbRoot, project, jobId, { dataRoot }: AnyRecord = {}) {
  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  return reviewLoopState(events);
}

export async function acceptReviewBundle(cpbRoot, project, jobId, {
  actor = null,
  feedback = "",
  ts = nowIso(),
  dataRoot,
}: AnyRecord = {}) {
  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const event = await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_accepted",
    jobId,
    project,
    bundleId: bundleIdFor(project, jobId),
    round,
    verdict: "accepted",
    feedback: trimText(feedback),
    actor,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    accepted: true,
    jobId,
    project,
    round,
    bundleId: bundleIdFor(project, jobId),
    event,
  };
}

export async function rejectReviewBundle(cpbRoot, project, jobId, {
  feedback,
  actor = null,
  hubRoot,
  sourcePath = null,
  priority = "P0",
  ts = nowIso(),
  dataRoot,
}: AnyRecord = {}) {
  const normalizedFeedback = trimText(feedback);
  if (!normalizedFeedback) throw reviewLoopError("feedback required", "REVIEW_FEEDBACK_REQUIRED", 400);
  if (!hubRoot) throw reviewLoopError("hubRoot required", "REVIEW_HUB_ROOT_REQUIRED", 400);

  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const bundle = await buildReviewBundle(cpbRoot, project, jobId, {
    dataRoot,
    sourcePath,
    worktreePath: job.worktree || null,
  });
  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const bundleId = bundleIdFor(project, jobId);
  const queueDedupeKey = `review-loop:${project}:${jobId}:${round}`;

  const sourceContext = buildRetrySourceContext(job, bundle, {
    round,
    feedback: normalizedFeedback,
    actor,
    ts,
    retryQueueEntryId: null,
  });

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath,
    priority,
    description: job.task || bundle.request?.task || `Retry rejected review bundle ${jobId}`,
    type: "review_bundle_retry",
    metadata: {
      source: "review_bundle_rejection",
      sourceType: "review_bundle_rejection",
      workflow: job.workflow || bundle.request?.workflow || "standard",
      planMode: job.planMode || bundle.request?.planMode || "full",
      actor,
      originJobId: jobId,
      originalJobId: jobId,
      originalBundleId: bundleId,
      reviewRound: round,
      userFeedback: normalizedFeedback,
      requestedAt: ts,
      queueDedupeKey,
      sourceContext,
    },
  });

  sourceContext.reviewLoop.retryQueueEntryId = entry.id;
  sourceContext.retry.retryQueueEntryId = entry.id;
  const updatedEntry = await updateEntry(hubRoot, entry.id, {
    metadata: { sourceContext },
  });

  await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_rejected",
    jobId,
    project,
    bundleId,
    round,
    verdict: "rejected",
    feedback: normalizedFeedback,
    actor,
    retryQueueEntryId: entry.id,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    rejected: true,
    jobId,
    project,
    round,
    bundleId,
    retryQueueEntry: updatedEntry || entry,
  };
}
