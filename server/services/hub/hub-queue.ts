/**
 * hub-queue.ts — merged from:
 *   server/services/hub-queue.ts
 *   server/services/queue-rules.ts
 *   server/services/auto-enqueue.ts
 *   server/services/inbox-mail.ts
 */

import type { LooseRecord } from "../../../core/contracts/types.js";
import { assertHubWritable } from "../../../shared/hub-maintenance.js";
import {
  openPinnedHubRedisStateBackend,
  type RedisLeaderFence,
} from "../../../shared/hub-state-redis.js";
import { processLeaderFence } from "../../../shared/hub-leader-fence.js";

type MetadataArtifacts = Array<LooseRecord & {
  kind?: string;
  reason?: string;
  artifacts?: unknown[];
}>;

type ArtifactMap = LooseRecord;

type QueueRetryContext = LooseRecord & {
  failureKind?: string;
  verification?: LooseRecord & {
    verdict?: LooseRecord & { status?: string };
    retryScope?: unknown;
  };
  previousOutput?: string;
  previousJobId?: string;
  artifacts?: ArtifactMap;
};

type QueueSourceContext = LooseRecord & {
  issueNumber?: string | number;
  retry?: QueueRetryContext;
  repair?: LooseRecord & {
    repairArtifact?: string;
    artifacts?: ArtifactMap;
  };
  previousFailure?: LooseRecord & {
    kind?: unknown;
    reason?: unknown;
    artifacts?: ArtifactMap;
  };
};

type QueueMetadata = LooseRecord & {
  mutating?: boolean;
  queueDedupeKey?: string;
  originJobId?: string;
  acpProfile?: string;
  uiLane?: boolean;
  uiLaneReason?: string;
  issueNumber?: number | string;
  issueUrl?: string;
  retryJobId?: string;
  repo?: string;
  repository?: string;
  finalDisposition?: string;
  sourceContext?: LooseRecord | string | null;
  action?: string;
  failureKind?: string;
  verification?: LooseRecord & {
    kind?: string;
    reason?: string;
    artifacts?: unknown[];
  };
  previousOutput?: string | (LooseRecord & {
    kind?: string;
    reason?: string;
    artifacts?: unknown[];
  });
  previousJobId?: string;
  failureReason?: string;
  cancelReason?: string;
  repairArtifact?: string;
  remediationArtifact?: string;
  artifacts?: MetadataArtifacts | LooseRecord;
  riskLevel?: string;
  agentConfig?: LooseRecord;
  dynamicAgentPlan?: LooseRecord & {
    riskLevel?: string;
    agentConfig?: Record<string, LooseRecord & {
      required?: boolean;
      independent?: boolean;
    }>;
  };
  dispatchFailure?: {
    retryable?: boolean;
    timestamp?: string;
    error?: string;
  };
  workflow?: string;
  planMode?: string;
  lastFailureKind?: unknown;
  failureCount?: number;
  supervisorDecision?: LooseRecord;
  agentsOverride?: LooseRecord;
  retryDecision?: {
    action?: string;
    reason?: string;
    retryable?: boolean | null;
    timestamp?: string;
    error?: string;
    retryAt?: string;
    untilTs?: unknown;
    failureClass?: unknown;
    failureFingerprint?: unknown;
    retryStrategy?: unknown;
    strategyChanged?: boolean;
    forceFreshSession?: boolean;
  };
  schedulerDecision?: {
    mode?: string;
    selectedAt?: string;
    rank?: number;
    score?: number;
    reasons?: string[];
    retryStrategy?: string | null;
    failureFingerprint?: string | null;
    failureClass?: string | null;
  };
  indexFreshness?: {
    available?: boolean;
    indexDirty?: boolean;
    indexStale?: boolean;
    worktreeDirty?: boolean;
    dirtyReasons?: string[];
  };
  capabilityMap?: {
    available?: boolean;
    reason?: string;
  };
  codegraphReadiness?: {
    available?: boolean;
    reason?: string;
    details?: LooseRecord | null;
    sourcePath?: string;
    indexFile?: string;
  };
  indexSnapshot?: LooseRecord;
};

type QueueResult = LooseRecord & {
  ok?: boolean;
  backlogIssueId?: string | null;
  error?: unknown;
};

type QueueEntry = LooseRecord & {
  id?: string;
  projectId?: string;
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  metadata?: QueueMetadata;
  createdAt?: string;
  updatedAt?: string;
  sourcePath?: string | null;
  sessionId?: string | null;
  workerId?: string | null;
  cwd?: string | null;
  executionBoundary?: string;
  claimedBy?: string | null;
  claimedAt?: string | null;
  completedAt?: string;
  reason?: string;
  result?: QueueResult;
  indexSnapshotId?: string;
};

type QueueEntryInput = LooseRecord & Partial<QueueEntry> & {
  metadata?: QueueMetadata;
  result?: QueueResult;
};

type QueueUpdateGuard = {
  expectedStatus?: string | string[];
  expectedClaimedAt?: string | null;
  expectedUpdatedAt?: string | null;
};

type QueueState = { version: number; entries: QueueEntry[] };

type AssignmentRecord = { status?: string };
type AssignmentStoreLike = {
  getAssignmentSync?: (assignmentId: string) => AssignmentRecord | null | undefined;
  getAssignment?: (assignmentId: string) => Promise<AssignmentRecord | null | undefined>;
};

type QueueProjectRecord = LooseRecord & {
  sourcePath?: string;
  projectRuntimeRoot?: string;
  cpbRoot?: string;
  metadata?: LooseRecord & { cpbRoot?: string };
};

type QueueRecoveryOptions = {
  claimTimeoutMs?: number;
  assignmentStore?: AssignmentStoreLike | null;
  nowMs?: number;
};

type QueueClaimOptions = QueueEntryInput & {
  workerId?: string;
  maxActivePerProject?: number;
  claimTimeoutMs?: number;
  providerSlotsAvailable?: boolean;
  requireIssueLink?: boolean;
  getProjectFn?: ((hubRoot: string, projectId: string) => Promise<QueueProjectRecord | null | undefined>) | null;
  cpbRoot?: string | null;
  indexUnavailableRetryMs?: number;
  assignmentStore?: AssignmentStoreLike | null;
  leaderFence?: RedisLeaderFence | null;
};

type ProjectQueueStatus = {
  pending: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  indexUnavailable: number;
  codegraphUnavailable: number;
  activeMutating: number;
  busy: boolean;
  busyReason: string | null;
  maxActivePerProject: number;
  claimedBy: string | null;
  claimedAt: string | null;
  workerId: string | null;
  activeEntryIds: string[];
  eligiblePending: number;
  eligibleEntryIds: string[];
  failedEntries?: number;
  failedTargets?: number;
  retryingFailedTargets?: number;
  retriedFailedTargets?: number;
  unretriedFailedTargets?: number;
};

