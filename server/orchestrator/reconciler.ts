import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { FailureKind } from "../../core/contracts/failure.js";
import { writeJsonAtomic } from "../../shared/fs-utils.js";
import { createLogger } from "../../shared/logger.js";
import { recordValue, type LooseRecord } from "../../core/contracts/types.js";
import { selectFailureRecovery } from "../../core/contracts/failure-recovery.js";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../core/runtime/process-tree.js";
import { readBoundedRegularFileNoFollow } from "../../core/runtime/durable-directory-lock.js";
import {
  finalizerResultMatchesCandidate,
  verifyFinalizerCandidateCommit,
  verifyFinalizerCandidateObject,
  validatedFinalizerCandidate,
} from "../../shared/orchestrator/finalizer-candidate.js";
import { verifiedCanonicalReviewBundlePath } from "../../shared/orchestrator/review-bundle-path.js";
import {
  finalizerMutationFenceDigest,
  validateFinalizerMutationReceipt,
} from "../services/finalizer-contract.js";
import {
  finalizerJournalDigest,
  readFinalizerJournal,
} from "../services/finalizer-journal.js";
import { resolveProjectDataRoot } from "../services/runtime.js";

type ReconcilerRecord = LooseRecord & {
  assignmentId?: string;
  entryId?: string;
  projectId?: string;
  status?: string;
  workerId?: string | null;
  attempt?: number;
  attempts?: number;
  attemptToken?: string;
  orchestratorEpoch?: number;
  createdAt?: string | number;
  updatedAt?: string | number;
  queueFinalizedAt?: string | null;
  workerFinalizedAt?: string | null;
  metadata?: ReconcilerRecord;
  sourceContext?: ReconcilerRecord | string | null;
  failureCount?: number;
  retry?: ReconcilerRecord;
  previousFailure?: ReconcilerRecord;
  verification?: ReconcilerRecord;
  retryScope?: unknown;
  previousOutput?: string;
  jobResult?: ReconcilerRecord;
  failure?: ReconcilerRecord;
  cause?: ReconcilerRecord;
  verdict?: ReconcilerRecord | string;
  artifact?: ReconcilerRecord | string;
  checklistVerdict?: ReconcilerRecord;
  result?: string;
  checklistId?: string;
  evidenceRefs?: unknown[];
  fixScope?: unknown[];
  stderrSnippet?: unknown;
  rawOutput?: unknown;
  stdoutTail?: unknown;
  stderrTail?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  checks?: ReconcilerRecord[];
  kind?: string;
  reason?: string;
  phase?: string | null;
  retryable?: boolean;
  retryPhase?: string | null;
  action?: string;
  activePhase?: string | null;
  activeJobId?: string | null;
  progressUpdatedAt?: string;
  lastProgressAt?: string;
  phaseUpdatedAt?: string;
  lastProgressType?: string | null;
  progressKind?: string | null;
  worktreePath?: string | null;
  path?: string | null;
  exists?: boolean;
  gitStatus?: string | null;
  gitStatusError?: string;
  pid?: number | null;
  processIdentity?: ReconcilerRecord | ProcessIdentity | null;
  host?: string | null;
  lastHeartbeatAt?: string | null;
  currentAssignmentId?: string | null;
  waitUseful?: boolean;
  level?: string;
  shouldFail?: boolean;
  failureSignals?: string[];
  attemptFiles?: ReconcilerRecord;
  workerLog?: ReconcilerRecord | null;
  worktree?: ReconcilerRecord | string | null;
  resultExists?: boolean;
  resultReadable?: boolean | null;
  acceptedExists?: boolean;
  heartbeatExists?: boolean;
  indicatesFailedJob?: boolean;
  tail?: string;
  workflow?: string;
  planMode?: string;
  params?: ReconcilerRecord;
  issueNumber?: string | number;
  targetChecklistIds?: unknown[];
  lockedPassedChecklistIds?: unknown[];
  previousEvidenceRefs?: unknown[];
};

type ReconcilerStore = {
  listAssignments: () => Promise<ReconcilerRecord[]>;
  getActiveAttempt: (assignmentId: string) => Promise<ReconcilerRecord | null>;
  markRunning: (assignmentId: string, attempt: number) => Promise<unknown>;
  writeSyntheticFailure: (assignmentId: string, attempt: number, result: ReconcilerRecord) => Promise<unknown>;
  completeAttemptFromExistingResult: (assignmentId: string, attempt: number, result: ReconcilerRecord) => Promise<unknown>;
  markFinalized: (assignmentId: string, kind: string) => Promise<unknown>;
};

type WorkerStore = {
  listWorkers: () => Promise<ReconcilerRecord[]>;
  getWorker: (workerId: string) => Promise<ReconcilerRecord | null>;
  updateWorker: (workerId: string, updates: ReconcilerRecord) => Promise<unknown>;
  updateWorkerIf?: (workerId: string, updates: ReconcilerRecord, expected: Record<string, unknown>) => Promise<unknown>;
  authorityTimeMs?: () => Promise<number>;
};

type WorkerSupervisor = {
  startWorker?: (assignment: ReconcilerRecord) => Promise<unknown>;
  stopWorker: (workerId: string, reason?: string) => Promise<unknown>;
};

type FailureRouteContext = {
  assignment: ReconcilerRecord;
  attempt: ReconcilerRecord;
  result: ReconcilerRecord;
};

type FailureRouter = {
  route: (ctx: FailureRouteContext) => Promise<LooseRecord>;
  resetBudget: (entryId: string) => void;
};

type ReconcilerOptions = {
  assignmentStore: ReconcilerStore;
  workerStore: WorkerStore;
  workerSupervisor?: WorkerSupervisor | null;
  leaderLock: { stillHeld: () => Promise<boolean> };
  failureRouter: FailureRouter | ReconcilerRecord;
  hubRoot?: string;
  cpbRoot?: string;
  progressInfoMs?: unknown;
  progressWarnMs?: unknown;
  progressErrorMs?: unknown;
  progressForceRetryMs?: unknown;
  progressStaleMs?: unknown;
};

const execFile = promisify(execFileCallback);
const HEARTBEAT_STALE_MS = 60_000;
const ATTEMPT_RESULT_MAX_BYTES = 16 * 1024 * 1024;
const FINALIZER_RECOVERY_SCHEMA = "cpb.finalizer-recovery.v1";
const FINALIZER_HANDOFF_SCHEMA = "cpb.finalizer-handoff.v1";
const FINALIZER_HANDOFF_EVIDENCE_SCHEMA = "cpb.finalizer-handoff-evidence.v1";
const FINALIZER_READ_ONLY_RECOVERY_LIMIT = 3;
const FINALIZER_MUTATION_RECOVERY_LIMIT = 2;
const FINALIZER_RECOVERY_BACKOFF_BASE_MS = 5_000;
const FINALIZER_RECOVERY_BACKOFF_MAX_MS = 60_000;
const ASSIGN_ACCEPT_TTL_MS = 120_000;
const DEFAULT_PROGRESS_INFO_MS = 5 * 60_000;
const DEFAULT_PROGRESS_WARN_MS = 15 * 60_000;
const DEFAULT_PROGRESS_ERROR_MS = 30 * 60_000;
const DEFAULT_PROGRESS_FORCE_RETRY_MS = 35 * 60_000;
const NON_REUSABLE_WORKER_STATUSES = new Set(["dead", "exited", "unhealthy", "draining"]);
const PREVIOUS_OUTPUT_MAX = 4000;
const PROGRESS_PROBE_LOG_TAIL = 6000;
const PROGRESS_ALERT_RANK: Record<string, number> = { info: 1, warn: 2, error: 3, force: 4 };
const PROGRESS_PROBE_DEPTH: Record<string, string> = { info: "heartbeat", warn: "worker", error: "deep", force: "deep" };
const PROGRESS_PROBE_INTERVAL_MS: Record<string, number> = { info: 5 * 60_000, warn: 60_000, error: 60_000, force: 0 };
const DEEP_PROGRESS_PROBE_LEVELS = new Set(["error", "force"]);
const WAITLESS_LOG_PATTERNS = [
  /\bjob failed\b/i,
  /\bfatal\b/i,
  /\buncaught\b/i,
  /\bunhandled\b/i,
  /\bEADDRINUSE\b/,
  /\bENOENT\b/,
];


function resolveProgressThresholdMs(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function truncateText(value: unknown, maxChars = PREVIOUS_OUTPUT_MAX) {
  const text = String(value || "");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function compactText(value: unknown, maxChars = 500) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactStructuredValue(value: unknown, { maxItems = 8, maxChars = 500 }: Record<string, number> = {}): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return compactText(value, maxChars);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((item) => compactStructuredValue(item, { maxItems, maxChars }));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxItems)
      .map(([key, item]) => [key, compactStructuredValue(item, { maxItems, maxChars })]),
  );
}

function compactVerifierArtifact(artifact: ReconcilerRecord): ReconcilerRecord | null {
  if (!artifact || typeof artifact !== "object") return null;
  return {
    kind: artifact.kind || null,
    id: artifact.id || null,
    name: artifact.name || null,
    path: artifact.path || null,
    bytes: artifact.bytes ?? null,
    sha256: artifact.sha256 || null,
  };
}

function compactVerifierVerdict(verdict: ReconcilerRecord) {
  if (!verdict || typeof verdict !== "object") return null;
  const blocking = Array.isArray(verdict.blocking)
    ? compactStructuredValue(verdict.blocking, { maxItems: 8, maxChars: 500 })
    : [];
  const retryScope = Array.isArray(verdict.fix_scope)
    ? compactStructuredValue(verdict.fix_scope, { maxItems: 8, maxChars: 500 })
    : [];
  return {
    status: verdict.status || null,
    confidence: verdict.confidence ?? null,
    reason: compactText(verdict.reason),
    summary: compactText(verdict.summary),
    taskGoal: compactText(verdict.task_goal),
    executorSummary: compactText(verdict.executor_summary),
    diffSummary: compactText(verdict.diff_summary),
    layers: verdict.layers && typeof verdict.layers === "object"
      ? compactStructuredValue(verdict.layers, { maxItems: 8, maxChars: 500 })
      : null,
    blocking,
    retryScope,
    blockingMissingInputs: Array.isArray(verdict.blockingMissingInputs)
      ? compactStructuredValue(verdict.blockingMissingInputs, { maxItems: 8, maxChars: 500 })
      : [],
  };
}

