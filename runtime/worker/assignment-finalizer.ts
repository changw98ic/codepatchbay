/**
 * Assignment Finalizer — PR/review bundle finalization after successful job.
 *
 * Extracted from managed-worker.js for single-responsibility:
 * post-job finalization and result persistence.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
import {
  finalizeSuccessfulQueueEntry,
  redactSecrets,
  resolveGithubTransport,
  resolveProjectDataRoot,
  validateFinalizerMutationReceipt,
} from "../../bridges/runtime-services.js";
import { writeJsonOnce } from "../../shared/fs-utils.js";
import { readBoundedRegularFileNoFollow } from "../../core/runtime/durable-directory-lock.js";
import {
  finalizerResultMatchesCandidate,
  sameValidatedFinalizerCandidate,
  verifyFinalizerCandidateCommit,
  validatedFinalizerCandidate,
  type ValidatedFinalizerCandidate,
} from "../../shared/orchestrator/finalizer-candidate.js";
import { verifiedCanonicalReviewBundlePath } from "../../shared/orchestrator/review-bundle-path.js";

type AssignmentMetadata = LooseRecord & {
  finalize?: LooseRecord;
  finalizer?: LooseRecord;
};

type AssignmentPayload = LooseRecord & {
  assignmentId?: string;
  entryId: string;
  projectId: string;
  task?: string;
  sourcePath?: string;
  sourceContext?: LooseRecord;
  dataRoot?: string;
  projectRuntimeRoot?: string;
  planMode?: string;
  metadata?: AssignmentMetadata;
  attemptToken?: string;
  orchestratorEpoch?: number;
};

type WorktreeInfo = LooseRecord & {
  path: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
};

type JobResult = LooseRecord & {
  status?: string;
  jobId?: string;
  failure?: LooseRecord;
  completionGate?: unknown;
  completionGateResult?: unknown;
  completionReport?: unknown;
};

type FinalizerLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type FinalizerMutationOperation =
  | "journal.claim"
  | "journal.intent"
  | "journal.receipt"
  | "journal.complete"
  | "source.commit"
  | "source.sync"
  | "repository.push"
  | "issue.close"
  | "pull_request.push"
  | "pull_request.create"
  | "pr_opened.publish"
  | "review_bundle.publish"
  | "result.publish";

export type FinalizerMutationLeaseContext = {
  operation: FinalizerMutationOperation;
  phase: "before-write";
  mode: string;
  project: string;
  entryId: string;
  jobId: string;
  finalizationId: string | null;
  generation: number | null;
  repository: string | null;
  issueNumber: string | number | null;
  commit: string | null;
  tree: string | null;
};

export type AssertFinalizerMutationLease = (
  context: FinalizerMutationLeaseContext,
) => void | boolean | Promise<void | boolean>;

export type FinalizerMutationFence = {
  assignmentId: string;
  entryId: string;
  attemptToken: string;
  orchestratorEpoch: number;
  workerId: string;
  workerIncarnation: string;
  processIdentity: {
    pid: number;
    startTimeTicks: string;
    bootId?: string;
  };
  takeover?: {
    kind: "owner-dead" | "explicit-handoff";
    previousClaimId: string;
    evidenceId: string;
    observedAt: string;
  };
};

export type ValidateFinalizerMutationReceipt = (
  result: unknown,
  expected: {
    mode: "remote" | "pr";
    binding: LooseRecord;
  },
) => { ok: true; receipt: LooseRecord } | { ok: false; reason: string };

type MaybeFinalizeInput = LooseRecord & {
  cpbRoot?: string;
  hubRoot?: string;
  dataRoot?: string | null;
  assignment?: AssignmentPayload;
  attemptNum?: number;
  jobId?: string;
  result?: JobResult;
  worktreeInfo?: WorktreeInfo | null;
  log?: FinalizerLog | null;
  resolveTransport?: typeof resolveGithubTransport;
  resolveDataRoot?: typeof resolveProjectDataRoot;
  finalizeQueueEntry?: (options: FinalizeOptions) => Promise<unknown>;
  assertMutationLease?: AssertFinalizerMutationLease | null;
  mutationFence?: FinalizerMutationFence | null;
  validateMutationReceipt?: ValidateFinalizerMutationReceipt | null;
};
type FinalizeOptions = NonNullable<Parameters<typeof finalizeSuccessfulQueueEntry>[0]>;

type WriteResult = (file: string, value: unknown) => Promise<unknown>;

type FinalizeAndWriteInput = MaybeFinalizeInput & {
  attemptDir?: string;
  assignmentId?: string;
  writeResult?: WriteResult;
};

export type RecoverFinalizerOnly = (options: LooseRecord) => Promise<unknown>;

type RecoverAndWriteFinalizerOnlyInput = FinalizeAndWriteInput & {
  recoverFinalizerOnly: RecoverFinalizerOnly;
  verifiedPriorAttempt?: LooseRecord | null;
};

const FINALIZER_FAILURE_KIND = "finalizer_failed";

function finalizerFailure(code: string, reason: string, extra: LooseRecord = {}) {
  return {
    ok: false,
    status: "failed",
    code,
    reason,
    retryable: false,
    ...extra,
  };
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function triState(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function redactedRecord(value: unknown): LooseRecord {
  const redacted = redactSecrets(value);
  return isRecord(redacted) ? redacted : {};
}

function redactedText(value: unknown, fallback: string): string {
  const redacted = redactSecrets(String(value || fallback));
  return typeof redacted === "string" && redacted.trim() ? redacted : fallback;
}

function sanitizedFinalizerResult(value: unknown): LooseRecord {
  return redactedRecord(value);
}

function integerValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function finalizerRepository(assignment: AssignmentPayload | undefined): string | null {
  const metadata = assignment?.metadata || {};
  const sourceContext = isRecord(assignment?.sourceContext) ? assignment.sourceContext : {};
  const metadataCapability = isRecord(metadata.remoteCapability) ? metadata.remoteCapability : {};
  const sourceCapability = isRecord(sourceContext.remoteCapability) ? sourceContext.remoteCapability : {};
  const candidates = [
    metadataCapability.repository,
    sourceCapability.repository,
    metadata.repo,
    metadata.repository,
    sourceContext.repo,
    sourceContext.repository,
  ].filter((value) => value !== undefined && value !== null && value !== "");
  if (candidates.length === 0) return null;
  const normalized = candidates.map(normalizeGithubRepository);
  if (normalized.some((value) => !value)) return null;
  const repositories = new Set(normalized as string[]);
  return repositories.size === 1 ? [...repositories][0] : null;
}

function normalizeGithubRepository(value: unknown): string | null {
  const repository = textValue(value)?.toLowerCase() || "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9](?:[a-z0-9._-]{0,99})$/.test(repository)) return null;
  const [owner, name] = repository.split("/");
  if (owner.endsWith("-") || name.endsWith(".") || name.endsWith(".git") || name.includes("..")) return null;
  return repository;
}

function finalizerIssueNumber(assignment: AssignmentPayload | undefined): string | number | null {
  const metadata = assignment?.metadata || {};
  const sourceContext = isRecord(assignment?.sourceContext) ? assignment.sourceContext : {};
  const metadataCapability = isRecord(metadata.remoteCapability) ? metadata.remoteCapability : {};
  const sourceCapability = isRecord(sourceContext.remoteCapability) ? sourceContext.remoteCapability : {};
  const value = metadataCapability.issueNumber
    ?? sourceCapability.issueNumber
    ?? metadata.issueNumber
    ?? sourceContext.issueNumber;
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function finalizerValidationBinding(
  assignment: AssignmentPayload,
  worktreeInfo: WorktreeInfo | null,
  jobId: string,
  mode: string,
  mutationFence: FinalizerMutationFence | null,
  principal: LooseRecord | null,
  candidate: ValidatedFinalizerCandidate | null,
  recoveryBinding: LooseRecord | null = null,
): LooseRecord {
  const metadata = assignment.metadata || {};
  const sourceContext = isRecord(assignment.sourceContext) ? assignment.sourceContext : {};
  const capability = isRecord(metadata.remoteCapability)
    ? metadata.remoteCapability
    : isRecord(sourceContext.remoteCapability)
      ? sourceContext.remoteCapability
      : {};
  const configuredSourceBranch = textValue(worktreeInfo?.baseBranch)
    || textValue(sourceContext.sourceBranch)
    || textValue(metadata.sourceBranch)
    || textValue(capability.defaultBranch);
  const recoveredSource = isRecord(recoveryBinding?.source) ? recoveryBinding.source : null;
  const sourceBranch = recoveredSource ? textValue(recoveredSource.branch) : configuredSourceBranch;
  const sourceHead = recoveredSource
    ? textValue(recoveredSource.head)
    : textValue(worktreeInfo?.baseCommit)
      || textValue(sourceContext.sourceHead)
      || textValue(metadata.sourceHead);
  const targetBranch = textValue(recoveryBinding?.targetBranch)
    || (mode === "pr" ? textValue(worktreeInfo?.branch) : sourceBranch);
  const preRemoteHead = recoveryBinding && Object.hasOwn(recoveryBinding, "preRemoteHead")
    ? recoveryBinding.preRemoteHead
    : mode === "pr"
      ? null
      : sourceHead;
  return {
    capability,
    source: {
      path: assignment.sourcePath || null,
      branch: sourceBranch,
      head: sourceHead,
    },
    worktree: {
      path: worktreeInfo?.path || null,
      branch: textValue(worktreeInfo?.branch),
      baseBranch: textValue(worktreeInfo?.baseBranch) || sourceBranch,
    },
    project: assignment.projectId,
    entryId: assignment.entryId,
    jobId,
    originJobId: textValue(recoveryBinding?.originJobId) || jobId,
    mutationFence,
    principal,
    candidate,
    targetBranch,
    preRemoteHead,
    ...(recoveryBinding?.claimPolicy === "durable-observation" ? {
      claimPolicy: "durable-observation",
      acceptedOwnerDigest: recoveryBinding.acceptedOwnerDigest,
    } : {}),
  };
}

function sourceSyncValid(result: LooseRecord, binding: LooseRecord): boolean {
  const commit = textValue(result.commit);
  const sourceSync = isRecord(result.sourceSync) ? result.sourceSync : null;
  const source = isRecord(binding.source) ? binding.source : {};
  if (!commit || !sourceSync) return false;
  const expectedBranch = textValue(sourceSync.expectedBranch);
  const previousHead = textValue(sourceSync.previousHead);
  const expectedHead = textValue(sourceSync.expectedHead);
  const actualBranch = textValue(sourceSync.actualBranch);
  const actualHead = textValue(sourceSync.actualHead);
  return sourceSync.committed === true
    && sourceSync.clean === true
    && Boolean(expectedBranch)
    && expectedBranch === textValue(source.branch)
    && previousHead === textValue(source.head)
    && expectedHead === commit
    && actualBranch === expectedBranch
    && actualHead === commit;
}

function committedWriteReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.attempted === true && value.committed === true;
}

function remoteIntentValid(value: unknown, expectedStage: string): boolean {
  if (!isRecord(value)) return false;
  const generation = integerValue(value.generation);
  return Boolean(textValue(value.finalizationId))
    && generation !== null
    && generation > 0
    && value.stage === expectedStage;
}

function canonicalPrUrl(repository: string, prNumber: number): string {
  return `https://github.com/${repository}/pull/${prNumber}`;
}

async function reviewBundleResultError(
  result: LooseRecord,
  {
    hubRoot,
    project,
    jobId,
    success,
  }: {
    hubRoot?: string;
    project: string;
    jobId: string;
    success: boolean;
  },
): Promise<string | null> {
  if (!hubRoot || !path.isAbsolute(hubRoot)) return "review bundle validation requires an absolute hub root";
  if (result.mode !== "review_bundle" || result.jobId !== jobId) {
    return "review bundle identity does not match the active invocation";
  }
  let expectedPath: string;
  try {
    expectedPath = await verifiedCanonicalReviewBundlePath(path.resolve(hubRoot), project, jobId);
  } catch {
    return "review bundle identity cannot produce a canonical owner-bound path";
  }
  if (result.bundlePath !== expectedPath) return "review bundle path is not the canonical owner-bound path";

  let content: string;
  try {
    content = await readBoundedRegularFileNoFollow(expectedPath, { maxBytes: 16 * 1024 * 1024 });
  } catch {
    return "review bundle durable file is missing or unsafe";
  }
  const bundleBytes = Buffer.byteLength(content, "utf8");
  const bundleSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  if (result.bundleBytes !== bundleBytes) {
    return "review bundle byte receipt does not match the durable file";
  }
  if (result.bundleSha256 !== bundleSha256) {
    return "review bundle digest receipt does not match the durable file";
  }

  if (success) {
    const audit = isRecord(result.audit) ? result.audit : null;
    if (result.ok !== true
      || result.status !== "review_bundle"
      || result.committed !== true
      || result.eventRecorded !== true
      || !audit
      || audit.eventType !== "review_bundle_created"
      || audit.jobId !== jobId
      || audit.project !== project
      || audit.bundlePath !== expectedPath) {
      return "review bundle success is missing its durable event audit receipt";
    }
    return null;
  }

  if (result.ok !== false
    || result.status !== "blocked"
    || result.code !== "REVIEW_BUNDLE_EVENT_RECORD_FAILED"
    || result.committed !== true
    || result.eventRecorded !== false
    || result.retryable !== true) {
    return "review bundle event failure does not preserve the committed bundle truth";
  }
  return null;
}

function successfulFinalizerResultError(
  result: LooseRecord,
  expectedMode: string,
  expectedJobId: string,
  repository: string | null,
  binding: LooseRecord,
): string | null {
  if (result.ok !== true) return "finalizer success must set ok=true";
  if (result.mode !== expectedMode) return `finalizer mode must be ${expectedMode}`;
  if (result.jobId !== expectedJobId) return "finalizer result jobId does not match the active invocation";

  if (expectedMode === "dry-run") {
    if (result.status !== "dry-run") return "dry-run finalizer status must be dry-run";
    if (result.committed !== false) return "dry-run finalizer must set committed=false";
    if (!isRecord(result.pr) || result.pr.status !== "dry-run") {
      return "dry-run finalizer must include a dry-run PR preview";
    }
    return null;
  }

  if (!textValue(result.commit)) return "live finalizer result is missing commit identity";
  if (result.committed !== true) return "live finalizer success must set committed=true";

  if (expectedMode === "local") {
    if (result.status !== "finalized") return "local finalizer status must be finalized";
    if (!finalizerResultMatchesCandidate(result, isRecord(binding.candidate)
      ? binding.candidate as ValidatedFinalizerCandidate
      : null)) {
      return "local finalizer commit/tree does not match the durable completion candidate";
    }
    if (!sourceSyncValid(result, binding)) return "local finalizer is missing an exact clean source readback receipt";
    return null;
  }

  const remoteWrites = isRecord(result.remoteWrites) ? result.remoteWrites : null;
  if (!remoteWrites) return "live finalizer success is missing remote write receipts";

  if (expectedMode === "remote") {
    if (result.status !== "finalized") return "remote finalizer status must be finalized";
    if (result.pushed !== true || result.closed !== true || result.localSynced !== true) {
      return "remote finalizer success requires pushed, closed, and localSynced receipts";
    }
    if (!committedWriteReceipt(remoteWrites.push) || !committedWriteReceipt(remoteWrites.issueClose)) {
      return "remote finalizer success has incomplete push or issue-close receipts";
    }
    if (!remoteIntentValid(result.remoteIntent, "local.complete")) {
      return "remote finalizer success has no completed durable intent generation";
    }
    if (!sourceSyncValid(result, binding)) return "remote finalizer is missing an exact clean source readback receipt";
    return null;
  }

  if (expectedMode === "pr") {
    const prNumber = integerValue(result.prNumber);
    if (result.status !== "pr.opened") return "PR finalizer status must be pr.opened";
    if (result.pushed !== true || result.closed !== false || result.eventRecorded !== true) {
      return "PR finalizer success requires push, open PR, and event receipts";
    }
    if (!committedWriteReceipt(remoteWrites.branchPush)
      || !committedWriteReceipt(remoteWrites.pullRequestCreate)) {
      return "PR finalizer success has incomplete branch-push or PR-create receipts";
    }
    if (!remoteIntentValid(result.remoteIntent, "event.complete")) {
      return "PR finalizer success has no completed durable intent generation";
    }
    if (!repository || prNumber === null || prNumber <= 0) {
      return "PR finalizer result is missing bound repository or PR number";
    }
    if (result.prUrl !== canonicalPrUrl(repository, prNumber)) {
      return "PR finalizer URL does not match the bound repository and PR number";
    }
    return null;
  }

  return `unsupported finalizer mode: ${expectedMode}`;
}

function retainedFinalizerEvidence(value: unknown): LooseRecord {
  if (!isRecord(value)) return {};
  const retained: LooseRecord = {};
  for (const key of [
    "mode",
    "jobId",
    "commit",
    "tree",
    "finalizationId",
    "generation",
    "remoteIntent",
    "remoteWrites",
    "sourceSync",
    "localSynced",
    "pushed",
    "closed",
    "prUrl",
    "prNumber",
    "eventRecorded",
    "bundlePath",
    "bundleSha256",
    "bundleBytes",
    "audit",
  ]) {
    if (value[key] !== undefined) retained[key] = redactSecrets(value[key]);
  }
  return retained;
}

function invalidFinalizerResult(
  result: LooseRecord,
  reason: string,
  mode: string,
  jobId: string,
) {
  const live = mode !== "dry-run";
  return finalizerFailure("FINALIZER_RESULT_INVALID", redactedText(reason, "finalizer result is invalid"), {
    status: "rejected",
    ...retainedFinalizerEvidence(result),
    mode,
    jobId,
    committed: live ? null : false,
    retryable: live,
  });
}

export async function normalizeFinalizerResult(
  rawResult: unknown,
  {
    mode,
    jobId,
    repository = null,
    hubRoot,
    project = "",
    binding = {},
    validateMutationReceipt = validateFinalizerMutationReceipt,
  }: {
    mode: string;
    jobId: string;
    repository?: string | null;
    hubRoot?: string;
    project?: string;
    binding?: LooseRecord;
    validateMutationReceipt?: ValidateFinalizerMutationReceipt | null;
  },
): Promise<LooseRecord> {
  if (!isRecord(rawResult)) {
    return finalizerFailure(
      "FINALIZER_RESULT_MISSING",
      "finalizer returned no structured result",
      { mode, jobId, committed: mode === "dry-run" ? false : null, retryable: mode !== "dry-run" },
    );
  }

  if (mode === "dry-run" && rawResult.mode === "review_bundle") {
    const success = rawResult.ok === true;
    const error = await reviewBundleResultError(rawResult, {
      hubRoot,
      project,
      jobId,
      success,
    });
    if (!error) return sanitizedFinalizerResult(rawResult);
    return finalizerFailure("FINALIZER_RESULT_INVALID", error, {
      status: "rejected",
      ...retainedFinalizerEvidence(rawResult),
      mode: "review_bundle",
      jobId,
      committed: rawResult.committed === true ? true : null,
      retryable: rawResult.committed === true,
      ...(rawResult.bundlePath !== undefined ? { bundlePath: rawResult.bundlePath } : {}),
      ...(rawResult.eventRecorded !== undefined ? { eventRecorded: rawResult.eventRecorded } : {}),
    });
  }

  if (rawResult.ok === true) {
    let successfulResult: LooseRecord = mode === "dry-run"
      ? {
          ...rawResult,
          ...(rawResult.jobId === undefined ? { jobId } : {}),
          ...(rawResult.committed === undefined ? { committed: false } : {}),
        }
      : rawResult;
    if (mode === "remote" || mode === "pr") {
      if (!validateMutationReceipt) {
        return invalidFinalizerResult(
          rawResult,
          "strict finalizer journal receipt validator is unavailable",
          mode,
          jobId,
        );
      }
      const validation = validateMutationReceipt(rawResult, { mode, binding });
      if ("reason" in validation) {
        return invalidFinalizerResult(rawResult, validation.reason, mode, jobId);
      }
      successfulResult = validation.receipt;
    }
    const error = successfulFinalizerResultError(successfulResult, mode, jobId, repository, binding);
    return error
      ? invalidFinalizerResult(successfulResult, error, mode, jobId)
      : sanitizedFinalizerResult(successfulResult);
  }

  const statusValid = ["blocked", "rejected", "skipped"].includes(String(rawResult.status || ""));
  const code = textValue(rawResult.code);
  const failureResult = mode === "dry-run" && rawResult.jobId === undefined
    ? { ...rawResult, jobId }
    : rawResult;
  const resultJobId = textValue(failureResult.jobId);
  const committedValid = typeof rawResult.committed === "boolean" || rawResult.committed === null;
  const committed = committedValid ? rawResult.committed as boolean | null : null;
  const retryableValid = typeof rawResult.retryable === "boolean";
  const retryable = retryableValid ? rawResult.retryable as boolean : committed === null;
  const identityValid = failureResult.mode === mode && resultJobId === jobId;
  const committedFailureValid = committed !== true
    || (mode !== "dry-run" && failureResult.status === "blocked" && retryable === true);
  if (failureResult.ok !== false
    || !statusValid
    || !code
    || !identityValid
    || !committedValid
    || !retryableValid
    || !committedFailureValid) {
    return invalidFinalizerResult(
      failureResult,
      "finalizer failure has an invalid status, identity, committed tri-state, or retryability contract",
      mode,
      jobId,
    );
  }
  return {
    ...redactedRecord(failureResult),
    mode,
    jobId,
    committed,
    retryable,
  };
}

function finalizerExceptionResult(error: unknown, mode: string, jobId: string): LooseRecord {
  const record = isRecord(error) ? error : {};
  const nested = isRecord(record.finalizeResult) ? record.finalizeResult : {};
  const evidence = {
    ...retainedFinalizerEvidence(nested),
    ...retainedFinalizerEvidence(record),
  };
  const reason = redactedText(
    error instanceof Error ? error.message : String(record.message || error),
    "finalizer failed (details redacted)",
  );
  const code = textValue(record.code) || textValue(nested.code) || "FINALIZER_EXCEPTION";
  const committed = record.committed !== undefined
    ? triState(record.committed)
    : nested.committed !== undefined
      ? triState(nested.committed)
      : null;
  const reportedMode = textValue(record.mode) || textValue(nested.mode);
  const reportedJobId = textValue(record.jobId) || textValue(nested.jobId);
  return finalizerFailure(code, reason, {
    ...redactedRecord(evidence),
    status: ["blocked", "rejected", "skipped"].includes(String(record.status || ""))
      ? record.status
      : "blocked",
    mode,
    jobId,
    committed,
    retryable: record.retryable === true || nested.retryable === true || committed === null,
    ...((reportedMode && reportedMode !== mode) || (reportedJobId && reportedJobId !== jobId)
      ? {
          reportedIdentity: {
            mode: reportedMode,
            jobId: reportedJobId,
          },
        }
      : {}),
    error: reason,
  });
}

function finalizerFailureReason(finalizeResult: LooseRecord | null) {
  if (!finalizeResult) return "finalizer returned no result";
  return redactedText(
    finalizeResult.reason
    || finalizeResult.message
    || finalizeResult.error
    || finalizeResult.code
    || finalizeResult.status
    || "finalizer failed",
    "finalizer failed (details redacted)",
  );
}

function failedJobResult(
  result: JobResult,
  finalizeResult: LooseRecord | null,
  worktreeInfo: WorktreeInfo | null | undefined,
): JobResult {
  const status = finalizeResult?.status === "blocked" ? "blocked" : "failed";
  const reason = finalizerFailureReason(finalizeResult);
  const safeResult = redactedRecord(result);
  const safeFinalizeResult = redactedRecord(finalizeResult);
  return {
    ...safeResult,
    status,
    failure: {
      kind: FINALIZER_FAILURE_KIND,
      phase: "finalize",
      reason,
      retryable: finalizeResult?.retryable === true,
      cause: {
        finalizer: safeFinalizeResult,
        executionResult: safeResult,
        worktreePath: worktreeInfo?.path || null,
        worktreeBranch: worktreeInfo?.branch || null,
      },
    },
  };
}

function metadataValue(metadata: AssignmentMetadata, keys: string[]) {
  for (const key of keys) {
    if (metadata?.[key] !== undefined) return metadata[key];
  }
  return undefined;
}

function liveFinalizeAllowed(metadata: AssignmentMetadata): boolean {
  return Boolean(
    metadata?.allowLiveFinalize === true
    || metadata?.liveFinalize === true
    || metadata?.finalize?.allowLive === true
    || metadata?.finalizer?.allowLive === true
  );
}

function resolveFinalizeMode(metadata: AssignmentMetadata = {}) {
  const requested = metadataValue(metadata, ["finalizeMode", "finalizerMode"])
    ?? metadata?.finalize?.mode
    ?? metadata?.finalizer?.mode;
  const normalized = String(requested || "dry-run").trim().toLowerCase().replace(/_/g, "-");
  if (["dry-run", "dryrun", "preview", "pr-preview"].includes(normalized)) return "dry-run";
  if (["pr", "remote", "local"].includes(normalized) && liveFinalizeAllowed(metadata)) return normalized;
  return "dry-run";
}

export async function maybeFinalizeSuccessfulAssignment({
  cpbRoot,
  hubRoot,
  dataRoot,
  assignment,
  attemptNum,
  jobId,
  result,
  worktreeInfo,
  log = null,
  resolveTransport = resolveGithubTransport,
  resolveDataRoot = resolveProjectDataRoot,
  finalizeQueueEntry = finalizeSuccessfulQueueEntry,
  assertMutationLease = null,
  mutationFence = null,
  validateMutationReceipt = validateFinalizerMutationReceipt,
}: MaybeFinalizeInput = {}) {
  const metadata = assignment?.metadata || {};
  const autoFinalize = metadata.autoFinalize === true;
  if (!autoFinalize || result?.status !== "completed") return null;
  if (!assignment?.sourcePath) {
    return finalizerFailure(
      "FINALIZER_SOURCE_PATH_MISSING",
      "auto-finalize requires an assignment sourcePath",
    );
  }
  if (!worktreeInfo?.path) {
    return finalizerFailure(
      "FINALIZER_WORKTREE_MISSING",
      "auto-finalize requires a preserved worktree",
    );
  }

  const finalizeMode = resolveFinalizeMode(metadata);
  const liveFinalize = finalizeMode !== "dry-run";
  const candidate = validatedFinalizerCandidate(result);
  const effectiveJobId = jobId
    || result?.jobId
    || `job-${assignment.entryId}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;

  try {
    const remoteFinalize = finalizeMode === "remote" || finalizeMode === "pr";
    if (liveFinalize && (
      !candidate
      || !textValue(worktreeInfo.baseCommit)
      || candidate.baseSha !== textValue(worktreeInfo.baseCommit)?.toLowerCase()
    )) {
      return finalizerFailure(
        "FINALIZER_CANDIDATE_BINDING_INVALID",
        "live finalization requires a completion-gate candidate bound to the managed worktree base",
        { mode: finalizeMode, jobId: jobId || result?.jobId || null, committed: false, retryable: false },
      );
    }
    const transport = remoteFinalize ? await resolveTransport(hubRoot) : null;
    const effectiveDataRoot = dataRoot
      || assignment?.dataRoot
      || assignment?.projectRuntimeRoot
      || metadata?.dataRoot
      || metadata?.projectRuntimeRoot
      || (cpbRoot && assignment?.projectId
        ? await resolveDataRoot(cpbRoot, assignment.projectId, { hubRoot }).catch(() => null)
        : null);
    const completionGate = isRecord(result?.completionGate)
      ? result.completionGate
      : isRecord(result?.completionGateResult)
        ? result.completionGateResult
        : null;
    const entry: FinalizeOptions["entry"] = {};
    Object.assign(entry, {
      id: assignment.entryId,
      projectId: assignment.projectId,
      description: assignment.task,
      metadata,
    });
    const job: FinalizeOptions["job"] = {};
    Object.assign(job, {
      status: "completed",
      worktree: worktreeInfo.path,
      jobId: effectiveJobId,
      project: assignment.projectId,
      sourceContext: assignment.sourceContext || {},
      worktreeBranch: worktreeInfo.branch,
      worktreeBaseBranch: worktreeInfo.baseBranch,
      worktreeBaseCommit: worktreeInfo.baseCommit,
      task: assignment.task,
      planMode: assignment.planMode,
      completionGate,
      ...(isRecord(result?.completionReport) ? { completionReport: result.completionReport } : {}),
    });
    const closeIssue = transport && typeof transport.closeIssue === "function" ? transport.closeIssue : null;
    const createPullRequest = transport && typeof transport.createPullRequest === "function" ? transport.createPullRequest : null;
    const getToken = transport && typeof transport.getToken === "function" ? transport.getToken : null;
    const remoteAuthorityValidator = transport && typeof transport.remoteAuthorityValidator === "function"
      ? transport.remoteAuthorityValidator as NonNullable<FinalizeOptions["remoteAuthorityValidator"]>
      : null;
    const remoteCommitVerifier = transport && typeof transport.remoteCommitVerifier === "function"
      ? transport.remoteCommitVerifier as NonNullable<FinalizeOptions["remoteCommitVerifier"]>
      : null;
    const principal = isRecord(transport) && isRecord(transport.principal)
      ? transport.principal
      : null;

    const finalizeOptions: FinalizeOptions & {
      assertMutationLease?: AssertFinalizerMutationLease;
      mutationFence?: FinalizerMutationFence;
    } = {
      cpbRoot,
      hubRoot,
      dataRoot: effectiveDataRoot,
      project: assignment.projectId,
      entry,
      job,
      sourcePath: assignment.sourcePath,
      mode: finalizeMode,
      allowLiveFinalize: liveFinalize,
      issueCloser: liveFinalize && closeIssue ? (issue) => closeIssue(issue) : null,
      createPullRequest: liveFinalize && createPullRequest ? (request) => createPullRequest(request) : null,
      pushToken: liveFinalize && getToken ? await Promise.resolve(getToken()).catch(() => null) : null,
      transportMode: typeof transport?.mode === "string" ? transport.mode : null,
      remoteAuthorityValidator: liveFinalize ? remoteAuthorityValidator : null,
      remoteCommitVerifier: liveFinalize ? remoteCommitVerifier : null,
      transportPrincipal: (liveFinalize ? principal : null) as FinalizeOptions["transportPrincipal"],
      ...(assertMutationLease ? { assertMutationLease } : {}),
      ...(mutationFence ? { mutationFence } : {}),
    };
    const rawFinalizeResult = await finalizeQueueEntry(finalizeOptions);
    if (liveFinalize && isRecord(rawFinalizeResult)) {
      const needsCandidateCommitProof = rawFinalizeResult.ok === true
        || isRecord(rawFinalizeResult.remoteIntent)
        || textValue(rawFinalizeResult.commit) !== null
        || textValue(rawFinalizeResult.tree) !== null;
      if (needsCandidateCommitProof && !(await verifyFinalizerCandidateCommit({
        repositoryPath: worktreeInfo.path,
        result: rawFinalizeResult,
        candidate,
      }))) {
        return invalidFinalizerResult(
          rawFinalizeResult,
          "finalizer commit/tree is not the checked-out durable completion candidate",
          finalizeMode,
          effectiveJobId,
        );
      }
    }
    const binding = finalizerValidationBinding(
      assignment,
      worktreeInfo,
      effectiveJobId,
      finalizeMode,
      mutationFence,
      principal,
      candidate,
    );
    const finalizeResult = await normalizeFinalizerResult(rawFinalizeResult, {
      mode: finalizeMode,
      jobId: effectiveJobId,
      repository: finalizerRepository(assignment),
      hubRoot,
      project: assignment.projectId,
      binding,
      validateMutationReceipt,
    });

    const sanitized = sanitizedFinalizerResult(finalizeResult);
    if (sanitized.ok) {
      log?.info?.(`finalize: ${sanitized.status} pr=${sanitized.prUrl || "n/a"}`);
    } else {
      log?.warn?.(`finalize: ${sanitized.status} code=${sanitized.code || "unknown"}`);
    }

    return sanitized;
  } catch (err: unknown) {
    const reason = redactedText(err instanceof Error ? err.message : String(err), "finalizer failed (details redacted)");
    log?.warn?.(`finalize failed: ${reason}`);
    const exceptionResult = finalizerExceptionResult(err, finalizeMode, effectiveJobId);
    const needsCandidateCommitProof = isRecord(exceptionResult.remoteIntent)
      || textValue(exceptionResult.commit) !== null
      || textValue(exceptionResult.tree) !== null;
    if (liveFinalize && needsCandidateCommitProof && !(await verifyFinalizerCandidateCommit({
      repositoryPath: worktreeInfo.path,
      result: exceptionResult,
      candidate,
    }))) {
      return invalidFinalizerResult(
        exceptionResult,
        "failed finalizer mutation evidence is not bound to the checked-out durable completion candidate",
        finalizeMode,
        effectiveJobId,
      );
    }
    return exceptionResult;
  }
}

export async function recoverAndWriteFinalizerOnlyResult({
  cpbRoot,
  hubRoot,
  dataRoot,
  assignment,
  attemptDir,
  assignmentId,
  attemptNum,
  jobId,
  log = null,
  resolveTransport = resolveGithubTransport,
  resolveDataRoot = resolveProjectDataRoot,
  recoverFinalizerOnly,
  writeResult = writeJsonOnce,
  assertMutationLease = null,
  mutationFence = null,
  verifiedPriorAttempt = null,
  validateMutationReceipt = validateFinalizerMutationReceipt,
}: RecoverAndWriteFinalizerOnlyInput): Promise<LooseRecord> {
  const metadata = assignment?.metadata || {};
  const recovery = isRecord(metadata.finalizerRecovery) ? metadata.finalizerRecovery : {};
  const effectiveJobId = jobId || `job-${assignment?.entryId || "unknown"}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;
  const mode = resolveFinalizeMode(metadata);
  const verifiedGateCandidate = isRecord(verifiedPriorAttempt?.completionGate)
    ? validatedFinalizerCandidate({ completionGate: verifiedPriorAttempt.completionGate })
    : null;
  const verifiedCandidate = isRecord(verifiedPriorAttempt?.candidate)
    ? verifiedPriorAttempt.candidate as ValidatedFinalizerCandidate
    : null;
  let finalizeResult: LooseRecord;

  if (!assignment || recovery.schema !== "cpb.finalizer-recovery.v1" || recovery.required !== true) {
    finalizeResult = finalizerFailure(
      "FINALIZER_RECOVERY_CONTRACT_INVALID",
      "finalizer-only recovery requires a canonical recovery assignment",
      { mode, jobId: effectiveJobId, committed: null, retryable: false },
    );
  } else if (mode !== "remote" && mode !== "pr") {
    finalizeResult = finalizerFailure(
      "FINALIZER_RECOVERY_MODE_INVALID",
      "finalizer-only recovery supports only remote or PR mode",
      { mode, jobId: effectiveJobId, committed: null, retryable: false },
    );
  } else if (!isRecord(verifiedPriorAttempt)
    || !/^[a-f0-9]{64}$/.test(textValue(verifiedPriorAttempt.ownerDigest) || "")
    || !isRecord(verifiedPriorAttempt.source)
    || !isRecord(verifiedPriorAttempt.candidate)
    || !isRecord(verifiedPriorAttempt.completionGate)
    || !sameValidatedFinalizerCandidate(verifiedCandidate, verifiedGateCandidate)
    || !textValue(verifiedPriorAttempt.originJobId)
    || !textValue(verifiedPriorAttempt.targetBranch)) {
    finalizeResult = finalizerFailure(
      "FINALIZER_RECOVERY_PROOF_INVALID",
      "finalizer-only recovery requires a verified prior-attempt journal binding",
      { mode, jobId: effectiveJobId, committed: null, retryable: false },
    );
  } else {
    try {
      const transport = await resolveTransport(hubRoot);
      const principal = isRecord(transport) && isRecord(transport.principal)
        ? transport.principal
        : null;
      const remoteCommitVerifier = transport && typeof transport.remoteCommitVerifier === "function"
        ? transport.remoteCommitVerifier as NonNullable<FinalizeOptions["remoteCommitVerifier"]>
        : null;
      const remoteAuthorityValidator = transport && typeof transport.remoteAuthorityValidator === "function"
        ? transport.remoteAuthorityValidator as NonNullable<FinalizeOptions["remoteAuthorityValidator"]>
        : null;
      const closeIssue = transport && typeof transport.closeIssue === "function" ? transport.closeIssue : null;
      const createPullRequest = transport && typeof transport.createPullRequest === "function"
        ? transport.createPullRequest
        : null;
      const getToken = transport && typeof transport.getToken === "function" ? transport.getToken : null;
      const sourceContext = isRecord(assignment.sourceContext) ? assignment.sourceContext : {};
      const remoteCapability = isRecord(metadata.remoteCapability)
        ? metadata.remoteCapability
        : isRecord(sourceContext.remoteCapability)
          ? sourceContext.remoteCapability
          : null;
      const effectiveDataRoot = dataRoot
        || assignment.dataRoot
        || assignment.projectRuntimeRoot
        || metadata.dataRoot
        || metadata.projectRuntimeRoot
        || (cpbRoot
          ? await resolveDataRoot(cpbRoot, assignment.projectId, { hubRoot }).catch(() => null)
          : null);
      const raw = !textValue(cpbRoot) || !textValue(effectiveDataRoot)
        ? finalizerFailure(
            "FINALIZER_RECOVERY_STORAGE_UNAVAILABLE",
            "finalizer-only recovery requires durable CPB and project data roots",
            { mode, jobId: effectiveJobId, committed: null, retryable: true },
          )
        : await recoverFinalizerOnly({
            cpbRoot,
            hubRoot,
            dataRoot: effectiveDataRoot,
            project: assignment.projectId,
            entryId: assignment.entryId,
            jobId: effectiveJobId,
            originJobId: verifiedPriorAttempt.originJobId,
            sourcePath: assignment.sourcePath || null,
            remoteCapability,
            transportPrincipal: principal,
            transportMode: typeof transport?.mode === "string" ? transport.mode : null,
            pushToken: recovery.allowMutation === true && getToken
              ? await Promise.resolve(getToken()).catch(() => null)
              : null,
            remoteAuthorityValidator,
            remoteCommitVerifier,
            issueCloser: closeIssue ? (issue: LooseRecord) => closeIssue(issue) : null,
            createPullRequest: createPullRequest
              ? (request: LooseRecord) => createPullRequest(request)
              : null,
            assertMutationLease,
            mutationFence,
            allowMutation: recovery.allowMutation === true,
          });
      const binding = finalizerValidationBinding(
        assignment,
        null,
        effectiveJobId,
        mode,
        mutationFence,
        principal,
        isRecord(verifiedPriorAttempt.candidate)
          ? verifiedPriorAttempt.candidate as ValidatedFinalizerCandidate
          : null,
        {
          source: verifiedPriorAttempt.source,
          originJobId: verifiedPriorAttempt.originJobId,
          targetBranch: verifiedPriorAttempt.targetBranch,
          preRemoteHead: verifiedPriorAttempt.preRemoteHead ?? null,
          ...(recovery.allowMutation === true ? {} : {
            claimPolicy: "durable-observation",
            acceptedOwnerDigest: verifiedPriorAttempt.ownerDigest,
          }),
        },
      );
      finalizeResult = await normalizeFinalizerResult(raw, {
        mode,
        jobId: effectiveJobId,
        repository: finalizerRepository(assignment),
        hubRoot,
        project: assignment.projectId,
        binding,
        validateMutationReceipt,
      });
    } catch (error: unknown) {
      finalizeResult = finalizerExceptionResult(error, mode, effectiveJobId);
    }
  }

  finalizeResult = sanitizedFinalizerResult(finalizeResult);
  const recovered = finalizeResult.ok === true;
  const baseResult: JobResult = recovered
    ? {
      status: "completed",
      jobId: effectiveJobId,
      completionGate: verifiedPriorAttempt?.completionGate,
      finalizerRecovery: {
          mode: "finalizer-only",
          generation: integerValue(recovery.generation),
          allowMutation: recovery.allowMutation === true,
        },
      }
    : failedJobResult(
        { status: "completed", jobId: effectiveJobId },
        finalizeResult,
        null,
      );
  const persistedStatus = recovered
    ? "completed"
    : finalizeResult.status === "blocked"
      ? "blocked"
      : "failed";

  if (assertMutationLease) {
    const remoteIntent = isRecord(finalizeResult.remoteIntent) ? finalizeResult.remoteIntent : {};
    const allowed = await assertMutationLease({
      operation: "result.publish",
      phase: "before-write",
      mode,
      project: assignment?.projectId || "",
      entryId: assignment?.entryId || "",
      jobId: effectiveJobId,
      finalizationId: textValue(remoteIntent.finalizationId) || textValue(finalizeResult.finalizationId),
      generation: integerValue(remoteIntent.generation) ?? integerValue(finalizeResult.generation),
      repository: finalizerRepository(assignment),
      issueNumber: finalizerIssueNumber(assignment),
      commit: textValue(finalizeResult.commit),
      tree: textValue(finalizeResult.tree),
    });
    if (allowed === false) {
      throw Object.assign(new Error("finalizer mutation lease lost before recovery result publication"), {
        code: "MUTATION_LEASE_LOST",
        committed: null,
        retryable: true,
        finalizeResult,
      });
    }
  }

  await writeResult(path.join(attemptDir, "result.json"), {
    assignmentId,
    attempt: attemptNum,
    attemptToken: assignment?.attemptToken,
    ...(assignment?.orchestratorEpoch !== undefined ? { orchestratorEpoch: assignment.orchestratorEpoch } : {}),
    status: persistedStatus,
    jobResult: baseResult,
    finalizeResult,
    finalization: {
      required: true,
      ok: recovered,
      status: finalizeResult.status || (recovered ? "finalized" : "blocked"),
      code: finalizeResult.code || null,
      recoveryOnly: true,
    },
    recovery: recovered
      ? null
      : {
          retainWorktree: false,
          reason: "finalizer_only_recovery_incomplete",
          journalBound: true,
        },
    writtenAt: new Date().toISOString(),
  });

  if (recovered) log?.info?.(`finalizer-only recovery completed (${mode})`);
  else log?.warn?.(`finalizer-only recovery blocked code=${finalizeResult.code || "unknown"}`);
  return finalizeResult;
}

export async function finalizeAndWriteSuccessfulResult({
  cpbRoot,
  hubRoot,
  dataRoot,
  assignment,
  attemptDir,
  assignmentId,
  attemptNum,
  jobId,
  result,
  worktreeInfo,
  log = null,
  resolveTransport = resolveGithubTransport,
  resolveDataRoot = resolveProjectDataRoot,
  finalizeQueueEntry = finalizeSuccessfulQueueEntry,
  writeResult = writeJsonOnce,
  assertMutationLease = null,
  mutationFence = null,
  validateMutationReceipt = validateFinalizerMutationReceipt,
}: FinalizeAndWriteInput = {}) {
  const finalizeResult = await maybeFinalizeSuccessfulAssignment({
    cpbRoot,
    hubRoot,
    dataRoot,
    assignment,
    attemptNum,
    jobId,
    result,
    worktreeInfo,
    log,
    resolveTransport,
    resolveDataRoot,
    finalizeQueueEntry,
    assertMutationLease,
    mutationFence,
    validateMutationReceipt,
  });

  const structuredFinalizeResult: LooseRecord = isRecord(finalizeResult)
    ? finalizeResult as LooseRecord
    : {};
  if (structuredFinalizeResult.code === "ASSIGNMENT_CANCELLED"
    && structuredFinalizeResult.committed === false
    && !isRecord(structuredFinalizeResult.remoteIntent)
    && !isRecord(structuredFinalizeResult.remoteWrites)) {
    throw Object.assign(
      new Error(finalizerFailureReason(finalizeResult)),
      finalizeResult,
      { finalizeResult },
    );
  }

  const finalizationRequired = assignment?.metadata?.autoFinalize === true && result?.status === "completed";
  const finalizationOk = !finalizationRequired || finalizeResult?.ok === true;
  const persistedJobResult = finalizationOk
    ? result
    : failedJobResult(result, finalizeResult, worktreeInfo);
  const persistedStatus = persistedJobResult?.status === "completed"
    ? "completed"
    : persistedJobResult?.status === "cancelled"
      ? "cancelled"
      : persistedJobResult?.status === "blocked"
        ? "blocked"
        : "failed";
  const retainedWorktree = persistedStatus !== "completed" && Boolean(worktreeInfo?.path);

  if (assertMutationLease) {
    const structuredFinalizeResult: LooseRecord = isRecord(finalizeResult) ? finalizeResult : {};
    const remoteIntent = isRecord(structuredFinalizeResult.remoteIntent)
      ? structuredFinalizeResult.remoteIntent
      : {};
    const allowed = await assertMutationLease({
      operation: "result.publish",
      phase: "before-write",
      mode: textValue(structuredFinalizeResult.mode) || resolveFinalizeMode(assignment?.metadata || {}),
      project: assignment?.projectId || "",
      entryId: assignment?.entryId || "",
      jobId: textValue(structuredFinalizeResult.jobId) || jobId || result?.jobId || "",
      finalizationId: textValue(remoteIntent.finalizationId) || textValue(structuredFinalizeResult.finalizationId),
      generation: integerValue(remoteIntent.generation) ?? integerValue(structuredFinalizeResult.generation),
      repository: finalizerRepository(assignment),
      issueNumber: finalizerIssueNumber(assignment),
      commit: textValue(structuredFinalizeResult.commit),
      tree: textValue(structuredFinalizeResult.tree),
    });
    if (allowed === false) {
      throw Object.assign(new Error("finalizer mutation lease lost before result publication"), {
        code: "MUTATION_LEASE_LOST",
        committed: null,
        retryable: true,
        finalizeResult,
      });
    }
  }

  await writeResult(path.join(attemptDir, "result.json"), {
    assignmentId,
    attempt: attemptNum,
    attemptToken: assignment.attemptToken,
    ...(assignment.orchestratorEpoch !== undefined ? { orchestratorEpoch: assignment.orchestratorEpoch } : {}),
    status: persistedStatus,
    jobResult: persistedJobResult,
    finalizeResult: finalizeResult || null,
    finalization: {
      required: finalizationRequired,
      ok: finalizationOk,
      status: finalizeResult?.status || (finalizationRequired ? "failed" : "not_required"),
      code: finalizeResult?.code || null,
    },
    recovery: retainedWorktree
      ? {
          retainWorktree: true,
          worktreePath: worktreeInfo?.path || null,
          worktreeBranch: worktreeInfo?.branch || null,
          reason: persistedStatus === "blocked" ? "finalization_blocked" : "attempt_failed",
        }
      : null,
    writtenAt: new Date().toISOString(),
  });

  return finalizeResult;
}