type QueueStatusSummary = {
  total: number;
  pending: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  needsIssueLink: number;
  indexUnavailable: number;
  codegraphUnavailable: number;
  failedEntries: number;
  failedTargets: number;
  retryingFailedTargets: number;
  retriedFailedTargets: number;
  unretriedFailedTargets: number;
  activeMutatingTotal: number;
  projects: Record<string, ProjectQueueStatus>;
  activeProjects: Array<ProjectQueueStatus & { projectId: string }>;
  eligibleQueued: number;
  eligibleProjects: string[];
};

type ProjectLimitMap = Map<string, unknown> | LooseRecord;

type AutomationRule = LooseRecord & {
  name?: string;
  match?: {
    labels?: string[];
    titlePattern?: string;
  };
  action?: LooseRecord & {
    workflow?: string;
  };
};

type AutomationIssue = LooseRecord & {
  number?: number;
  title?: string;
  body?: string;
  url?: string;
  labels?: string[];
  state?: string;
  repository?: string | null;
  repo?: string | null;
  repositoryFullName?: string | null;
  projectId?: string;
};

type AutomationProject = LooseRecord & {
  id?: string;
  sourcePath?: string;
  github?: {
    fullName?: string;
    automation?: {
      enabled?: boolean;
      exclude?: AutomationExclude;
      rules?: AutomationRule[];
    };
  };
};

type AutomationExclude = {
  labels?: string[];
};

type InboxMessageInput = LooseRecord & {
  type?: string;
  jobId?: string;
  phase?: string;
  from?: string;
  to?: string;
  locator?: LooseRecord;
  content?: string;
};

type InboxMessageFilters = LooseRecord & {
  type?: string;
  status?: string;
  to?: string;
  owner?: string;
  jobId?: string;
};

type InboxAckOptions = {
  owner?: string;
};

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isQueueEntry(value: unknown): value is QueueEntry {
  return isRecord(value);
}

function toQueueEntries(value: unknown): QueueEntry[] {
  return Array.isArray(value) ? value.filter(isQueueEntry) : [];
}

function errnoCode(err: unknown) {
  return isRecord(err) && typeof err.code === "string" ? err.code : null;
}

function errorDetails(err: unknown) {
  const record = isRecord(err) ? err : {};
  const details = isRecord(record.details) ? record.details : null;
  const reason = String(details?.reason || record.code || "codegraph_unavailable");
  return { reason, details };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// ─── queue-rules.ts ─────────────────────────────────────────────────────────

/**
 * Single source of truth for queue claim / stale-recovery rules.
 * Scheduler, claimEligible API, and any future caller all go through here.
 */

export function priorityScore(priority: string) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export function isMutatingEntry(entry: QueueEntryInput) {
  return entry.metadata?.mutating !== false;
}

export function isActiveEntry(entry: QueueEntryInput) {
  return entry.status === "in_progress" || entry.status === "scheduled";
}

export function clearClaim(entry: QueueEntryInput) {
  entry.claimedBy = null;
  entry.claimedAt = null;
  entry.workerId = null;
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

export function isCodegraphUnavailableStatus(status: string) {
  return status === "codegraph_unavailable" || status === "index_unavailable";
}

/**
 * Recover stale in_progress / scheduled entries (sync variant).
 *
 * Requires an assignmentStore — entries with an active assignment
 * (status "running" or "assigned") get their claimedAt refreshed
 * instead of being reset to pending.
 *
 * @param {Array} entries  — mutable queue entries array
 * @param {object} opts
 * @param {number} opts.claimTimeoutMs
 * @param {import("../../shared/orchestrator/assignment-store.js").AssignmentStore} opts.assignmentStore
 * @returns {{ recovered: string[], refreshed: string[] }}
 */
export function recoverStaleInProgress(entries: QueueEntry[], opts: QueueRecoveryOptions) {
  const { claimTimeoutMs, assignmentStore, nowMs = Date.now() } = opts;
  if (!claimTimeoutMs || claimTimeoutMs <= 0) return { recovered: [], refreshed: [] };
  if (!assignmentStore) throw new Error("recoverStaleInProgress requires assignmentStore");

  const now = nowMs;
  const recovered = [];
  const refreshed = [];

  for (const e of entries) {
    if (e.status !== "in_progress" && e.status !== "scheduled") continue;
    const claimedAt = e.claimedAt ? new Date(e.claimedAt).getTime() : 0;
    if (!Number.isFinite(claimedAt) || now - claimedAt < claimTimeoutMs) continue;

    const assignmentId = `a-${e.id}`;
    const assignment = assignmentStore.getAssignmentSync
      ? assignmentStore.getAssignmentSync(assignmentId)
      : null;
    if (assignment && (assignment.status === "running" || assignment.status === "assigned")) {
      e.claimedAt = nowIso(now);
      e.updatedAt = nowIso(now);
      refreshed.push(e.id);
      continue;
    }

    // No active assignment — safe to reset
    e.status = "pending";
    clearClaim(e);
    e.updatedAt = nowIso(now);
    recovered.push(e.id);
  }
  return { recovered, refreshed };
}

/**
 * Async variant for callers that have an AssignmentStore with async getAssignment().
 * Used by Scheduler and claimEligible.  assignmentStore is required.
 */
export async function recoverStaleInProgressAsync(entries: QueueEntry[], opts: QueueRecoveryOptions) {
  const { claimTimeoutMs, assignmentStore, nowMs = Date.now() } = opts;
  if (!claimTimeoutMs || claimTimeoutMs <= 0) return { recovered: [], refreshed: [] };
  if (!assignmentStore) throw new Error("recoverStaleInProgressAsync requires assignmentStore");

  const now = nowMs;
  const recovered = [];
  const refreshed = [];

  for (const e of entries) {
    if (e.status !== "in_progress" && e.status !== "scheduled") continue;
    const claimedAt = e.claimedAt ? new Date(e.claimedAt).getTime() : 0;
    if (!Number.isFinite(claimedAt) || now - claimedAt < claimTimeoutMs) continue;

    const assignment = await assignmentStore.getAssignment?.(`a-${e.id}`);
    if (assignment && (assignment.status === "running" || assignment.status === "assigned")) {
      // Active assignment — refresh claimedAt so next tick doesn't re-trigger
      e.claimedAt = nowIso(now);
      e.updatedAt = nowIso(now);
      refreshed.push(e.id);
      continue;
    }

    // No active assignment — safe to reset
    e.status = "pending";
    clearClaim(e);
    e.updatedAt = nowIso(now);
    recovered.push(e.id);
  }
  return { recovered, refreshed };
}

/**
 * Recover codegraph_unavailable entries whose retry window has elapsed.
 */
export function recoverCodegraphUnavailable(entries: QueueEntry[], retryMs: number, nowMs = Date.now()) {
  if (!retryMs || retryMs <= 0) return { recovered: [] };
  const now = nowMs;
  const recovered = [];
  for (const e of entries) {
    if (!isCodegraphUnavailableStatus(e.status)) continue;
    const updatedAt = e.updatedAt ? new Date(e.updatedAt).getTime() : 0;
    if (!Number.isFinite(updatedAt) || now - updatedAt < retryMs) continue;
    e.status = "pending";
    e.updatedAt = nowIso(now);
    if (e.metadata) delete e.metadata.indexFreshness;
    recovered.push(e.id);
  }
  return { recovered };
}

// ─── hub-queue.ts ───────────────────────────────────────────────────────────


import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMeta, REQUIRED_EXECUTION_BOUNDARY } from "../../../core/job/meta.js";
import { ensureIndexFresh } from "../infra.js";
import { projectCapabilityMapGate } from "../project/project-index.js";
import { checkCodeGraphReady } from "../infra.js";
import { resolveAgentsForEntry } from "../agent/agent-config.js";
import { getProject } from "./hub-registry.js";
import {
  DEFAULT_MAX_ACTIVE_PER_PROJECT,
  positiveInt,
  resolveHubConcurrencyLimits,
  resolveProjectConcurrencyLimits,
} from "../infra.js";


export const QUEUE_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function queuePath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "queue", "queue.json");
}