function verificationRetryContext(failure: ReconcilerRecord) {
  const cause = recordValue(failure?.cause);
  const verdict = compactVerifierVerdict(recordValue(cause.verdict || failure?.verdict));
  const artifact = compactVerifierArtifact(recordValue(cause.artifact || failure?.artifact));
  if (!verdict && !artifact) return null;
  // Extract checklist retry state from checklistVerdict in failure cause
  const verdictRecord = recordValue(cause.verdict);
  const checklistVerdict = recordValue(verdictRecord.checklistVerdict || cause.checklistVerdict);
  const checklistItems = Array.isArray(checklistVerdict?.items) ? checklistVerdict.items : [];
  const failedChecklistIds = checklistItems.filter((item: ReconcilerRecord) => item.result === "fail").map((item: ReconcilerRecord) => item.checklistId).filter(Boolean);
  const uncheckedChecklistIds = checklistItems.filter((item: ReconcilerRecord) => item.result === "unchecked").map((item: ReconcilerRecord) => item.checklistId).filter(Boolean);
  const passedChecklistIds = checklistItems.filter((item: ReconcilerRecord) => item.result === "pass").map((item: ReconcilerRecord) => item.checklistId).filter(Boolean);
  const previousEvidenceRefs = checklistItems.filter((item: ReconcilerRecord) => item.result === "pass").flatMap((item: ReconcilerRecord) => Array.isArray(item.evidenceRefs) ? item.evidenceRefs : []);
  const checklistFixScope = [...new Set([
    ...(Array.isArray(checklistVerdict?.fixScope) ? checklistVerdict.fixScope : []),
    ...checklistItems.flatMap((item: ReconcilerRecord) => Array.isArray(item.fixScope) ? item.fixScope : []),
  ].filter(Boolean))];
  const targetChecklistIds = [...new Set([...failedChecklistIds, ...uncheckedChecklistIds])];
  const lockedPassedChecklistIds = passedChecklistIds;
  return {
    verdict,
    artifact,
    retryScope: [...new Set([...(Array.isArray(verdict?.retryScope) ? verdict.retryScope : []), ...checklistFixScope])],
    checklistVerdict: checklistVerdict ? {
      failedChecklistIds,
      uncheckedChecklistIds,
      lockedPassedChecklistIds,
      previousEvidenceRefs,
      targetChecklistIds,
      fixScope: checklistFixScope,
    } : null,
  };
}

function summarizeBlockingForRetry(blocking: unknown): string[] {
  if (!Array.isArray(blocking) || blocking.length === 0) return [];
  return blocking.map((entry) => {
    if (typeof entry === "string") return `- ${entry}`;
    if (!entry || typeof entry !== "object") return `- ${String(entry)}`;
    const parts: string[] = [];
    if (entry.criterion) parts.push(entry.criterion);
    if (entry.file) parts.push(`file: ${entry.file}`);
    if (entry.evidence) parts.push(`evidence: ${entry.evidence}`);
    if (entry.fix_hint || entry.fixHint) parts.push(`hint: ${entry.fix_hint || entry.fixHint}`);
    return `- ${parts.join(" | ") || JSON.stringify(entry)}`;
  });
}

function verifierRetryOutputChunk(failure: ReconcilerRecord) {
  const verification = verificationRetryContext(failure);
  if (!verification) return "";
  const verdict: ReconcilerRecord = verification.verdict || {};
  const lines = [
    "Verifier verdict:",
    verdict.status ? `status: ${verdict.status}` : "",
    verdict.reason ? `reason: ${verdict.reason}` : "",
    verdict.summary ? `summary: ${verdict.summary}` : "",
  ];
  const blocking = summarizeBlockingForRetry(verdict.blocking);
  if (blocking.length) lines.push("blocking:", ...blocking);
  if (verification.retryScope.length) lines.push("retry scope:", ...verification.retryScope.map((scope) => `- ${scope}`));
  if (verification.artifact?.path) lines.push(`verdict artifact: ${verification.artifact.path}`);
  return lines.filter(Boolean).join("\n");
}

function extractPreviousOutput(failure: ReconcilerRecord): string {
  const cause = failure?.cause || {};
  const chunks: string[] = [];
  const verifierChunk = verifierRetryOutputChunk(failure);
  if (verifierChunk) chunks.push(verifierChunk);
  if (failure?.stderrSnippet) chunks.push(`stderr snippet:\n${failure.stderrSnippet}`);
  if (cause.rawOutput) chunks.push(`raw output:\n${cause.rawOutput}`);
  if (cause.stdoutTail) chunks.push(`stdout tail:\n${cause.stdoutTail}`);
  if (cause.stderrTail) chunks.push(`stderr tail:\n${cause.stderrTail}`);
  if (cause.stdout) chunks.push(`stdout:\n${cause.stdout}`);
  if (cause.stderr) chunks.push(`stderr:\n${cause.stderr}`);
  if (cause.solver) chunks.push(`solver exhaustion:\n${JSON.stringify(cause.solver, null, 2)}`);
  if (Array.isArray(cause.checks)) {
    for (const check of cause.checks) {
      if (check?.stdoutTail) chunks.push(`${check.command || check.gate || "check"} stdout tail:\n${check.stdoutTail}`);
      if (check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} stderr tail:\n${check.stderrTail}`);
      if (check?.message && !check?.stdoutTail && !check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} message:\n${check.message}`);
    }
  }
  return truncateText(chunks.filter(Boolean).join("\n\n"));
}

function textOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finalizerCommittedTriState(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function expectedFinalizeMode(metadata: ReconcilerRecord): string {
  const nestedFinalize = recordValue(metadata.finalize);
  const nestedFinalizer = recordValue(metadata.finalizer);
  const requested = metadata.finalizeMode
    ?? metadata.finalizerMode
    ?? nestedFinalize.mode
    ?? nestedFinalizer.mode;
  const normalized = String(requested || "dry-run").trim().toLowerCase().replace(/_/g, "-");
  const liveAllowed = metadata.allowLiveFinalize === true
    || metadata.liveFinalize === true
    || nestedFinalize.allowLive === true
    || nestedFinalizer.allowLive === true;
  if (["dry-run", "dryrun", "preview", "pr-preview"].includes(normalized)) return "dry-run";
  if (liveAllowed && ["local", "remote", "pr"].includes(normalized)) return normalized;
  return "dry-run";
}

function canonicalFinalizerPrincipal(value: unknown): ReconcilerRecord | null {
  const principal = recordValue(value);
  const stableId = textOrNull(principal.stableId);
  const login = textOrNull(principal.login)?.toLowerCase() || null;
  if ((principal.kind !== "github_app" && principal.kind !== "gh_user") || !stableId || !login) return null;
  return { kind: principal.kind, stableId, login };
}

function canonicalFinalizerOperation(value: unknown, operation: string): boolean {
  const receipt = recordValue(value);
  return receipt.operation === operation
    && receipt.attempted === true
    && receipt.committed === true
    && Boolean(textOrNull(receipt.observedAt))
    && Boolean(textOrNull(receipt.eventId));
}

function sameCanonicalRecord(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as LooseRecord)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, nested]) => [key, canonical(nested)]));
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonicalFinalizerDigest(value: unknown): string {
  const canonical = (nested: unknown): unknown => {
    if (Array.isArray(nested)) return nested.map(canonical);
    if (!nested || typeof nested !== "object") return nested;
    return Object.fromEntries(Object.entries(nested as LooseRecord)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, child]) => [key, canonical(child)]));
  };
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function normalizedFinalizerHandoffEvidence(value: unknown): ReconcilerRecord {
  const evidence = recordValue(value);
  return {
    schema: evidence.schema,
    previousAssignmentId: evidence.previousAssignmentId,
    previousAttempt: evidence.previousAttempt,
    previousAttemptTokenDigest: evidence.previousAttemptTokenDigest,
    previousOrchestratorEpoch: evidence.previousOrchestratorEpoch,
    previousJobId: evidence.previousJobId,
    previousResultStatus: evidence.previousResultStatus,
    previousCommitted: evidence.previousCommitted,
    finalizationId: evidence.finalizationId,
    journalGeneration: evidence.journalGeneration,
    previousClaimId: evidence.previousClaimId,
    previousOwnerDigest: evidence.previousOwnerDigest,
    journalStage: evidence.journalStage,
    journalDigest: evidence.journalDigest,
    commit: evidence.commit,
    tree: evidence.tree,
  };
}

function safePartialFinalizerContinuation(mode: string, finalizeResultValue: unknown): boolean {
  const finalizeResult = recordValue(finalizeResultValue);
  const intent = recordValue(finalizeResult.remoteIntent);
  const receipts = recordValue(intent.receipts);
  const reconciliation = recordValue(finalizeResult.reconciliation);
  const proof = recordValue(finalizeResult.safeContinuation);
  const matrix: Record<string, { operation: string; readbackKey: string; readback: unknown }> = mode === "remote"
    ? {
        claimed: { operation: "repository.push", readbackKey: "journal", readback: reconciliation.journal },
        "repository.push.intent": { operation: "repository.push", readbackKey: "push", readback: reconciliation.push },
        "repository.push.receipt": { operation: "repository.push", readbackKey: "receipts.push", readback: receipts.push },
        "issue.close.intent": { operation: "issue.close", readbackKey: "issueClose", readback: reconciliation.issueClose },
        "issue.close.receipt": { operation: "issue.close", readbackKey: "receipts.issueClose", readback: receipts.issueClose },
        "remote.complete": { operation: "issue.close", readbackKey: "receipts.issueClose", readback: receipts.issueClose },
      }
    : mode === "pr"
      ? {
          claimed: { operation: "pull_request.push", readbackKey: "journal", readback: reconciliation.journal },
          "pull_request.push.intent": { operation: "pull_request.push", readbackKey: "push", readback: reconciliation.push },
          "pull_request.push.receipt": { operation: "pull_request.push", readbackKey: "receipts.branchPush", readback: receipts.branchPush },
          "pull_request.create.intent": { operation: "pull_request.create", readbackKey: "pullRequestCreate", readback: reconciliation.pullRequestCreate },
          "pull_request.create.receipt": { operation: "pull_request.create", readbackKey: "receipts.pullRequestCreate", readback: receipts.pullRequestCreate },
          "pr_opened.publish.intent": { operation: "pr_opened.publish", readbackKey: "prEvent", readback: reconciliation.prEvent },
          "pr_opened.publish.receipt": { operation: "pr_opened.publish", readbackKey: "receipts.prEvent", readback: receipts.prEvent },
        }
      : {};
  const expected = matrix[String(intent.stage || "")];
  const readback = recordValue(expected?.readback);
  if (!expected
    || proof.schema !== "cpb.finalizer-safe-continuation.v1"
    || proof.finalizationId !== intent.finalizationId
    || proof.journalDigest !== canonicalFinalizerDigest(intent)
    || proof.journalGeneration !== intent.generation
    || proof.stage !== intent.stage
    || proof.operation !== expected.operation
    || proof.readbackKey !== expected.readbackKey
    || proof.readbackDigest !== canonicalFinalizerDigest(expected.readback)
    || typeof proof.decision !== "boolean") return false;
  if (intent.stage === "claimed") {
    return proof.decision === false && readback.remoteMutationStarted === false;
  }
  if (String(expected.readbackKey).startsWith("receipts.")) {
    return proof.decision === true && canonicalFinalizerOperation(expected.readback, expected.operation);
  }
  if (intent.stage === "pull_request.create.intent" && proof.decision !== true) return false;
  return typeof readback.committed === "boolean" && readback.committed === proof.decision;
}

