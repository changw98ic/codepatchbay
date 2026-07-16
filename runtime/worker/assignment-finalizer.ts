/**
 * Assignment Finalizer — PR/review bundle finalization after successful job.
 *
 * Extracted from managed-worker.js for single-responsibility:
 * post-job finalization and result persistence.
 */

import path from "node:path";
import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
import { finalizeSuccessfulQueueEntry, resolveGithubTransport, resolveProjectDataRoot } from "../../bridges/runtime-services.js";
import { writeJsonOnce } from "../../shared/fs-utils.js";

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
};

type JobResult = LooseRecord & {
  status?: string;
  jobId?: string;
  failure?: LooseRecord;
  completionGate?: unknown;
  completionGateResult?: unknown;
};

type FinalizerLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

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
  finalizeQueueEntry?: typeof finalizeSuccessfulQueueEntry;
};
type FinalizeOptions = NonNullable<Parameters<typeof finalizeSuccessfulQueueEntry>[0]>;

type WriteResult = (file: string, value: unknown) => Promise<unknown>;

type FinalizeAndWriteInput = MaybeFinalizeInput & {
  attemptDir?: string;
  assignmentId?: string;
  writeResult?: WriteResult;
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

function finalizerFailureReason(finalizeResult: LooseRecord | null) {
  if (!finalizeResult) return "finalizer returned no result";
  return String(
    finalizeResult.reason
    || finalizeResult.message
    || finalizeResult.error
    || finalizeResult.code
    || finalizeResult.status
    || "finalizer failed",
  );
}

function failedJobResult(
  result: JobResult,
  finalizeResult: LooseRecord | null,
  worktreeInfo: WorktreeInfo | null | undefined,
): JobResult {
  const status = finalizeResult?.status === "blocked" ? "blocked" : "failed";
  const reason = finalizerFailureReason(finalizeResult);
  return {
    ...result,
    status,
    failure: {
      kind: FINALIZER_FAILURE_KIND,
      phase: "finalize",
      reason,
      retryable: finalizeResult?.retryable === true,
      cause: {
        finalizer: finalizeResult,
        executionResult: result,
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

  try {
    const finalizeMode = resolveFinalizeMode(metadata);
    const liveFinalize = finalizeMode !== "dry-run";
    const transport = liveFinalize ? await resolveTransport(hubRoot) : null;
    const effectiveDataRoot = dataRoot
      || assignment?.dataRoot
      || assignment?.projectRuntimeRoot
      || metadata?.dataRoot
      || metadata?.projectRuntimeRoot
      || (cpbRoot && assignment?.projectId
        ? await resolveDataRoot(cpbRoot, assignment.projectId, { hubRoot }).catch(() => null)
        : null);
    const effectiveJobId = jobId || result?.jobId || `job-${assignment.entryId}${attemptNum > 1 ? `-a${attemptNum}` : ""}`;
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
      task: assignment.task,
      planMode: assignment.planMode,
      completionGate,
    });
    const closeIssue = transport && typeof transport.closeIssue === "function" ? transport.closeIssue : null;
    const createPullRequest = transport && typeof transport.createPullRequest === "function" ? transport.createPullRequest : null;
    const getToken = transport && typeof transport.getToken === "function" ? transport.getToken : null;

    const rawFinalizeResult = await finalizeQueueEntry({
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
    });
    const finalizeResult: LooseRecord = isRecord(rawFinalizeResult)
      ? rawFinalizeResult
      : finalizerFailure(
          "FINALIZER_RESULT_MISSING",
          "finalizer returned no structured result",
        );

    if (finalizeResult.ok) {
      log?.info?.(`finalize: ${finalizeResult.status} pr=${finalizeResult.prUrl || "n/a"}`);
    } else {
      log?.warn?.(`finalize: ${finalizeResult.status} code=${finalizeResult.code || "unknown"}`);
    }

    return finalizeResult;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    log?.warn?.(`finalize failed: ${reason}`);
    return finalizerFailure("FINALIZER_EXCEPTION", reason, {
      error: reason,
    });
  }
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
  });

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