function defaultQueue(): QueueState {
  return { version: QUEUE_VERSION, entries: [] };
}

function normalizeQueue(raw: unknown): QueueState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultQueue();
  const obj = raw as LooseRecord;
  return {
    version: typeof obj.version === "number" ? obj.version : QUEUE_VERSION,
    entries: toQueueEntries(obj.entries),
  };
}

const QUEUE_LOCK_TTL_MS = 120_000;
const QUEUE_MAX_BYTES = 16 * 1024 * 1024;
const QUEUE_CAS_MAX_ATTEMPTS = 64;

async function queueLockIsStale(lockDir: string) {
  const now = Date.now();
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    const acquiredAt = new Date(lock.acquiredAt).getTime();
    return Number.isNaN(acquiredAt) || now - acquiredAt >= QUEUE_LOCK_TTL_MS;
  } catch {
    try {
      const info = await stat(lockDir);
      return now - info.mtimeMs >= QUEUE_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }
}

async function queueLockOwnerPid(lockDir: string) {
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    return lock.ownerPid || null;
  } catch {
    return null;
  }
}

async function withQueueLock<T>(hubRoot: string, callback: (queue: QueueState) => Promise<T>): Promise<T> {
  await assertHubWritable(hubRoot);
  const file = queuePath(hubRoot);
  const lockDir = `${file}.lock`;
  const ownerPid = process.pid;
  await mkdir(path.dirname(file), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "lock.json"),
        `${JSON.stringify({ acquiredAt: nowIso(), ownerPid }, null, 2)}\n`,
        "utf8",
      );
      acquired = true;
      break;
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") throw err;
      if (await queueLockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) {
    throw new Error(`queue lock busy: ${path.basename(file)}`);
  }

  const acquiredAt = nowIso();
  try {
    const queue = await loadLocalQueue(hubRoot);
    const before = serializeQueue(queue);
    const result = await callback(queue);
    const after = serializeQueue(queue);
    if (after !== before) await saveLocalQueue(hubRoot, queue);
    return result;
  } finally {
    // Check both PID and timestamp window to guard against PID reuse
    const currentOwner = await queueLockOwnerPid(lockDir);
    if (currentOwner === ownerPid && !(await queueLockIsStale(lockDir))) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

async function loadLocalQueue(hubRoot: string) {
  try {
    const raw = await readFile(queuePath(hubRoot), "utf8");
    return normalizeQueue(JSON.parse(raw));
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return defaultQueue();
    throw err;
  }
}

function serializeQueue(queue: QueueState) {
  const serialized = JSON.stringify({ version: QUEUE_VERSION, entries: queue.entries });
  if (Buffer.byteLength(serialized, "utf8") > QUEUE_MAX_BYTES) {
    throw Object.assign(new Error(`queue exceeds ${QUEUE_MAX_BYTES} bytes`), { code: "HUB_QUEUE_TOO_LARGE" });
  }
  return serialized;
}

function parseRedisQueue(serialized: string | null) {
  if (serialized === null) return defaultQueue();
  if (Buffer.byteLength(serialized, "utf8") > QUEUE_MAX_BYTES) {
    throw Object.assign(new Error(`queue exceeds ${QUEUE_MAX_BYTES} bytes`), { code: "HUB_QUEUE_TOO_LARGE" });
  }
  try {
    const parsed = JSON.parse(serialized);
    if (
      !isRecord(parsed)
      || parsed.version !== QUEUE_VERSION
      || !Array.isArray(parsed.entries)
      || !parsed.entries.every(isQueueEntry)
    ) {
      throw new Error("invalid queue envelope");
    }
    return { version: QUEUE_VERSION, entries: parsed.entries };
  } catch {
    throw Object.assign(new Error("Redis queue state is not valid JSON"), { code: "HUB_QUEUE_INVALID" });
  }
}

async function redisQueueSnapshot(hubRoot: string, serialized: string | null) {
  const local = await loadLocalQueue(hubRoot);
  if (local.entries.length > 0) {
    throw Object.assign(
      new Error("local queue contains entries and cannot be selected automatically during Redis cutover"),
      { code: "HUB_QUEUE_MIGRATION_REQUIRED" },
    );
  }
  return parseRedisQueue(serialized);
}

async function saveLocalQueue(hubRoot: string, queue: QueueState) {
  await assertHubWritable(hubRoot);
  const normalized = { version: QUEUE_VERSION, entries: queue.entries };
  await writeAtomic(queuePath(hubRoot), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

async function redisQueueBackend(hubRoot: string) {
  return await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
}

async function withQueueMutation<T>(
  hubRoot: string,
  callback: (queue: QueueState, authorityNowMs: number) => Promise<T>,
  {
    leaderFence,
    maxAttempts = QUEUE_CAS_MAX_ATTEMPTS,
  }: { leaderFence?: RedisLeaderFence | null; maxAttempts?: number } = {},
) {
  await assertHubWritable(hubRoot);
  const backend = await redisQueueBackend(hubRoot);
  if (!backend) return await withQueueLock(hubRoot, (queue) => callback(queue, Date.now()));
  const effectiveFence = leaderFence === undefined
    ? processLeaderFence(backend.identityFingerprint)
    : leaderFence;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const snapshot = await backend.readQueue();
    const queue = await redisQueueSnapshot(hubRoot, snapshot.serialized);
    const before = serializeQueue(queue);
    const result = await callback(queue, await backend.serverTimeMs());
    const after = serializeQueue(queue);
    if (after === before) return result;
    const committed = await backend.compareAndSwapQueue(
      snapshot.revision,
      snapshot.revision + 1,
      after,
      effectiveFence,
    );
    if (committed.fenced) {
      throw Object.assign(new Error("leader lease no longer authorizes this queue write"), { code: "HUB_LEADER_FENCED" });
    }
    if (committed.committed) return result;
  }
  throw Object.assign(new Error("queue changed too frequently to commit"), { code: "HUB_QUEUE_CONFLICT" });
}

export async function loadQueue(hubRoot: string) {
  const backend = await redisQueueBackend(hubRoot);
  if (!backend) return await loadLocalQueue(hubRoot);
  return await redisQueueSnapshot(hubRoot, (await backend.readQueue()).serialized);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

function generateId() {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function hasIssueLink(metadata: QueueMetadata | null | undefined) {
  if (!metadata || typeof metadata !== "object") return false;
  return Boolean(metadata.issueNumber || metadata.issueUrl);
}

export function validateIssueLink(entry: QueueEntryInput | null | undefined) {
  if (!entry) return { linked: false, reason: "no entry" };
  if (entry.status === "needs_issue_link") return { linked: false, reason: "awaiting issue link" };
  if (entry.status === "archived") return { linked: false, reason: "archived" };
  return { linked: hasIssueLink(entry.metadata), reason: null };
}

function entryKey(entry: QueueEntryInput) {
  const lineage = entry.metadata?.queueDedupeKey || entry.metadata?.originJobId || "";
  return `${entry.projectId}::${entry.description}::${lineage}`;
}

export async function enqueue(hubRoot: string, input: QueueEntryInput = {}) {
  if (!input.projectId) throw new Error("projectId is required");
  const projectId = input.projectId;

  const rawMeta = buildMeta(input);
  const meta = {
    sourcePath: stringOrNull(rawMeta.sourcePath),
    sessionId: stringOrNull(rawMeta.sessionId),
    workerId: stringOrNull(rawMeta.workerId),
    cwd: stringOrNull(rawMeta.cwd),
  };
  const normalizedInput: QueueEntryInput = {
    ...input,
    projectId,
    sourcePath: meta.sourcePath,
    sessionId: meta.sessionId,
    workerId: meta.workerId,
    cwd: meta.cwd,
    executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
  };
  if (!normalizedInput.metadata) normalizedInput.metadata = {};
  normalizedInput.metadata.acpProfile = normalizedInput.metadata.acpProfile || "headless";
  normalizedInput.metadata.uiLane = Boolean(normalizedInput.metadata.uiLane);
  normalizedInput.metadata.uiLaneReason = normalizedInput.metadata.uiLaneReason || "";
  if (normalizedInput.metadata.acpProfile === "ui" && !normalizedInput.metadata.uiLaneReason) {
    throw new Error("ui profile requires a non-empty uiLaneReason in queue metadata");
  }

  // Resolve agent config from hub + project + metadata overrides
  const cpbRoot = normalizedInput.cwd || process.cwd();
  const resolvedMeta = await resolveAgentsForEntry(hubRoot, cpbRoot, projectId, normalizedInput.metadata);
  normalizedInput.metadata = resolvedMeta as QueueMetadata;

  // Resolve sourcePath from hub registry when not provided
  if (!meta.sourcePath) {
    try {
      const project = await getProject(hubRoot, projectId);
      if (project?.sourcePath) {
        meta.sourcePath = project.sourcePath;
        normalizedInput.sourcePath = project.sourcePath;
        if (!normalizedInput.cwd) normalizedInput.cwd = project.sourcePath;
      }
    } catch { /* project not found in registry — keep null */ }
  }

  return withQueueMutation(hubRoot, async (queue, authorityNowMs) => {
    const key = entryKey(normalizedInput);
    const existing = queue.entries.find((e) => entryKey(e) === key && e.status === "pending");
    if (existing) return existing;

    const entry: QueueEntry = {
      id: generateId(),
      projectId,
      sourcePath: meta.sourcePath,
      sessionId: meta.sessionId,
      workerId: meta.workerId,
      cwd: meta.cwd,
      executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
      type: normalizedInput.type || "candidate",
      status: "pending",
      priority: normalizedInput.priority || "P2",
      description: normalizedInput.description || "",
      metadata: normalizedInput.metadata || {},
      claimedBy: null,
      claimedAt: null,
      createdAt: nowIso(authorityNowMs),
      updatedAt: nowIso(authorityNowMs),
    };

    queue.entries.push(entry);
    return entry;
  });
}

export async function peekQueue(hubRoot: string) {
  const queue = await loadQueue(hubRoot);
  const pending = queue.entries.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;

  pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt));
  return pending[0];
}

export async function updateEntry(
  hubRoot: string,
  entryId: string,
  patch: QueueEntryInput = {},
  guard: QueueUpdateGuard = {},
  options: { leaderFence?: RedisLeaderFence | null } = {},
) {
  return withQueueMutation(hubRoot, async (queue, authorityNowMs) => {
    const entry = queue.entries.find((e) => e.id === entryId);
    if (!entry) return null;

    const expectedStatuses = Array.isArray(guard.expectedStatus)
      ? guard.expectedStatus
      : guard.expectedStatus === undefined
        ? null
        : [guard.expectedStatus];
    if (expectedStatuses && !expectedStatuses.includes(String(entry.status || ""))) return null;
    if (
      Object.prototype.hasOwnProperty.call(guard, "expectedClaimedAt")
      && (entry.claimedAt ?? null) !== guard.expectedClaimedAt
    ) return null;
    if (
      Object.prototype.hasOwnProperty.call(guard, "expectedUpdatedAt")
      && (entry.updatedAt ?? null) !== guard.expectedUpdatedAt
    ) return null;

    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
    if (patch.claimedBy !== undefined) entry.claimedBy = patch.claimedBy;
    if (patch.claimedAt !== undefined) entry.claimedAt = patch.claimedAt;
    if (patch.workerId !== undefined) entry.workerId = patch.workerId;
    if (patch.reason !== undefined) entry.reason = patch.reason;
    if (patch.completedAt !== undefined) entry.completedAt = patch.completedAt;
    if (entry.status === "pending") clearClaim(entry);
    entry.updatedAt = patch.updatedAt !== undefined ? patch.updatedAt : nowIso(authorityNowMs);

    return entry;
  }, options);
}

export async function listQueue(hubRoot: string, { status, projectId }: QueueEntryInput = {}) {
  const queue = await loadQueue(hubRoot);
  return queue.entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (projectId && e.projectId !== projectId) return false;
    return true;
  });
}