export function persistedFinalizerSuccessContractValid(
  assignment: ReconcilerRecord,
  result: ReconcilerRecord,
  attempt: ReconcilerRecord = {},
): boolean {
  const metadata = recordValue(assignment.metadata);
  if (metadata.autoFinalize !== true) return true;
  const finalization = recordValue(result.finalization);
  const finalizeResult = recordValue(result.finalizeResult);
  const jobResult = recordValue(result.jobResult);
  const expectedMode = expectedFinalizeMode(metadata);
  const jobId = textOrNull(jobResult.jobId);
  if (result.status !== "completed"
    || finalization.required !== true
    || finalization.ok !== true
    || finalizeResult.ok !== true
    || !jobId
    || finalizeResult.jobId !== jobId) return false;

  if (expectedMode === "dry-run") {
    if (finalizeResult.mode === "review_bundle") {
      const audit = recordValue(finalizeResult.audit);
      return finalizeResult.status === "review_bundle"
        && finalizeResult.committed === true
        && finalizeResult.eventRecorded === true
        && audit.eventType === "review_bundle_created"
        && audit.jobId === jobId
        && audit.project === assignment.projectId
        && audit.bundlePath === finalizeResult.bundlePath;
    }
    return finalizeResult.mode === "dry-run"
      && finalizeResult.status === "dry-run"
      && finalizeResult.committed === false
      && recordValue(finalizeResult.pr).status === "dry-run";
  }
  if (finalizeResult.mode !== expectedMode || finalizeResult.committed !== true) return false;
  const candidate = validatedFinalizerCandidate(jobResult);
  if (!finalizerResultMatchesCandidate(finalizeResult, candidate)) return false;
  const recovery = recordValue(metadata.finalizerRecovery);
  const ownerProof = recordValue(recovery.priorAttemptProof);
  const ownerEvidence = recordValue(ownerProof.evidence);
  const recoveryBinding = recordValue(ownerProof.journalBinding);
  const recoveredSource = recordValue(recoveryBinding.source);
  const cleanupBinding = recordValue(recordValue(recordValue(result.cleanup).worktree).binding);
  const recoveryActive = recovery.schema === FINALIZER_RECOVERY_SCHEMA && recovery.required === true;
  const durableBaseCommit = recoveryActive
    ? textOrNull(recoveredSource.head)
    : textOrNull(cleanupBinding.baseCommit);
  const originJobId = recoveryActive ? textOrNull(ownerEvidence.previousJobId) : jobId;
  if (!candidate || !durableBaseCommit || !originJobId || candidate.baseSha !== durableBaseCommit.toLowerCase()) return false;
  if (expectedMode === "local") {
    const sourceSync = recordValue(finalizeResult.sourceSync);
    return finalizeResult.status === "finalized"
      && !recoveryActive
      && sourceSync.committed === true
      && sourceSync.clean === true;
  }

  const sourceContext = recordValue(assignment.sourceContext);
  const capability = Object.keys(recordValue(metadata.remoteCapability)).length > 0
    ? recordValue(metadata.remoteCapability)
    : recordValue(sourceContext.remoteCapability);
  const intent = recordValue(finalizeResult.remoteIntent);
  if (recoveryActive && recovery.originJobId !== originJobId) return false;
  const sourceBranch = textOrNull(recoveredSource.branch)
    || textOrNull(cleanupBinding.baseBranch)
    || textOrNull(sourceContext.sourceBranch)
    || textOrNull(metadata.sourceBranch)
    || textOrNull(capability.defaultBranch);
  const sourceHead = textOrNull(recoveredSource.head)
    || textOrNull(cleanupBinding.baseCommit)
    || textOrNull(sourceContext.sourceHead)
    || textOrNull(metadata.sourceHead);
  const heartbeat = recordValue(attempt.heartbeat);
  const processIdentity = recordValue(heartbeat.processIdentity);
  const mutationFence = {
    assignmentId: assignment.assignmentId,
    entryId: assignment.entryId,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
    workerId: attempt.workerId,
    workerIncarnation: heartbeat.workerIncarnation,
    processIdentity: {
      pid: processIdentity.pid,
      startTimeTicks: processIdentity.startTimeTicks,
    },
  };
  const readOnlyRecovery = recovery.schema === FINALIZER_RECOVERY_SCHEMA
    && recovery.required === true
    && recovery.allowMutation === false;
  const binding: ReconcilerRecord = {
    project: assignment.projectId,
    entryId: assignment.entryId,
    jobId,
    originJobId,
    capability,
    principal: finalizeResult.principal,
    source: { branch: sourceBranch, head: sourceHead },
    targetBranch: textOrNull(recoveryBinding.targetBranch)
      || (expectedMode === "remote" ? sourceBranch : textOrNull(intent.targetBranch)),
    preRemoteHead: Object.hasOwn(recoveryBinding, "preRemoteHead")
      ? recoveryBinding.preRemoteHead
      : expectedMode === "remote" ? sourceHead : null,
    mutationFence,
    candidate,
    ...(readOnlyRecovery ? {
      claimPolicy: "durable-observation",
      acceptedOwnerDigest: ownerProof.acceptedOwnerDigest,
    } : {}),
  };
  const validation = validateFinalizerMutationReceipt(finalizeResult, {
    mode: expectedMode as "remote" | "pr",
    binding,
  });
  return validation.ok === true;
}

async function persistedReviewBundleFileValid(
  hubRoot: string,
  assignment: ReconcilerRecord,
  result: ReconcilerRecord,
): Promise<boolean> {
  const finalizeResult = recordValue(result.finalizeResult);
  if (finalizeResult.mode !== "review_bundle") return true;
  const jobId = textOrNull(recordValue(result.jobResult).jobId);
  const project = textOrNull(assignment.projectId);
  if (!jobId || !project) return false;
  let expectedPath: string;
  try {
    expectedPath = await verifiedCanonicalReviewBundlePath(path.resolve(hubRoot), project, jobId);
  } catch {
    return false;
  }
  if (path.resolve(String(finalizeResult.bundlePath || "")) !== expectedPath) return false;
  try {
    const content = await readBoundedRegularFileNoFollow(expectedPath, { maxBytes: ATTEMPT_RESULT_MAX_BYTES });
    const bytes = Buffer.byteLength(content, "utf8");
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    return finalizeResult.bundleBytes === bytes && finalizeResult.bundleSha256 === digest;
  } catch {
    return false;
  }
}

export async function persistedFinalizerGitReadbackValid(
  assignment: ReconcilerRecord,
  result: ReconcilerRecord,
): Promise<boolean> {
  const mode = expectedFinalizeMode(recordValue(assignment.metadata));
  if (mode !== "local" && mode !== "remote" && mode !== "pr") return true;
  const sourcePath = textOrNull(assignment.sourcePath);
  const finalizeResult = recordValue(result.finalizeResult);
  const sourceSync = recordValue(finalizeResult.sourceSync);
  const candidate = validatedFinalizerCandidate(recordValue(result.jobResult));
  if (!sourcePath || !candidate) return false;
  if (mode === "pr") {
    const intent = recordValue(finalizeResult.remoteIntent);
    const targetBranch = textOrNull(intent.targetBranch);
    return Boolean(targetBranch) && await verifyFinalizerCandidateObject({
      repositoryPath: sourcePath,
      result: finalizeResult,
      candidate,
      expectedRef: `refs/heads/${targetBranch}`,
    });
  }
  if (!textOrNull(sourceSync.actualBranch) || !textOrNull(sourceSync.actualHead)) return false;
  return String(sourceSync.actualHead).toLowerCase() === String(finalizeResult.commit || "").toLowerCase()
    && await verifyFinalizerCandidateCommit({
      repositoryPath: sourcePath,
      result: finalizeResult,
      candidate,
      expectedBranch: String(sourceSync.actualBranch),
    });
}

export async function persistedFinalizerJournalValid(
  cpbRoot: string | null,
  hubRoot: string,
  assignment: ReconcilerRecord,
  result: ReconcilerRecord,
  {
    resolveDataRoot = resolveProjectDataRoot,
    readJournal = readFinalizerJournal,
  }: {
    resolveDataRoot?: typeof resolveProjectDataRoot;
    readJournal?: typeof readFinalizerJournal;
  } = {},
): Promise<boolean> {
  const mode = expectedFinalizeMode(recordValue(assignment.metadata));
  if (mode !== "remote" && mode !== "pr") return true;
  const project = textOrNull(assignment.projectId);
  const entryId = textOrNull(assignment.entryId);
  const intent = recordValue(recordValue(result.finalizeResult).remoteIntent);
  if (!cpbRoot || !path.isAbsolute(cpbRoot) || !path.isAbsolute(hubRoot) || !project || !entryId || Object.keys(intent).length === 0) {
    return false;
  }
  try {
    const requestedDataRoot = textOrNull(assignment.dataRoot)
      || textOrNull(assignment.projectRuntimeRoot)
      || textOrNull(recordValue(assignment.metadata).dataRoot)
      || textOrNull(recordValue(assignment.metadata).projectRuntimeRoot)
      || undefined;
    const dataRoot = await resolveDataRoot(cpbRoot, project, {
      hubRoot,
      ...(requestedDataRoot ? { dataRoot: requestedDataRoot } : {}),
    });
    const snapshot = await readJournal(cpbRoot, project, entryId, { dataRoot });
    const expectedStage = mode === "remote" ? "local.complete" : "event.complete";
    return !snapshot.invalidReason
      && Boolean(snapshot.record)
      && snapshot.record?.stage === expectedStage
      && finalizerJournalDigest(snapshot.record!) === finalizerJournalDigest(intent);
  } catch {
    return false;
  }
}

function finalizerHandoffEvidence(
  assignment: ReconcilerRecord,
  attempt: ReconcilerRecord,
  result: ReconcilerRecord,
  finalizeResult: ReconcilerRecord,
  jobId: string,
): ReconcilerRecord | null {
  const intent = recordValue(finalizeResult.remoteIntent);
  const claim = recordValue(intent.claim);
  const heartbeat = recordValue(attempt.heartbeat);
  const processIdentity = recordValue(heartbeat.processIdentity);
  const previousClaimId = textOrNull(claim.claimId);
  const previousOwnerDigest = textOrNull(claim.ownerDigest);
  const previousAssignmentId = textOrNull(assignment.assignmentId);
  const previousAttempt = Number(attempt.attempt);
  const previousAttemptToken = textOrNull(attempt.attemptToken);
  const previousOrchestratorEpoch = Number(attempt.orchestratorEpoch);
  const finalizationId = textOrNull(intent.finalizationId);
  const journalGeneration = Number(intent.generation);
  const commit = textOrNull(intent.commit);
  const tree = textOrNull(intent.tree);
  const journalSource = recordValue(intent.source);
  const journalSourceBranch = textOrNull(journalSource.branch);
  const journalSourceHead = textOrNull(journalSource.head);
  const journalTargetBranch = textOrNull(intent.targetBranch);
  const journalPreRemoteHead = intent.preRemoteHead === null ? null : textOrNull(intent.preRemoteHead);
  const previousWorkerId = textOrNull(attempt.workerId);
  const previousWorkerIncarnation = textOrNull(heartbeat.workerIncarnation);
  const previousProcessStartTime = textOrNull(processIdentity.startTimeTicks);
  const previousProcessPid = Number(processIdentity.pid);
  const expectedOwnerDigest = finalizerMutationFenceDigest({
    assignmentId: previousAssignmentId,
    entryId: assignment.entryId,
    attemptToken: previousAttemptToken,
    orchestratorEpoch: previousOrchestratorEpoch,
    workerId: previousWorkerId,
    workerIncarnation: previousWorkerIncarnation,
    processIdentity: {
      pid: previousProcessPid,
      startTimeTicks: previousProcessStartTime,
    },
  });
  if (!previousClaimId || !/^[a-f0-9]{64}$/.test(previousClaimId)
    || !previousOwnerDigest || !/^[a-f0-9]{64}$/.test(previousOwnerDigest)
    || expectedOwnerDigest !== previousOwnerDigest
    || !previousAssignmentId
    || !Number.isSafeInteger(previousAttempt) || previousAttempt < 1
    || !previousAttemptToken
    || !Number.isSafeInteger(previousOrchestratorEpoch) || previousOrchestratorEpoch < 1
    || !previousWorkerId || heartbeat.workerId !== previousWorkerId
    || !previousWorkerIncarnation
    || !Number.isSafeInteger(previousProcessPid) || previousProcessPid < 1
    || !previousProcessStartTime
    || !finalizationId || !/^[a-f0-9]{64}$/.test(finalizationId)
    || intent.originJobId !== jobId
    || !Number.isSafeInteger(journalGeneration) || journalGeneration < 1
    || !commit || !/^[a-f0-9]{40,64}$/.test(commit)
    || !tree || !/^[a-f0-9]{40,64}$/.test(tree)
    || !journalSourceBranch
    || !journalSourceHead || !/^[a-f0-9]{40,64}$/.test(journalSourceHead)
    || !journalTargetBranch
    || (journalPreRemoteHead !== null && !/^[a-f0-9]{40,64}$/.test(journalPreRemoteHead))) {
    return null;
  }
  const previousAttemptTokenDigest = createHash("sha256")
    .update(previousAttemptToken, "utf8")
    .digest("hex");
  const evidence = {
    schema: FINALIZER_HANDOFF_EVIDENCE_SCHEMA,
    previousAssignmentId,
    previousAttempt,
    previousAttemptTokenDigest,
    previousOrchestratorEpoch,
    previousJobId: jobId,
    previousResultStatus: textOrNull(result.status),
    previousCommitted: finalizerCommittedTriState(finalizeResult.committed),
    finalizationId,
    journalGeneration,
    previousClaimId,
    previousOwnerDigest,
    journalStage: textOrNull(intent.stage),
    journalDigest: canonicalFinalizerDigest(intent),
    commit,
    tree,
  };
  const evidenceId = createHash("sha256")
    .update(JSON.stringify(normalizedFinalizerHandoffEvidence(evidence)), "utf8")
    .digest("hex");
  const observedAt = textOrNull(attempt.completedAt)
    || textOrNull(assignment.resultWrittenAt)
    || new Date().toISOString();
  return {
    schema: FINALIZER_HANDOFF_SCHEMA,
    kind: "explicit-handoff",
    previousClaimId,
    evidenceId,
    observedAt,
    acceptedOwnerDigest: previousOwnerDigest,
    journalBinding: {
      source: { branch: journalSourceBranch, head: journalSourceHead },
      targetBranch: journalTargetBranch,
      preRemoteHead: journalPreRemoteHead,
    },
    evidence,
  };
}

function carriedFinalizerOwnerProof(
  currentRecovery: ReconcilerRecord,
  finalizeResult: ReconcilerRecord,
): ReconcilerRecord | null {
  const proof = recordValue(currentRecovery.priorAttemptProof);
  const evidence = recordValue(proof.evidence);
  const intent = recordValue(finalizeResult.remoteIntent);
  const claim = recordValue(intent.claim);
  const binding = recordValue(proof.journalBinding);
  const evidenceId = textOrNull(proof.evidenceId);
  if (proof.schema !== FINALIZER_HANDOFF_SCHEMA
    || proof.kind !== "explicit-handoff"
    || !evidenceId || !/^[a-f0-9]{64}$/.test(evidenceId)
    || evidenceId !== createHash("sha256")
      .update(JSON.stringify(normalizedFinalizerHandoffEvidence(evidence)), "utf8")
      .digest("hex")
    || proof.previousClaimId !== claim.claimId
    || proof.acceptedOwnerDigest !== claim.ownerDigest
    || evidence.previousClaimId !== claim.claimId
    || evidence.previousOwnerDigest !== claim.ownerDigest
    || currentRecovery.originJobId !== intent.originJobId
    || evidence.previousJobId !== intent.originJobId
    || evidence.journalDigest !== canonicalFinalizerDigest(intent)
    || !sameCanonicalRecord(binding.source, intent.source)
    || binding.targetBranch !== intent.targetBranch
    || binding.preRemoteHead !== intent.preRemoteHead) return null;
  return proof;
}

function finalizerObservationProof(
  assignment: ReconcilerRecord,
  attempt: ReconcilerRecord,
  result: ReconcilerRecord,
  finalizeResult: ReconcilerRecord,
  jobId: string,
): ReconcilerRecord | null {
  const intent = recordValue(finalizeResult.remoteIntent);
  const claim = recordValue(intent.claim);
  const attemptToken = textOrNull(attempt.attemptToken);
  const attemptNumber = Number(attempt.attempt);
  const orchestratorEpoch = Number(attempt.orchestratorEpoch);
  const heartbeat = recordValue(attempt.heartbeat);
  const processIdentity = recordValue(heartbeat.processIdentity);
  const workerId = textOrNull(attempt.workerId);
  const workerIncarnation = textOrNull(heartbeat.workerIncarnation);
  const pid = Number(processIdentity.pid);
  const startTimeTicks = textOrNull(processIdentity.startTimeTicks);
  const claimId = textOrNull(claim.claimId);
  const ownerDigest = textOrNull(claim.ownerDigest);
  if (!textOrNull(assignment.assignmentId)
    || !attemptToken
    || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1
    || !Number.isSafeInteger(orchestratorEpoch) || orchestratorEpoch < 1
    || !workerId || heartbeat.workerId !== workerId
    || !workerIncarnation
    || !Number.isSafeInteger(pid) || pid < 1
    || !startTimeTicks
    || !claimId || !/^[a-f0-9]{64}$/.test(claimId)
    || !ownerDigest || !/^[a-f0-9]{64}$/.test(ownerDigest)) return null;
  const evidence = {
    schema: "cpb.finalizer-observation-evidence.v1",
    assignmentId: assignment.assignmentId,
    attempt: attemptNumber,
    attemptTokenDigest: createHash("sha256").update(attemptToken, "utf8").digest("hex"),
    orchestratorEpoch,
    workerId,
    workerIncarnation,
    processIdentity: { pid, startTimeTicks },
    jobId,
    resultStatus: textOrNull(result.status),
    committed: finalizerCommittedTriState(finalizeResult.committed),
    claimId,
    ownerDigest,
    journalDigest: canonicalFinalizerDigest(intent),
    finalizeResultDigest: canonicalFinalizerDigest(finalizeResult),
  };
  return {
    schema: "cpb.finalizer-observation-proof.v1",
    evidence,
    evidenceId: canonicalFinalizerDigest(evidence),
    observedAt: textOrNull(attempt.completedAt)
      || textOrNull(assignment.resultWrittenAt)
      || new Date().toISOString(),
  };
}