export async function syncBacklogResult(hubRoot: string, { projectId, description, result }: QueueEntryInput = {}) {
  if (!projectId || !description) return { synced: 0, entries: [] };
  const backlogResult = result || {};

  return withQueueMutation(hubRoot, async (queue) => {
    const targetStatus = backlogResult.ok ? "completed" : "failed";
    const key = entryKey({ projectId, description, metadata: {} });

    const matches = queue.entries.filter(
      (e) => entryKey(e) === key && (e.status === "pending" || e.status === "in_progress"),
    );

    if (matches.length === 0) return { synced: 0, entries: [] };

    const metadata: QueueMetadata = {
      syncedFrom: "backlog",
      backlogIssueId: backlogResult.backlogIssueId || null,
      syncReason: backlogResult.ok ? "backlog_completed" : "backlog_failed",
    };
    if (backlogResult.error) metadata.error = backlogResult.error;

    for (const entry of matches) {
      entry.status = targetStatus;
      entry.metadata = { ...entry.metadata, ...metadata };
      entry.updatedAt = nowIso();
    }

    return { synced: matches.length, entries: matches };
  });
}

export async function queueStatus(hubRoot: string) {
  const queue = await loadQueue(hubRoot);
  const failedTargetStatus = summarizeFailedTargets(queue.entries);
  const counts: QueueStatusSummary = {
    total: queue.entries.length,
    pending: 0,
    scheduled: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    needsIssueLink: 0,
    indexUnavailable: 0,
    codegraphUnavailable: 0,
    ...failedTargetStatus,
    activeMutatingTotal: 0,
    projects: {},
    activeProjects: [],
    eligibleQueued: 0,
    eligibleProjects: [],
  };
  for (const e of queue.entries) {
    if (e.status === "pending") counts.pending++;
    else if (e.status === "scheduled") counts.scheduled++;
    else if (e.status === "in_progress") counts.inProgress++;
    else if (e.status === "completed") counts.completed++;
    else if (e.status === "failed") counts.failed++;
    else if (e.status === "blocked") counts.blocked++;
    else if (e.status === "cancelled") counts.cancelled++;
    else if (e.status === "needs_issue_link") counts.needsIssueLink++;
    else if (isCodegraphUnavailableStatus(e.status)) {
      counts.indexUnavailable++;
      counts.codegraphUnavailable++;
    }
  }
  const hubLimits = await resolveHubConcurrencyLimits(hubRoot);
  const projectLimits = await resolveProjectConcurrencyLimits(
    hubRoot,
    queue.entries.map((entry) => entry.projectId),
    { maxActivePerProject: hubLimits.maxActivePerProject },
  );
  counts.activeMutatingTotal = queue.entries.filter(
    (entry) => isActiveEntry(entry) && isMutatingEntry(entry),
  ).length;
  counts.projects = buildProjectQueueStatus(queue.entries, {
    maxActivePerProject: hubLimits.maxActivePerProject,
    projectLimits,
  });
  const projects = counts.projects;
  counts.activeProjects = Object.entries(projects)
    .filter(([, ps]) => ps.activeMutating > 0)
    .map(([projectId, ps]) => ({ projectId, ...ps }));
  counts.eligibleQueued = 0;
  counts.eligibleProjects = [];
  for (const [pid, ps] of Object.entries(projects)) {
    counts.eligibleQueued += ps.eligiblePending;
    if (ps.eligiblePending > 0) counts.eligibleProjects.push(pid);
  }
  return counts;
}

const ACTIVE_RETRY_STATUSES = new Set(["pending", "scheduled", "in_progress"]);

function failedTargetKey(entry: QueueEntry) {
  const targetJobId = entry.type === "cli_retry"
    ? entry.metadata?.retryJobId
    : `job-${entry.id}`;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

function activeRetryTargetKey(entry: QueueEntry) {
  if (entry.type !== "cli_retry" || !ACTIVE_RETRY_STATUSES.has(entry.status)) return null;
  const targetJobId = entry.metadata?.retryJobId;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

function completedRetryTargetKey(entry: QueueEntry) {
  if (entry.type !== "cli_retry" || entry.status !== "completed") return null;
  const targetJobId = entry.metadata?.retryJobId;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

export function summarizeFailedTargets(entries: QueueEntry[] = []) {
  const failedTargets = new Set();
  const activeRetryTargets = new Set();
  const completedRetryTargets = new Set();
  for (const entry of entries) {
    const activeRetry = activeRetryTargetKey(entry);
    if (activeRetry) activeRetryTargets.add(activeRetry);
    const completedRetry = completedRetryTargetKey(entry);
    if (completedRetry) completedRetryTargets.add(completedRetry);
    if (entry.status === "failed") {
      const failedTarget = failedTargetKey(entry);
      if (failedTarget) failedTargets.add(failedTarget);
    }
  }

  let retryingFailedTargets = 0;
  let retriedFailedTargets = 0;
  for (const target of failedTargets) {
    if (activeRetryTargets.has(target)) {
      retryingFailedTargets++;
    } else if (completedRetryTargets.has(target)) {
      retriedFailedTargets++;
    }
  }
  return {
    failedEntries: entries.filter((entry) => entry.status === "failed").length,
    failedTargets: failedTargets.size,
    retryingFailedTargets,
    retriedFailedTargets,
    unretriedFailedTargets: failedTargets.size - retryingFailedTargets - retriedFailedTargets,
  };
}

function limitForProject(projectLimits: ProjectLimitMap | null | undefined, projectId: string, fallback: number) {
  if (projectLimits instanceof Map) {
    return positiveInt(projectLimits.get(projectId), fallback);
  }
  return positiveInt(projectLimits?.[projectId], fallback);
}

export function buildProjectQueueStatus(entries: QueueEntry[], {
  maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
  projectLimits = new Map(),
}: { maxActivePerProject?: number; projectLimits?: ProjectLimitMap } = {}) {
  const byProject: Record<string, ProjectQueueStatus> = {};
  for (const e of entries) {
    if (!byProject[e.projectId]) {
      const limit = limitForProject(projectLimits, e.projectId, maxActivePerProject);
      byProject[e.projectId] = {
        pending: 0, scheduled: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, indexUnavailable: 0, codegraphUnavailable: 0,
        activeMutating: 0, busy: false, busyReason: null,
        maxActivePerProject: limit,
        claimedBy: null, claimedAt: null, workerId: null,
        activeEntryIds: [],
        eligiblePending: 0, eligibleEntryIds: [],
      };
    }
    const ps = byProject[e.projectId];
    if (e.status === "pending") ps.pending++;
    else if (e.status === "scheduled") ps.scheduled++;
    else if (e.status === "in_progress") ps.inProgress++;
    else if (e.status === "completed") ps.completed++;
    else if (e.status === "failed") ps.failed++;
    else if (e.status === "blocked") ps.blocked++;
    else if (e.status === "cancelled") ps.cancelled++;
    else if (isCodegraphUnavailableStatus(e.status)) {
      ps.indexUnavailable++;
      ps.codegraphUnavailable++;
    }
    if (isActiveEntry(e) && isMutatingEntry(e)) {
      ps.activeMutating++;
      ps.activeEntryIds.push(e.id);
      ps.busy = true;
      ps.busyReason = e.status === "scheduled" ? "scheduled-mutating-task" : "active-mutating-task";
      ps.claimedBy = e.claimedBy;
      ps.claimedAt = e.claimedAt;
      ps.workerId = e.workerId;
    }
  }
  for (const [projectId, ps] of Object.entries(byProject)) {
    Object.assign(
      ps,
      summarizeFailedTargets(entries.filter((entry) => entry.projectId === projectId)),
    );
  }
  // Second pass: compute eligible pending entries
  for (const e of entries) {
    if (e.status !== "pending") continue;
    const ps = byProject[e.projectId];
    if (!isMutatingEntry(e)) {
      // Non-mutating pending entries are always eligible
      ps.eligiblePending++;
      ps.eligibleEntryIds.push(e.id);
    } else if (ps.activeMutating < ps.maxActivePerProject) {
      // Mutating pending entries eligible when project not at capacity
      ps.eligiblePending++;
      ps.eligibleEntryIds.push(e.id);
    } else {
      ps.busy = true;
      ps.busyReason = "project-active-mutating-cap";
    }
  }
  return byProject;
}

export async function claimEligible(hubRoot: string, opts: QueueClaimOptions = {}) {
  const {
    workerId = `worker-${process.pid}`,
    projectId = null,
    maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
    claimTimeoutMs = 120_000,
    providerSlotsAvailable = true,
    requireIssueLink = false,
    getProjectFn = null,
    cpbRoot = null,
    indexUnavailableRetryMs = 300_000,
    assignmentStore = null,
    leaderFence,
  } = opts;

  if (!providerSlotsAvailable) {
    return { entry: null, reason: "provider-slots-exhausted", recovered: [], activeProjects: [], skippedBusy: [] };
  }

  return withQueueMutation(hubRoot, async (queue, authorityNowMs) => {
    const { recovered, refreshed } = await recoverStaleInProgressAsync(queue.entries, {
      claimTimeoutMs,
      assignmentStore,
      nowMs: authorityNowMs,
    });
    const { recovered: recoveredIdx } = recoverCodegraphUnavailable(queue.entries, indexUnavailableRetryMs, authorityNowMs);
    if (recoveredIdx.length > 0) {
      recovered.push(...recoveredIdx);
    }

    const hubLimits = await resolveHubConcurrencyLimits(hubRoot, {
      maxActivePerProject,
    });

    const activeMutatingByProject: Record<string, number> = {};
    for (const e of queue.entries) {
      if (isActiveEntry(e) && isMutatingEntry(e)) {
        activeMutatingByProject[e.projectId] = (activeMutatingByProject[e.projectId] || 0) + 1;
      }
    }

    let pending = queue.entries.filter((e) => e.status === "pending");
    if (requireIssueLink) {
      pending = pending.filter((e) => hasIssueLink(e.metadata));
    }
    if (projectId) pending = pending.filter((e) => e.projectId === projectId);

    pending.sort((a, b) => {
      // Platform/architecture-fix entries get priority boost
      const aIsPlatformFix = /platform|architecture.fix/i.test(a.type || "") ? -1 : 0;
      const bIsPlatformFix = /platform|architecture.fix/i.test(b.type || "") ? -1 : 0;
      if (aIsPlatformFix !== bIsPlatformFix) return aIsPlatformFix - bIsPlatformFix;
      return priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt);
    });

    const projectLimits = await resolveProjectConcurrencyLimits(
      hubRoot,
      queue.entries.map((entry) => entry.projectId),
      { maxActivePerProject: hubLimits.maxActivePerProject, getProjectFn },
    );

    let chosen: QueueEntry | null = null;
    let reason: string | null = null;
    const skippedBusy: string[] = [];
    const indexUnavailableIds: string[] = [];

    for (const candidate of pending) {
      if (isMutatingEntry(candidate)) {
        const projectLimit = limitForProject(projectLimits, candidate.projectId, maxActivePerProject);
        if ((activeMutatingByProject[candidate.projectId] || 0) >= projectLimit) {
          if (!skippedBusy.includes(candidate.projectId)) skippedBusy.push(candidate.projectId);
          continue;
        }
      }

      // Index freshness gate: when getProjectFn is provided, check freshness
      // for registered projects. Unregistered projects skip the gate.
      if (getProjectFn) {
        const project = await getProjectFn(hubRoot, candidate.projectId);
        if (project && (!project.sourcePath || !project.projectRuntimeRoot)) {
          candidate.status = "codegraph_unavailable";
          candidate.updatedAt = nowIso();
          candidate.metadata = {
            ...candidate.metadata,
            indexFreshness: {
              available: false,
              indexDirty: true,
              indexStale: false,
              worktreeDirty: false,
              dirtyReasons: ["missing_source_or_runtime_root"],
            },
          };
          indexUnavailableIds.push(candidate.id);
          continue;
        }
        if (project?.sourcePath && project.projectRuntimeRoot) {
          const capabilityGate = projectCapabilityMapGate(project);
          if (!capabilityGate.available) {
            candidate.status = "codegraph_unavailable";
            candidate.updatedAt = nowIso();
            candidate.metadata = {
              ...candidate.metadata,
              capabilityMap: capabilityGate,
              indexFreshness: {
                available: false,
                indexDirty: true,
                indexStale: false,
                worktreeDirty: false,
                dirtyReasons: [capabilityGate.reason],
              },
            };
            indexUnavailableIds.push(candidate.id);
            continue;
          }

          let codegraphReadiness;
          try {
            codegraphReadiness = await checkCodeGraphReady({
              cpbRoot: cpbRoot || project.cpbRoot || project.metadata?.cpbRoot || project.sourcePath,
              sourcePath: project.sourcePath,
            });
          } catch (err) {
            const { reason, details } = errorDetails(err);
            candidate.status = "codegraph_unavailable";
            candidate.updatedAt = nowIso();
            candidate.metadata = {
              ...candidate.metadata,
              codegraphReadiness: {
                available: false,
                reason,
                details,
              },
              indexFreshness: {
                available: false,
                indexDirty: true,
                indexStale: false,
                worktreeDirty: false,
                dirtyReasons: [reason],
              },
            };
            indexUnavailableIds.push(candidate.id);
            continue;
          }

          const fresh = await ensureIndexFresh(project);
          if (!fresh.available) {
            candidate.status = "codegraph_unavailable";
            candidate.updatedAt = nowIso();
            candidate.metadata = {
              ...candidate.metadata,
              indexFreshness: {
                available: false,
                indexDirty: fresh.indexDirty ?? true,
                indexStale: fresh.indexStale ?? false,
                worktreeDirty: fresh.worktreeDirty ?? false,
                dirtyReasons: fresh.dirtyReasons ?? ["codegraph_unavailable"],
              },
            };
            indexUnavailableIds.push(candidate.id);
            continue;
          }
          candidate.indexSnapshotId = fresh.indexSnapshotId;
          candidate.metadata = {
            ...candidate.metadata,
            codegraphReadiness: {
              available: true,
              sourcePath: codegraphReadiness.sourcePath,
              indexFile: codegraphReadiness.indexFile,
            },
            indexSnapshot: {
              indexSnapshotId: fresh.indexSnapshotId,
              sourceFingerprint: fresh.sourceFingerprint,
              indexFreshness: {
                available: true,
                indexDirty: false,
                indexStale: false,
                worktreeDirty: fresh.worktreeDirty ?? false,
                dirtyReasons: [],
              },
            },
          };
        }
      }

      chosen = candidate;
      break;
    }

    if (!chosen) {
      const projectStatus = buildProjectQueueStatus(queue.entries, {
        maxActivePerProject: hubLimits.maxActivePerProject,
        projectLimits,
      });
      const activeProjects = Object.entries(projectStatus)
        .filter(([, ps]) => ps.activeMutating > 0)
        .map(([pid, ps]) => ({ projectId: pid, ...ps }));
      if (pending.length === 0 && !projectId) {
        reason = "no-pending-entries";
      } else if (pending.length === 0 && projectId) {
        reason = "no-pending-for-project";
      } else {
        reason = "all-projects-busy";
      }
      return { entry: null, reason, recovered, activeProjects, skippedBusy };
    }

    const now = nowIso(authorityNowMs);
    chosen.status = "in_progress";
    chosen.claimedBy = workerId;
    chosen.workerId = workerId;
    chosen.claimedAt = now;
    chosen.updatedAt = now;

    const projectStatus = buildProjectQueueStatus(queue.entries, {
      maxActivePerProject: hubLimits.maxActivePerProject,
      projectLimits,
    });
    const activeProjects = Object.entries(projectStatus)
      .filter(([, ps]) => ps.activeMutating > 0)
      .map(([pid, ps]) => ({ projectId: pid, ...ps }));

    return { entry: chosen, reason: null, recovered, activeProjects, skippedBusy };
  // Readiness preparation can refresh CodeGraph manifests. Do not replay that
  // external work after a queue CAS loss; the caller will retry on its next
  // poll with a fresh queue snapshot.
  }, { leaderFence, maxAttempts: 1 });
}

// ─── auto-enqueue.ts ────────────────────────────────────────────────────────

import { readGithubIssues } from "../github/github-issues.js";

export function matchAutomationRule(issue: AutomationIssue, rules: AutomationRule[]) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  for (const rule of rules) {
    const m = rule.match || {};
    if (m.labels && Array.isArray(m.labels)) {
      const issueLabels = new Set(issue.labels || []);
      const hasAll = m.labels.every((l: string) => issueLabels.has(l));
      if (!hasAll) continue;
    }
    if (m.titlePattern) {
      try {
        if (!new RegExp(m.titlePattern, "i").test(issue.title || "")) continue;
      } catch {
        continue;
      }
    }
    return rule;
  }
  return null;
}

export function isExcluded(issue: AutomationIssue, exclude: AutomationExclude | null | undefined) {
  if (!exclude) return false;
  if (exclude.labels && Array.isArray(exclude.labels)) {
    const issueLabels = new Set(issue.labels || []);
    if (exclude.labels.some((l: string) => issueLabels.has(l))) return true;
  }
  return false;
}

export function issueToNormalizedEvent(issue: AutomationIssue, project: AutomationProject) {
  return {
    status: "ok",
    type: "github_issue",
    event: "issues",
    action: "opened",
    delivery: `auto-enqueue-${Date.now()}-${issue.number}`,
    repo: project.github?.fullName || issue.repository || "",
    projectId: project.id,
    issueNumber: issue.number,
    actor: "auto-enqueue",
    labels: issue.labels || [],
    url: issue.url || "",
    title: issue.title || "",
    body: issue.body || "",
  };
}

function issueMatchesProject(issue: AutomationIssue, project: AutomationProject) {
  if (issue.projectId === project.id) return true;
  if (issue.projectId && issue.projectId !== "flow") return false;
  const repo = project.github?.fullName;
  return Boolean(repo && (issue.repository || issue.repo || issue.repositoryFullName) === repo);
}

function issueQueueKey(repo: string | null | undefined, number: string | number | null | undefined) {
  return `${repo || ""}#${Number(number)}`;
}

export async function autoEnqueueSyncedIssues(hubRoot: string, cpbRoot: string, projectId: string, { createJobFn = null, dryRun = false }: { createJobFn?: ((...args: unknown[]) => unknown) | null; dryRun?: boolean } = {}) {
  const project = await getProject(hubRoot, projectId);
  if (!project) return { error: `Project '${projectId}' not found`, enqueued: 0, skipped: 0, duplicates: 0, total: 0 };

  const automation = project.github?.automation;
  if (!automation?.enabled) return { enqueued: 0, skipped: 0, duplicates: 0, total: 0, reason: "automation not enabled" };

  const issues: AutomationIssue[] = await readGithubIssues(hubRoot);
  const projectIssues = issues.filter((i) => i.state === "OPEN" && issueMatchesProject(i, project));

  const queue = await loadQueue(hubRoot);
  const queuedIssueKeys = new Set(
    queue.entries
      .filter((e) => e.projectId === project.id && e.metadata?.issueNumber && (e.type === "github_issue" || e.metadata?.source === "github"))
      .map((e) => issueQueueKey(e.metadata?.repo || e.metadata?.repository || project.github?.fullName, e.metadata.issueNumber)),
  );

  let enqueued = 0;
  let skipped = 0;
  let duplicates = 0;
  const matched = [];

  for (const issue of projectIssues) {
    // issue comes from normalizeGithubIssue() which emits `repository`, never `repo` — drop dead fallback
    const key = issueQueueKey(issue.repository || project.github?.fullName, issue.number);
    if (queuedIssueKeys.has(key)) { duplicates++; continue; }
    if (isExcluded(issue, automation.exclude)) { skipped++; continue; }

    const rule = matchAutomationRule(issue, automation.rules);
    if (!rule) { skipped++; continue; }

    matched.push({ number: issue.number, title: issue.title, rule: rule.name, action: rule.action });

    if (dryRun) { enqueued++; continue; }

    try {
      const event = issueToNormalizedEvent(issue, project);
      const match = { matched: true, workflow: rule.action?.workflow || "standard", ...(rule.action || {}) };
      if (createJobFn) {
        await createJobFn(cpbRoot, event, match, { hubRoot, sourcePath: project.sourcePath });
      } else {
        const { createGithubIssueQueueJob } = await import("../event/event-source.js");
        await createGithubIssueQueueJob(cpbRoot, event, match, { hubRoot, sourcePath: project.sourcePath });
      }
      enqueued++;
    } catch (err) {
      const message = isRecord(err) && typeof err.message === "string" ? err.message : "";
      if (message.includes("duplicate")) { duplicates++; }
      else { skipped++; }
    }
  }

  return { enqueued, skipped, duplicates, total: projectIssues.length, matched: dryRun ? matched : undefined };
}

// ─── inbox-mail.ts ──────────────────────────────────────────────────────────

import { readdir } from "node:fs/promises";

const SCHEMA = "cpb.inbox-mail.v1";
const VALID_STATUSES = new Set(["pending", "acknowledged", "completed"]);
const VALID_TRANSITIONS: Record<string, string> = {
  pending: "acknowledged",
  acknowledged: "completed",
};

function inboxDir(cpbRoot: string, project: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "inbox");
}