export function buildFinalizerOnlyRecoveryPlan(
  assignment: ReconcilerRecord,
  attempt: ReconcilerRecord,
  result: ReconcilerRecord,
): ReconcilerRecord | null {
  const finalization = recordValue(result.finalization);
  const finalizeResult = recordValue(result.finalizeResult);
  const failure = recordValue(recordValue(result.jobResult).failure);
  const currentRecovery = recordValue(recordValue(assignment.metadata).finalizerRecovery);
  const mode = textOrNull(finalizeResult.mode);
  const jobId = textOrNull(finalizeResult.jobId) || textOrNull(recordValue(result.jobResult).jobId);
  const intentOriginJobId = textOrNull(recordValue(finalizeResult.remoteIntent).originJobId);
  const finalizerFailed = finalization.required === true
    && finalization.ok !== true
    || failure.kind === "finalizer_failed";
  if (!finalizerFailed || finalizeResult.ok === true || (mode !== "remote" && mode !== "pr") || !jobId || !intentOriginJobId) {
    return null;
  }

  const committed = finalizerCommittedTriState(finalizeResult.committed);
  const priorGeneration = Number(currentRecovery.generation);
  const generation = Number.isSafeInteger(priorGeneration) && priorGeneration > 0
    ? priorGeneration + 1
    : 1;
  const priorWasFinalizerOnly = currentRecovery.schema === FINALIZER_RECOVERY_SCHEMA
    && currentRecovery.required === true;
  if ((!priorWasFinalizerOnly && intentOriginJobId !== jobId)
    || (priorWasFinalizerOnly && currentRecovery.originJobId !== intentOriginJobId)) return null;
  const priorReadOnlyObservations = priorWasFinalizerOnly
    && Number.isSafeInteger(Number(currentRecovery.readOnlyObservations))
    ? Math.max(0, Number(currentRecovery.readOnlyObservations))
    : 0;
  const priorMutationAttempts = priorWasFinalizerOnly
    && Number.isSafeInteger(Number(currentRecovery.mutationAttempts))
    ? Math.max(0, Number(currentRecovery.mutationAttempts))
    : 0;
  const safePartialContinuation = safePartialFinalizerContinuation(mode, finalizeResult);
  const allowMutation = safePartialContinuation;
  const readOnlyObservations = priorReadOnlyObservations + (allowMutation ? 0 : 1);
  const mutationAttempts = priorMutationAttempts + (allowMutation ? 1 : 0);
  if ((!allowMutation && readOnlyObservations > FINALIZER_READ_ONLY_RECOVERY_LIMIT)
    || (allowMutation && mutationAttempts > FINALIZER_MUTATION_RECOVERY_LIMIT)) return null;
  const priorAttemptProof = finalizerHandoffEvidence(assignment, attempt, result, finalizeResult, jobId)
    || (priorWasFinalizerOnly ? carriedFinalizerOwnerProof(currentRecovery, finalizeResult) : null);
  const lastObservationProof = finalizerObservationProof(
    assignment,
    attempt,
    result,
    finalizeResult,
    jobId,
  );
  if (!priorAttemptProof || !lastObservationProof) return null;
  const takeover = allowMutation
    ? {
        schema: FINALIZER_HANDOFF_SCHEMA,
        kind: "explicit-handoff",
        previousClaimId: priorAttemptProof.previousClaimId,
        evidenceId: priorAttemptProof.evidenceId,
        observedAt: priorAttemptProof.observedAt,
        evidence: priorAttemptProof.evidence,
      }
    : null;
  // A new worker claim is not sufficient to steal a durable finalizer journal.
  // Mutation recovery requires a stable handoff bound to the exact terminal
  // attempt and the claim recorded by that attempt.
  if (allowMutation && !takeover) return null;
  const requestedAt = new Date();
  const retryOrdinal = allowMutation ? mutationAttempts : readOnlyObservations;
  const backoffMs = priorWasFinalizerOnly
    ? Math.min(
        FINALIZER_RECOVERY_BACKOFF_MAX_MS,
        FINALIZER_RECOVERY_BACKOFF_BASE_MS * (2 ** Math.max(0, retryOrdinal - 2)),
      )
    : 0;

  return {
    schema: FINALIZER_RECOVERY_SCHEMA,
    required: true,
    generation,
    mode,
    allowMutation,
    committed,
    safePartialContinuation,
    readOnlyObservations,
    mutationAttempts,
    limits: {
      readOnlyObservations: FINALIZER_READ_ONLY_RECOVERY_LIMIT,
      mutationAttempts: FINALIZER_MUTATION_RECOVERY_LIMIT,
    },
    originAssignmentId: textOrNull(currentRecovery.originAssignmentId)
      || textOrNull(assignment.assignmentId),
    originAttempt: Number.isSafeInteger(Number(currentRecovery.originAttempt))
      ? Number(currentRecovery.originAttempt)
      : Number(attempt.attempt),
    originJobId: intentOriginJobId,
    previousAssignmentId: textOrNull(assignment.assignmentId),
    previousAttempt: Number(attempt.attempt),
    previousJobId: jobId,
    priorAttemptProof,
    lastObservationProof,
    ...(takeover ? {
      previousClaimId: takeover.previousClaimId,
      takeover,
    } : {}),
    requestedAt: requestedAt.toISOString(),
    ...(backoffMs > 0 ? {
      retryBackoffMs: backoffMs,
      nextEligibleAt: new Date(requestedAt.getTime() + backoffMs).toISOString(),
    } : {}),
    reason: allowMutation
      ? safePartialContinuation
        ? "durable journal receipts authorize continuation from the next unapplied stage under a fresh fenced claim"
        : "finalizer mutation was not committed; resume under a fresh fenced claim"
      : "finalizer mutation truth is ambiguous or partially committed; reconcile read-only first",
  };
}

function previousFailureCount(assignment: ReconcilerRecord, base: ReconcilerRecord) {
  const candidates = [
    assignment?.metadata?.failureCount,
    assignment?.failureCount,
    base?.retry?.failureCount,
    base?.previousFailure?.retryCount,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export function buildRetrySourceContext(assignment: ReconcilerRecord, attempt: ReconcilerRecord, result: ReconcilerRecord, decision: LooseRecord): ReconcilerRecord {
  const failure = result?.jobResult?.failure || result?.failure || {};
  const base = assignment.sourceContext && typeof assignment.sourceContext === "object"
    ? { ...assignment.sourceContext }
    : {};
  const previousOutput = extractPreviousOutput(failure);
  const retryCount = previousFailureCount(assignment, base) + 1;
  const verification = verificationRetryContext(failure);
  const failureCause = recordValue(failure.cause);
  const solverFailure = recordValue(failureCause.solver);
  const previousRetry = recordValue(base.retry);
  const recovery = selectFailureRecovery({
    failure,
    previousFingerprint: textOrNull(previousRetry.failureFingerprint),
    previousStrategy: textOrNull(previousRetry.retryStrategy),
    preferredStrategy: textOrNull(decision.retryStrategy),
    scope: "queue",
  });
  let failureFingerprint = textOrNull(
    decision?.failureFingerprint
    || solverFailure.failureFingerprint
    || failureCause.failureFingerprint,
  ) || recovery.failureFingerprint;
  let retryStrategy = textOrNull(decision?.retryStrategy) || recovery.retryStrategy;
  if (
    failureFingerprint === textOrNull(previousRetry.failureFingerprint)
    && retryStrategy === textOrNull(previousRetry.retryStrategy)
  ) {
    failureFingerprint = recovery.failureFingerprint;
    retryStrategy = recovery.retryStrategy;
  }
  const strategyChanged = Boolean(failureFingerprint && retryStrategy) && (
    failureFingerprint !== textOrNull(previousRetry.failureFingerprint)
    || retryStrategy !== textOrNull(previousRetry.retryStrategy)
  );
  const decisionEvidence = recordValue(decision.failureEvidence);
  const retry = {
    failureKind: failure.kind || "unknown",
    failureReason: failure.reason || decision?.reason || "retry requested",
    previousOutput,
    previousJobId: textOrNull(result?.jobResult?.jobId || result?.jobId || base.previousJobId),
    previousAttempt: attempt?.attempt ?? assignment?.attempts ?? null,
    previousPhase: failure.phase || result?.jobResult?.failure?.phase || null,
    retryAction: textOrNull(decision?.action),
    retryReason: textOrNull(decision?.reason),
    retryable: boolOrNull(decision?.retryable ?? failure.retryable),
    retryCount,
    failureCount: retryCount,
    retryQueuedAt: new Date().toISOString(),
    verification,
    // Checklist retry state — logical targets and file-only scope
    targetChecklistIds: verification?.checklistVerdict?.targetChecklistIds || failure.cause?.targetChecklistIds || [],
    lockedPassedChecklistIds: verification?.checklistVerdict?.lockedPassedChecklistIds || [],
    previousEvidenceRefs: verification?.checklistVerdict?.previousEvidenceRefs || [],
    fixScope: verification?.checklistVerdict?.fixScope || failure.cause?.fixScope || [],
    retryPhase: textOrNull(
      decision?.retryPhase !== undefined ? decision.retryPhase : failureCause.retryPhase,
    ),
    failureClass: textOrNull(decision.failureClass) || recovery.failureClass,
    failureEvidence: Object.keys(decisionEvidence).length > 0 ? decisionEvidence : recovery.failureEvidence,
    retryStrategy,
    failureFingerprint,
    strategyChanged,
    forceFreshSession: decision.forceFreshSession === true || recovery.forceFreshSession,
    retryAllowed: decision.action === "wait_for_rate_limit" || strategyChanged,
    retryStopReason: recovery.stopReason,
  };
  return {
    ...base,
    retry,
    previousFailure: {
      kind: retry.failureKind,
      failureClass: retry.failureClass,
      failureFingerprint: retry.failureFingerprint,
      failureEvidence: retry.failureEvidence,
      retryStrategy: retry.retryStrategy,
      reason: retry.failureReason,
      jobId: retry.previousJobId,
      phase: retry.previousPhase,
      attempt: retry.previousAttempt,
      retryCount,
      verification: retry.verification,
    },
  };
}

export class Reconciler {
  hubRoot: string;
  cpbRoot: string | null;
  assignments: ReconcilerStore;
  workers: WorkerStore;
  workerSupervisor: WorkerSupervisor | null;
  leaderLock: { stillHeld: () => Promise<boolean> };
  failureRouter: FailureRouter;
  progressInfoMs: number;
  progressWarnMs: number;
  progressErrorMs: number;
  progressForceRetryMs: number;
  progressAlertLevels: Map<string, number>;
  progressProbeCheckedAt: Map<string, number>;
  log: Record<string, (...args: unknown[]) => void> & { child: (meta: LooseRecord) => Record<string, (...args: unknown[]) => void> };

  constructor(hubRoot: string, {
    assignmentStore,
    workerStore,
    workerSupervisor,
    leaderLock,
    failureRouter,
    hubRoot: _hr,
    cpbRoot = null,
    progressInfoMs,
    progressWarnMs,
    progressErrorMs,
    progressForceRetryMs,
    progressStaleMs,
  }: ReconcilerOptions) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.workerSupervisor = workerSupervisor || null;
    this.leaderLock = leaderLock;
    this.failureRouter = failureRouter as FailureRouter;
    this.progressInfoMs = resolveProgressThresholdMs(
      progressInfoMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_INFO_MS,
      DEFAULT_PROGRESS_INFO_MS,
    );
    this.progressWarnMs = resolveProgressThresholdMs(
      progressWarnMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_WARNING_MS ?? process.env.CPB_ASSIGNMENT_PROGRESS_WARN_MS,
      DEFAULT_PROGRESS_WARN_MS,
    );
    this.progressErrorMs = resolveProgressThresholdMs(
      progressErrorMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_ERROR_MS,
      DEFAULT_PROGRESS_ERROR_MS,
    );
    this.progressForceRetryMs = resolveProgressThresholdMs(
      progressForceRetryMs ?? progressStaleMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_FORCE_RETRY_MS ?? process.env.CPB_ASSIGNMENT_PROGRESS_STALE_MS,
      DEFAULT_PROGRESS_FORCE_RETRY_MS,
    );
    this.progressAlertLevels = new Map();
    this.progressProbeCheckedAt = new Map();
    this.log = createLogger("reconciler");
  }

  /**
   * Fencing: refuse to mutate orchestrator state if leader lock is lost.
   */
  async _guardLeader() {
    if (!(await this.leaderLock.stillHeld())) {
      throw new Error("leader lock lost; refusing to mutate orchestrator state");
    }
  }

  async recoverRuntime() {
    await this.reconcileWorkers();
    await this.reconcileAssignments();
    await this.reconcileQueue();
  }

  async reconcileWorkers() {
    await this._guardLeader();
    const workers = await this.workers.listWorkers();
    const now = await this.workers.authorityTimeMs?.() ?? Date.now();

    for (const worker of workers) {
      if (worker.status === "exited") continue;

      if (worker.pid && this._isLocalWorker(worker)) {
        const liveness = this._workerProcessAlive(worker);
        if (liveness === false) {
          this.log.info(`worker ${worker.workerId} process identity ${this._workerProcessIdentity(worker)?.incarnation || "unknown"} marked exited (dead process)`);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
          continue;
        }
        if (liveness === null) {
          this.log.warn(`worker ${worker.workerId} missing process identity; marked unhealthy instead of probing bare pid`);
          await this.workers.updateWorker(worker.workerId, {
            status: "unhealthy",
            recoveryError: "missing_process_identity",
          });
          continue;
        }
      }

      const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
      if (now - lastHb > HEARTBEAT_STALE_MS * 2) {
        this.log.warn(`worker ${worker.workerId} marked unhealthy (stale heartbeat)`);
        await this.workers.updateWorker(worker.workerId, { status: "unhealthy" });
      }
    }
  }

  async reconcileAssignments() {
    await this._guardLeader();
    const assignments = await this.assignments.listAssignments();
    const now = await this.workers.authorityTimeMs?.() ?? Date.now();

    for (const assignment of assignments) {
      const aLog = this.log.child({ traceId: assignment.assignmentId });
      switch (assignment.status) {
        case "scheduled": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;
          const accepted = await this._readAccepted(assignment.assignmentId, attempt.attempt);
          if (accepted) {
            aLog.info(`assignment ${assignment.assignmentId} accepted by worker, markRunning`);
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            // Update queue to in_progress so scheduler doesn't reset it
            const { updateEntry } = await import("../services/hub/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
              claimedAt: new Date(now).toISOString(),
            });
          }
          break;
        }

        case "assigned": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;

          // Check accepted.json first
          const accepted = await this._readAccepted(assignment.assignmentId, attempt.attempt);
          if (accepted) {
            aLog.info(`assignment ${assignment.assignmentId} accepted by worker, markRunning`);
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            const { updateEntry } = await import("../services/hub/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
              claimedAt: new Date().toISOString(),
            });
            break;
          }

          // Check if worker claimed queue entry directly (claimEligible) without
          // writing accepted.json — the dual-path race.  If the queue entry is
          // in_progress with a fresh claim, treat it as accepted.
          {
            const { listQueue } = await import("../services/hub/hub-queue.js");
            const claimed = await listQueue(this.hubRoot, { status: "in_progress", projectId: assignment.projectId });
            const match = claimed.find((e) => e.id === assignment.entryId);
            if (match?.claimedAt) {
              const claimedAtMs = new Date(match.claimedAt).getTime();
              if (now - claimedAtMs < ASSIGN_ACCEPT_TTL_MS) {
                await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
                break;
              }
            }
          }

          const assignedAt = attempt.createdAt ? new Date(attempt.createdAt).getTime() : 0;
          if (now - assignedAt > ASSIGN_ACCEPT_TTL_MS) {
            aLog.warn(`assignment ${assignment.assignmentId} not accepted within TTL, writing synthetic failure`);
            // P0-4 fix: use writeSyntheticFailure for reconciler-created failures
            const result = {
              assignmentId: assignment.assignmentId,
              attempt: attempt.attempt,
              orchestratorEpoch: attempt.orchestratorEpoch,
              status: "failed",
              jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: "assignment not accepted within TTL" } },
              attemptToken: attempt.attemptToken,
            };
            await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
            await this._finalizeAssignment(assignment, attempt, result);
          }
          break;
        }

        case "running": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;

          // Check result.json → validate + finalize (P0-4: worker wrote, store validates)
          const result = await this._readAttemptResult(assignment.assignmentId, attempt.attempt);
          if (result) {
            aLog.info(`assignment ${assignment.assignmentId} completed`);
            await this.assignments.completeAttemptFromExistingResult(assignment.assignmentId, attempt.attempt, result);
            await this._finalizeAssignment(assignment, attempt, result);
            break;
          }

          // Check heartbeat
          const hb = await this._readHeartbeat(assignment.assignmentId, attempt.attempt);
          if (hb) {
            const lastHb = new Date(hb.updatedAt).getTime();
            if (now - lastHb > HEARTBEAT_STALE_MS * 2) {
              aLog.warn(`assignment ${assignment.assignmentId} heartbeat stale for ${Math.round((now - lastHb) / 1000)}s`);
              const result = {
                assignmentId: assignment.assignmentId,
                attempt: attempt.attempt,
                orchestratorEpoch: attempt.orchestratorEpoch,
                status: "failed",
                jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: `heartbeat stale for ${Math.round((now - lastHb) / 1000)}s` } },
                attemptToken: attempt.attemptToken,
              };
              await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
              await this._finalizeAssignment(assignment, attempt, result);
              break;
            }

            const progressDelay = this._classifyProgressDelay(assignment, attempt, hb, now);
            if (progressDelay) {
              const probe = await this._maybeProbeProgressDelay(assignment, attempt, hb, progressDelay);
              if (probe) progressDelay.cause.probe = probe;
              this._logProgressDelay(aLog, assignment, attempt, progressDelay);
              const shouldFail = progressDelay.shouldFail || probe?.waitUseful === false;
              if (!shouldFail) break;
              if (probe?.waitUseful === false && !progressDelay.shouldFail) {
                aLog.error(`assignment ${assignment.assignmentId} progress probe closed early: ${probe.reason}`);
              }
              const reason = probe?.waitUseful === false
                ? `${progressDelay.reason}; probe confirmed waiting cannot recover: ${probe.reason}`
                : progressDelay.reason;
              const result = {
                assignmentId: assignment.assignmentId,
                attempt: attempt.attempt,
                orchestratorEpoch: attempt.orchestratorEpoch,
                status: "failed",
                jobResult: {
                  status: "failed",
                  failure: {
                    kind: FailureKind.ASSIGNMENT_PROGRESS_STALE,
                    phase: progressDelay.phase,
                    reason,
                    retryable: true,
                    cause: progressDelay.cause,
                  },
                },
                attemptToken: attempt.attemptToken,
              };
              await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
              await this._finalizeAssignment(assignment, attempt, result);
              break;
            }
          }
          break;
        }

        case "completed":
        case "failed":
        case "blocked":
          // P0-3 fix: terminal != finalized — compensate incomplete finalization
          await this._compensateFinalization(assignment);
          break;
      }
    }
  }

  _classifyProgressDelay(
    assignment: ReconcilerRecord,
    attempt: ReconcilerRecord,
    heartbeat: ReconcilerRecord,
    now = Date.now(),
  ): ReconcilerRecord | null {
    if (!this.progressForceRetryMs) return null;
    if (!heartbeat || heartbeat.status !== "running") return null;

    const progressAt = heartbeat.progressUpdatedAt || heartbeat.lastProgressAt || heartbeat.phaseUpdatedAt;
    if (!progressAt) return null;

    const progressMs = new Date(progressAt).getTime();
    if (!Number.isFinite(progressMs)) return null;

    const ageMs = now - progressMs;
    if (ageMs < 0) return null;

    let level = null;
    let thresholdMs = 0;
    if (ageMs >= this.progressForceRetryMs) {
      level = "force";
      thresholdMs = this.progressForceRetryMs;
    } else if (this.progressErrorMs && ageMs >= this.progressErrorMs) {
      level = "error";
      thresholdMs = this.progressErrorMs;
    } else if (this.progressWarnMs && ageMs >= this.progressWarnMs) {
      level = "warn";
      thresholdMs = this.progressWarnMs;
    } else if (this.progressInfoMs && ageMs >= this.progressInfoMs) {
      level = "info";
      thresholdMs = this.progressInfoMs;
    }
    if (!level) return null;

    const phase = heartbeat.activePhase || heartbeat.phase || null;
    const phaseLabel = phase ? `phase ${phase}` : "active phase";
    const ageSec = Math.round(ageMs / 1000);
    const thresholdSec = Math.round(thresholdMs / 1000);
    const forceSec = Math.round(this.progressForceRetryMs / 1000);
    const detail = level === "force"
      ? `force retry threshold ${forceSec}s`
      : `${level} threshold ${thresholdSec}s; force retry at ${forceSec}s`;
    const cause: ReconcilerRecord = {
      assignmentId: assignment.assignmentId,
      entryId: assignment.entryId,
      attempt: attempt?.attempt ?? null,
      activeJobId: heartbeat.activeJobId || null,
      activePhase: heartbeat.activePhase || null,
      lastProgressAt: progressAt,
      lastProgressType: heartbeat.lastProgressType || heartbeat.progressKind || null,
      heartbeatAt: typeof heartbeat.updatedAt === "string" ? heartbeat.updatedAt : null,
      worktreePath: heartbeat.worktreePath || null,
      workerPid: heartbeat.pid || null,
      ageMs,
      infoThresholdMs: this.progressInfoMs,
      warnThresholdMs: this.progressWarnMs,
      errorThresholdMs: this.progressErrorMs,
      forceRetryThresholdMs: this.progressForceRetryMs,
    };
    return {
      level,
      shouldFail: level === "force",
      phase,
      reason: `${phaseLabel} made no progress for ${ageSec}s (${detail})`,
      cause,
    };
  }

  _logProgressDelay(aLog: Record<string, (...args: unknown[]) => void>, assignment: ReconcilerRecord, attempt: ReconcilerRecord, progressDelay: ReconcilerRecord): void {
    const key = `${assignment.assignmentId}:${attempt?.attempt ?? "unknown"}`;
    const rank = PROGRESS_ALERT_RANK[progressDelay.level] || 0;
    const previousRank = this.progressAlertLevels.get(key) || 0;
    if (rank <= previousRank) return;

    this.progressAlertLevels.set(key, rank);
    const logLevel = progressDelay.level === "force" ? "error" : progressDelay.level;
    aLog[logLevel](`assignment ${assignment.assignmentId} progress ${progressDelay.level}: ${progressDelay.reason}`);
  }

  async _maybeProbeProgressDelay(assignment: ReconcilerRecord, attempt: ReconcilerRecord, heartbeat: ReconcilerRecord, progressDelay: ReconcilerRecord): Promise<ReconcilerRecord | null> {
    const key = `${assignment.assignmentId}:${attempt?.attempt ?? "unknown"}:${progressDelay.level}`;
    const intervalMs = PROGRESS_PROBE_INTERVAL_MS[progressDelay.level] ?? 60_000;
    const now = Date.now();
    const lastCheckedAt = this.progressProbeCheckedAt.get(key) || 0;
    if (intervalMs && now - lastCheckedAt < intervalMs) return null;

    this.progressProbeCheckedAt.set(key, now);
    const probe = await this._probeProgressDelay(assignment, attempt, heartbeat, progressDelay);
    await this._writeProgressProbe(assignment.assignmentId, attempt.attempt, progressDelay.level, probe);
    return probe;
  }

  async _probeProgressDelay(assignment: ReconcilerRecord, attempt: ReconcilerRecord, heartbeat: ReconcilerRecord, progressDelay: ReconcilerRecord): Promise<ReconcilerRecord> {
    const depth = PROGRESS_PROBE_DEPTH[progressDelay.level] || "heartbeat";
    const workerId = attempt?.workerId || assignment.workerId || heartbeat.workerId || null;
    const probe: ReconcilerRecord = {
      checkedAt: new Date().toISOString(),
      level: progressDelay.level,
      depth,
      waitUseful: true,
      reason: null,
      failureSignals: [],
      heartbeat: {
        status: heartbeat.status || null,
        updatedAt: heartbeat.updatedAt || null,
        progressUpdatedAt: heartbeat.progressUpdatedAt || heartbeat.lastProgressAt || heartbeat.phaseUpdatedAt || null,
        progressKind: heartbeat.progressKind || null,
        lastProgressType: heartbeat.lastProgressType || null,
        activePhase: heartbeat.activePhase || heartbeat.phase || null,
        activeJobId: heartbeat.activeJobId || null,
        worktreePath: heartbeat.worktreePath || null,
      },
      worker: null,
      attemptFiles: null,
      workerLog: null,
      worktree: null,
    };

    if (depth === "heartbeat") return probe;

    const worker = workerId ? await this.workers.getWorker(workerId) : null;
    const pid = heartbeat.pid || worker?.pid || null;
    const workerHost = worker?.host || heartbeat.host || null;
    const localWorker = workerHost === "local" || workerHost === os.hostname();
    const processIdentity = this._workerProcessIdentity(worker) || this._workerProcessIdentity(heartbeat);
    const pidAlive = localWorker ? this._processIdentityAlive(processIdentity) : null;
    probe.worker = {
      workerId,
      found: Boolean(worker),
      status: worker?.status || null,
      host: workerHost,
      pid,
      pidAlive,
      processIdentity: processIdentity || null,
      currentAssignmentId: worker?.currentAssignmentId || null,
      lastHeartbeatAt: worker?.lastHeartbeatAt || null,
    };

    if (!worker) {
      this._addProbeFailure(probe, "worker_registry_missing");
    } else {
      if (NON_REUSABLE_WORKER_STATUSES.has(worker.status)) {
        this._addProbeFailure(probe, `worker_status_${worker.status}`);
      }
      if (worker.currentAssignmentId && worker.currentAssignmentId !== assignment.assignmentId) {
        this._addProbeFailure(probe, "worker_assignment_mismatch");
      }
    }
    if (pid && localWorker && !processIdentity) {
      this._addProbeFailure(probe, "worker_process_identity_missing");
    } else if (pid && pidAlive === false) {
      this._addProbeFailure(probe, "worker_pid_dead");
    }

    if (!DEEP_PROGRESS_PROBE_LEVELS.has(progressDelay.level)) {
      this._finishProbe(probe);
      return probe;
    }

    const attemptDir = this._attemptDir(assignment.assignmentId, attempt.attempt);
    const resultPath = path.join(attemptDir, "result.json");
    const resultExists = await this._pathExists(resultPath);
    probe.attemptFiles = {
      acceptedExists: await this._pathExists(path.join(attemptDir, "accepted.json")),
      heartbeatExists: await this._pathExists(path.join(attemptDir, "heartbeat.json")),
      resultExists,
      resultReadable: resultExists ? Boolean(await this._readAttemptResult(assignment.assignmentId, attempt.attempt)) : null,
    };
    if (probe.attemptFiles.resultExists && probe.attemptFiles.resultReadable === false) {
      this._addProbeFailure(probe, "result_file_unreadable");
    }

    probe.workerLog = await this._probeWorkerLog(workerId, resultExists);
    if (probe.workerLog?.indicatesFailedJob) {
      this._addProbeFailure(probe, "worker_log_failed_without_result");
    }

    probe.worktree = await this._probeWorktree(heartbeat.worktreePath);
    if (probe.worktree?.path && probe.worktree.exists === false) {
      this._addProbeFailure(probe, "worktree_missing");
    }

    this._finishProbe(probe);
    return probe;
  }

  _addProbeFailure(probe: ReconcilerRecord, signal: string): void {
    if (!probe.failureSignals.includes(signal)) probe.failureSignals.push(signal);
  }

  _finishProbe(probe: ReconcilerRecord): void {
    if (probe.failureSignals.length === 0) return;
    probe.waitUseful = false;
    probe.reason = probe.failureSignals.join(", ");
  }

  _isLocalWorker(worker: ReconcilerRecord | null | undefined): boolean {
    return !worker?.host || worker.host === "local" || worker.host === os.hostname();
  }

  _workerProcessIdentity(worker: ReconcilerRecord | null | undefined): ProcessIdentity | null {
    const identity = worker?.processIdentity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
    const record = identity as ReconcilerRecord;
    const pid = Number(record.pid);
    const birthId = typeof record.birthId === "string" ? record.birthId : "";
    const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : "";
    const processGroupId = Number(record.processGroupId);
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || !birthId
      || record.incarnation !== `${pid}:${birthId}`
      || !capturedAt
      || !Number.isFinite(Date.parse(capturedAt))
      || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
      || record.birthIdPrecision !== "exact"
      || (record.processGroupId !== undefined
        && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
    ) return null;
    return {
      pid,
      birthId,
      incarnation: record.incarnation,
      capturedAt,
      birthIdPrecision: "exact",
      ...(record.processGroupId === undefined ? {} : { processGroupId }),
    };
  }

  _workerProcessAlive(worker: ReconcilerRecord | null | undefined): boolean | null {
    return this._processIdentityAlive(this._workerProcessIdentity(worker));
  }

  _processIdentityAlive(identity: ProcessIdentity | null): boolean | null {
    if (!identity) return null;
    try {
      return isProcessIdentityAlive(identity);
    } catch {
      return null;
    }
  }

  async _probeWorkerLog(workerId: string | null, resultExists: boolean): Promise<ReconcilerRecord | null> {
    if (!workerId) return null;
    const logPath = path.join(this.hubRoot, "logs", `worker-${workerId}.log`);
    try {
      const logTail = truncateText(await readFile(logPath, "utf8"), PROGRESS_PROBE_LOG_TAIL);
      const indicatesFailedJob = !resultExists && WAITLESS_LOG_PATTERNS.some((pattern) => pattern.test(logTail));
      return { path: logPath, exists: true, tail: logTail, indicatesFailedJob };
    } catch {
      return { path: logPath, exists: false, tail: "", indicatesFailedJob: false };
    }
  }

  async _probeWorktree(worktreePath: string | null): Promise<ReconcilerRecord | null> {
    if (!worktreePath) return null;
    const info: ReconcilerRecord = { path: worktreePath, exists: false, gitStatus: null };
    try {
      const pathStat = await stat(worktreePath);
      info.exists = pathStat.isDirectory();
    } catch {
      return info;
    }
    if (!info.exists) return info;
    try {
      const { stdout } = await execFile("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        timeout: 3000,
        maxBuffer: 64 * 1024,
      });
      info.gitStatus = truncateText(stdout, 2000);
    } catch (err) {
      info.gitStatusError = err.message;
    }
    return info;
  }

  async _writeProgressProbe(assignmentId: string, attemptNum: number, level: string, probe: ReconcilerRecord): Promise<void> {
    try {
      await writeJsonAtomic(path.join(this._attemptDir(assignmentId, attemptNum), `progress-probe-${level}.json`), probe);
    } catch {
      // Probe persistence is diagnostic only; reconciliation must continue.
    }
  }

  /**
   * P0-3 fix: compensate incomplete finalization steps.
   * terminal assignment may still need queue/worker finalization.
   */
  async _compensateFinalization(assignment: ReconcilerRecord): Promise<void> {
    const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);

    if (!assignment.queueFinalizedAt) {
      if (!attempt) {
        // No attempt info — cannot finalize queue, skip
        return;
      }
      const result = await this._readAttemptResult(assignment.assignmentId, attempt.attempt, {
        allowCommittedFile: Boolean(assignment.resultWrittenAt),
      });
      if (!result) {
        // No result — cannot finalize queue, skip (worker may still be writing)
        return;
      }
      await this._finalizeQueue(assignment, attempt, result);
    }
    if (!assignment.workerFinalizedAt) {
      await this._finalizeWorker(assignment, attempt);
    }
  }

  async _finalizeAssignment(assignment: ReconcilerRecord, attempt: ReconcilerRecord, result: ReconcilerRecord): Promise<void> {
    await this._finalizeQueue(assignment, attempt, result);
    await this._finalizeWorker(assignment, attempt);
  }

  async _finalizeQueue(assignment: ReconcilerRecord, attempt: ReconcilerRecord, result: ReconcilerRecord): Promise<void> {
    await this._guardLeader();
    const { updateEntry } = await import("../services/hub/hub-queue.js");
    const persistedHeartbeat = Object.keys(recordValue(attempt.heartbeat)).length > 0
      ? recordValue(attempt.heartbeat)
      : await this._readHeartbeat(assignment.assignmentId, Number(attempt.attempt)) || {};
    const durableAttempt = { ...attempt, heartbeat: persistedHeartbeat };
    const finalization = recordValue(result?.finalization);
    const finalizeResult = recordValue(result?.finalizeResult);
    const finalizerContractValid = persistedFinalizerSuccessContractValid(assignment, result, durableAttempt)
      && await persistedReviewBundleFileValid(this.hubRoot, assignment, result)
      && await persistedFinalizerGitReadbackValid(assignment, result)
      && await persistedFinalizerJournalValid(this.cpbRoot, this.hubRoot, assignment, result);
    const finalizerRejected = result?.status === "completed" && (
      (finalization.required === true && finalization.ok !== true)
      || finalizeResult.ok === false
      || !finalizerContractValid
    );
    const effectiveResult = finalizerRejected
      ? {
          ...result,
          status: finalizeResult.status === "blocked" || finalization.status === "blocked" ? "blocked" : "failed",
          jobResult: {
            ...recordValue(result.jobResult),
            status: finalizeResult.status === "blocked" || finalization.status === "blocked" ? "blocked" : "failed",
            failure: {
              kind: "finalizer_failed",
              phase: "finalize",
              reason: String(
                finalizeResult.reason
                || finalizeResult.code
                || finalization.code
                || (!finalizerContractValid ? "persisted finalizer success contract is invalid" : "finalizer failed"),
              ),
              retryable: finalizeResult.retryable === true,
              cause: { finalizer: finalizeResult, finalization },
            },
          },
        }
      : result;
    const finalizerRecovery = buildFinalizerOnlyRecoveryPlan(assignment, durableAttempt, effectiveResult);

    if (finalizerRecovery) {
      this.log.info(`entry ${assignment.entryId} scheduling finalizer-only recovery (mutation=${finalizerRecovery.allowMutation === true ? "allowed-with-fresh-claim" : "read-only"})`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        workerId: null,
        reason: null,
        metadata: {
          finalizerRecovery,
          sourceContext: assignment.sourceContext || null,
          retryDecision: finalizerRecovery.nextEligibleAt
            ? {
                action: "wait_for_finalizer_reconciliation",
                reason: finalizerRecovery.reason,
                retryable: true,
                retryAt: String(finalizerRecovery.requestedAt),
                untilTs: finalizerRecovery.nextEligibleAt,
              }
            : null,
        },
      });
    } else if (effectiveResult && effectiveResult.status === "completed") {
      this.log.info(`entry ${assignment.entryId} completed`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      this.failureRouter.resetBudget(assignment.entryId);
    } else if (effectiveResult && effectiveResult.status === "blocked") {
      const reason = effectiveResult.jobResult?.failure?.reason
        || effectiveResult.failure?.reason
        || "assignment finalization blocked";
      this.log.warn(`entry ${assignment.entryId} blocked: ${reason}`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "blocked",
        reason,
        metadata: {
          finalizerFailure: Object.keys(finalizeResult).length > 0 ? finalizeResult : null,
          blockedAt: new Date().toISOString(),
        },
      });
    } else if (effectiveResult && effectiveResult.status === "cancelled") {
      const reason = effectiveResult.jobResult?.failure?.reason || effectiveResult.failure?.reason || "assignment cancelled";
      this.log.info(`entry ${assignment.entryId} cancelled`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        metadata: {
          cancelReason: reason,
          cancelledAt: new Date().toISOString(),
        },
      });
      this.failureRouter.resetBudget(assignment.entryId);
    } else if (effectiveResult) {
      const decision = await this.failureRouter.route({ assignment, attempt, result: effectiveResult });

      switch (decision.action) {
        case "restart_worker_and_retry":
        case "retry_same_worker":
        case "wait_for_rate_limit": {
          this.log.info(`entry ${assignment.entryId} retrying (${decision.action}: ${decision.reason})`);
          // Don't retry if the worker is dead (exited/unhealthy)
          const workerId = attempt?.workerId || assignment.workerId;
          if (workerId) {
            const workers = await this.workers.listWorkers();
            const worker = workers.find((w: ReconcilerRecord) => w.workerId === workerId);
            if (
              decision.action !== "restart_worker_and_retry" &&
              worker &&
              worker.status !== "online" &&
              worker.status !== "ready" &&
              worker.status !== "running" &&
              worker.status !== "assigned"
            ) {
              await updateEntry(this.hubRoot, assignment.entryId, {
                status: "failed",
                metadata: {
                  failureReason: `worker ${workerId} is ${worker.status}: ${decision.reason}`,
                  failedAt: new Date().toISOString(),
                },
              });
              break;
            }
          }
          if (decision.action === "restart_worker_and_retry") {
            await this._stopWorkerForRestart(assignment, attempt, decision.reason);
          }
          const retrySourceContext = buildRetrySourceContext(assignment, attempt, effectiveResult, decision);
          const retryContract = recordValue(retrySourceContext.retry);
          if (decision.action !== "wait_for_rate_limit" && retryContract.retryAllowed !== true) {
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "failed",
              metadata: {
                failureReason: textOrNull(retryContract.retryStopReason) || "retry rejected because fingerprint and strategy did not change",
                failureClass: retryContract.failureClass || null,
                failureFingerprint: retryContract.failureFingerprint || null,
                retryStrategy: retryContract.retryStrategy || null,
                failedAt: new Date().toISOString(),
              },
            });
            break;
          }
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              sourceContext: retrySourceContext,
              lastFailureKind: retrySourceContext.retry?.failureKind || "unknown",
              failureCount: retrySourceContext.retry?.failureCount || 1,
              retryDecision: {
                action: decision.action,
                reason: decision.reason,
                retryable: boolOrNull(decision.retryable),
                retryAt: new Date().toISOString(),
                untilTs: decision.untilTs ?? null,
                failureClass: retryContract.failureClass || null,
                failureFingerprint: retryContract.failureFingerprint || null,
                retryStrategy: retryContract.retryStrategy || null,
                strategyChanged: retryContract.strategyChanged === true,
                forceFreshSession: retryContract.forceFreshSession === true,
              },
            },
          });
          break;
        }

        case "mark_blocked":
          this.log.warn(`entry ${assignment.entryId} blocked: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "blocked",
            reason: decision.reason,
          });
          break;

        case "reroute":
          this.log.info(`entry ${assignment.entryId} reroute: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              ...recordValue(assignment.sourceContext),
              workflow: decision.params?.workflow || assignment.workflow,
              planMode: decision.params?.planMode || assignment.planMode,
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                reroutedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "switch_agent":
          this.log.info(`entry ${assignment.entryId} switch_agent: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              ...recordValue(assignment.sourceContext),
              agentsOverride: decision.params || {},
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                switchedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "request_human_approval":
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "blocked",
            reason: decision.reason || "human approval requested by supervisor",
            metadata: {
              ...recordValue(assignment.sourceContext),
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                blockedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "mark_failed":
        default:
          this.log.warn(`entry ${assignment.entryId} marked failed: ${decision.reason || "reconciler mark_failed"}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "failed",
            metadata: {
              failureReason: decision.reason || "reconciler mark_failed",
              failedAt: new Date().toISOString(),
            },
          });
          break;
      }
    }

    await this.assignments.markFinalized(assignment.assignmentId, "queue");
  }

  async _stopWorkerForRestart(assignment: ReconcilerRecord, attempt: ReconcilerRecord, reason: string): Promise<void> {
    const workerId = attempt?.workerId || assignment.workerId;
    if (!workerId || !this.workerSupervisor?.stopWorker) return;
    try {
      await this.workerSupervisor.stopWorker(workerId, reason || "restart_worker_and_retry");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`worker ${workerId} restart stop failed: ${message}`);
      throw err;
    }
  }

  async _finalizeWorker(assignment: ReconcilerRecord, attempt: ReconcilerRecord): Promise<void> {
    await this._guardLeader();
    const workerId = attempt?.workerId || assignment.workerId;
    if (workerId) {
      const worker = await this.workers.getWorker(workerId);
      const updates: ReconcilerRecord = { currentAssignmentId: null };
      if (!NON_REUSABLE_WORKER_STATUSES.has(worker?.status)) {
        updates.status = "ready";
      }
      if (this.workers.updateWorkerIf) {
        const expectedWorker: Record<string, unknown> = {
          currentAssignmentId: assignment.assignmentId,
          status: NON_REUSABLE_WORKER_STATUSES.has(worker?.status)
            ? String(worker?.status || "")
            : ["assigned", "running"],
        };
        if (typeof worker?.incarnationToken === "string") expectedWorker.incarnationToken = worker.incarnationToken;
        if (Object.prototype.hasOwnProperty.call(worker || {}, "currentAttemptToken")) {
          expectedWorker.currentAttemptToken = attempt.attemptToken ?? null;
        }
        await this.workers.updateWorkerIf(workerId, updates, expectedWorker);
      } else if (!worker?.currentAssignmentId || worker.currentAssignmentId === assignment.assignmentId) {
        await this.workers.updateWorker(workerId, updates);
      }
    }
    await this.assignments.markFinalized(assignment.assignmentId, "worker");
  }

  async reconcileQueue() {
    await this._guardLeader();
    const { listQueue, updateEntry } = await import("../services/hub/hub-queue.js");
    const assignments = await this.assignments.listAssignments();

    const byEntry = new Map<string, ReconcilerRecord>();
    for (const a of assignments) {
      byEntry.set(a.entryId, a);
    }

    const scheduled = await listQueue(this.hubRoot, { status: "scheduled" });
    for (const entry of scheduled) {
      const assignment = byEntry.get(entry.id);
      if (!assignment || assignment.status === "completed" || assignment.status === "failed") {
        const finalStatus = assignment?.status === "completed" ? "completed" : "failed";
        this.log.warn(`orphaned scheduled entry ${entry.id} → ${finalStatus}`);
        await updateEntry(this.hubRoot, entry.id, {
          status: finalStatus,
          ...(finalStatus === "failed" ? { reason: "orphaned_queue_state" } : {}),
        });
      }
    }
  }

  async _readAccepted(assignmentId: string, attemptNum: number): Promise<ReconcilerRecord | null> {
    try {
      return JSON.parse(await readFile(
        path.join(this._attemptDir(assignmentId, attemptNum), "accepted.json"),
        "utf8",
      ));
    } catch {
      const attempt = await this.assignments.getActiveAttempt(assignmentId);
      if (Number(attempt?.attempt) !== attemptNum || !attempt?.acceptedAt) return null;
      return {
        assignmentId,
        attempt: attemptNum,
        workerId: attempt.workerId || null,
        acceptedAt: attempt.acceptedAt,
      };
    }
  }

  async _readAttemptResult(
    assignmentId: string,
    attemptNum: number,
    { allowCommittedFile = false }: { allowCommittedFile?: boolean } = {},
  ): Promise<ReconcilerRecord | null> {
    const attempt = await this.assignments.getActiveAttempt(assignmentId);
    if (Number(attempt?.attempt) !== attemptNum) return null;
    const committedResult = recordValue(attempt?.result);
    if (Object.keys(committedResult).length > 0) return committedResult as ReconcilerRecord;
    if (!allowCommittedFile) return null;
    try {
      const parsed = JSON.parse(await readBoundedRegularFileNoFollow(
        path.join(this._attemptDir(assignmentId, attemptNum), "result.json"),
        { maxBytes: ATTEMPT_RESULT_MAX_BYTES },
      ));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as ReconcilerRecord
        : null;
    } catch {
      return null;
    }
  }

  async _readHeartbeat(assignmentId: string, attemptNum: number): Promise<ReconcilerRecord | null> {
    try {
      return JSON.parse(await readFile(
        path.join(this._attemptDir(assignmentId, attemptNum), "heartbeat.json"),
        "utf8",
      ));
    } catch {
      const attempt = await this.assignments.getActiveAttempt(assignmentId);
      if (Number(attempt?.attempt) !== attemptNum) return null;
      const heartbeat = recordValue(attempt?.heartbeat);
      return Object.keys(heartbeat).length > 0 ? heartbeat as ReconcilerRecord : null;
    }
  }

  _attemptDir(assignmentId: string, attemptNum: number): string {
    return path.join(this.hubRoot, "assignments", assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
  }

  async _pathExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