function safeId(id: string | null | undefined) {
  if (!id || typeof id !== "string") return false;
  if (id.includes("..") || id.includes("/") || id.includes(path.sep) || id.includes("\\")) return false;
  if (!/^msg-\d{8}-\d{6}-[0-9a-f]{4,}$/.test(id)) return false;
  return true;
}

function safeMessagePath(cpbRoot: string, project: string, id: string) {
  const dir = inboxDir(cpbRoot, project);
  const resolved = path.resolve(dir, `${id}.md`);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error("invalid message id: path escape");
  }
  return resolved;
}

let _seq = 0;
const _pidHex = process.pid.toString(16).padStart(4, "0");
function generateMessageId() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const seq = String(++_seq).padStart(6, "0");
  return `msg-${y}${m}${d}-${seq}-${_pidHex}`;
}

function serializeFrontmatter(meta: LooseRecord) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) {
      lines.push(`${key}: ""`);
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function parseFrontmatter(raw: string) {
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("---", 3);
  if (end === -1) return null;

  const fmText = raw.slice(3, end).trim();
  const content = raw.slice(end + 3).trimStart();
  const meta: LooseRecord = {};

  for (const line of fmText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    try {
      meta[key] = JSON.parse(value);
    } catch {
      meta[key] = value.replace(/^"|"$/g, "");
    }
  }

  return { meta, content };
}

async function withInboxLock<T>(cpbRoot: string, project: string, callback: () => Promise<T>): Promise<T> {
  const dir = inboxDir(cpbRoot, project);
  const lockDir = `${dir}.lock`;
  await mkdir(dir, { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || (err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Check staleness (30s)
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= 30_000) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  if (!acquired) {
    throw new Error(`inbox lock busy for project: ${project}`);
  }

  try {
    return await callback();
  } finally {
    try {
      await rm(lockDir, { recursive: true, force: true });
    } catch {
      // Already cleaned up
    }
  }
}

interface InboxMessageOutput {
  id: string;
  type: string;
  project: string;
  jobId: string;
  phase: string;
  from: string;
  to: string;
  status: string;
  owner: string;
  locator: LooseRecord;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

function messageToOutput(meta: LooseRecord): InboxMessageOutput {
  return { ...meta } as InboxMessageOutput;
}

export async function writeInboxMessage(cpbRoot: string, project: string, input: InboxMessageInput) {
  const id = generateMessageId();
  const ts = nowIso();

  const meta = {
    schema: SCHEMA,
    id,
    type: input.type || "plan",
    project,
    jobId: input.jobId || "",
    phase: input.phase || input.type || "plan",
    from: input.from || "",
    to: input.to || "",
    status: "pending",
    owner: "",
    locator: input.locator || {},
    createdAt: ts,
    updatedAt: ts,
  };

  const content = input.content || "";
  const fileContent = `${serializeFrontmatter(meta)}\n${content}\n`;
  const filePath = safeMessagePath(cpbRoot, project, id);

  await withInboxLock(cpbRoot, project, async () => {
    await writeAtomic(filePath, fileContent);
  });

  return messageToOutput(meta);
}

export async function listInboxMessages(cpbRoot: string, project: string, filters: InboxMessageFilters = {}) {
  const dir = inboxDir(cpbRoot, project);
  let files;
  try {
    files = (await readdir(dir))
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }

  const messages = [];
  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const msg = parsed.meta;

      if (filters.type && msg.type !== filters.type) continue;
      if (filters.status && msg.status !== filters.status) continue;
      if (filters.to && msg.to !== filters.to) continue;
      if (filters.owner && msg.owner !== filters.owner) continue;
      if (filters.jobId && msg.jobId !== filters.jobId) continue;

      messages.push(messageToOutput(msg));
    } catch {
      // Skip unreadable files
    }
  }

  // Sort by createdAt to guarantee creation order (filename hex suffix is random)
  messages.sort((a, b) => a.id.localeCompare(b.id));
  return messages;
}

export async function readInboxMessage(cpbRoot: string, project: string, id: string) {
  if (!safeId(id)) return null;
  const filePath = safeMessagePath(cpbRoot, project, id);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;
    return { ...messageToOutput(parsed.meta), content: parsed.content };
  } catch {
    return null;
  }
}

export async function ackInboxMessage(cpbRoot: string, project: string, id: string, { owner }: InboxAckOptions = {}) {
  if (!safeId(id)) return null;
  return withInboxLock(cpbRoot, project, async () => {
    const filePath = safeMessagePath(cpbRoot, project, id);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const currentStatus = String(parsed.meta.status || "");
    const expected = VALID_TRANSITIONS[currentStatus];
    if (expected !== "acknowledged") {
      throw new Error(`invalid transition: ${currentStatus} -> acknowledged`);
    }

    parsed.meta.status = "acknowledged";
    parsed.meta.owner = owner || "";
    parsed.meta.updatedAt = nowIso();

    const fileContent = `${serializeFrontmatter(parsed.meta)}\n${parsed.content}\n`;
    await writeAtomic(filePath, fileContent);

    return messageToOutput(parsed.meta);
  });
}

export async function completeInboxMessage(cpbRoot: string, project: string, id: string) {
  if (!safeId(id)) return null;
  return withInboxLock(cpbRoot, project, async () => {
    const filePath = safeMessagePath(cpbRoot, project, id);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    const currentStatus = String(parsed.meta.status || "");
    const expected = VALID_TRANSITIONS[currentStatus];
    if (expected !== "completed") {
      throw new Error(`invalid transition: ${currentStatus} -> completed`);
    }

    parsed.meta.status = "completed";
    parsed.meta.updatedAt = nowIso();

    const fileContent = `${serializeFrontmatter(parsed.meta)}\n${parsed.content}\n`;
    await writeAtomic(filePath, fileContent);

    return messageToOutput(parsed.meta);
  });
}
