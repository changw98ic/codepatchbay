/**
 * Assignment Finalizer — PR/review bundle finalization after successful job.
 *
 * Extracted from managed-worker.js for single-responsibility:
 * post-job finalization and result persistence.
 */

import path from "node:path";
import { AnyRecord } from "../../shared/types.js";
import { finalizeSuccessfulQueueEntry, resolveGithubTransport, resolveProjectDataRoot } from "../../bridges/runtime-services.js";
import { writeJsonOnce } from "../../shared/fs-utils.js";

function metadataValue(metadata: AnyRecord, keys: string[]) {
  for (const key of keys) {
    if (metadata?.[key] !== undefined) return metadata[key];
  }
  return undefined;
}

function liveFinalizeAllowed(metadata: AnyRecord): boolean {
  return Boolean(
    metadata?.allowLiveFinalize === true
    || metadata?.liveFinalize === true
    || metadata?.finalize?.allowLive === true
    || metadata?.finalizer?.allowLive === true
  );
}

function resolveFinalizeMode(metadata: AnyRecord = {}) {
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
}: AnyRecord = {}) {
  const metadata = assignment?.metadata || {};
  const autoFinalize = Boolean(metadata.autoFinalize && assignment?.sourcePath);
  if (!autoFinalize || result?.status !== "completed" || !worktreeInfo) return null;

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
    const entry = {
      id: assignment.entryId,
      projectId: assignment.projectId,
      description: assignment.task,
      metadata,
    };
    const job = {
      status: "completed",
      worktree: worktreeInfo.path,
      jobId: effectiveJobId,
      project: assignment.projectId,
      sourceContext: assignment.sourceContext || {},
      worktreeBranch: worktreeInfo.branch,
      task: assignment.task,
      planMode: assignment.planMode,
      completionGate: result?.completionGate || result?.completionGateResult || null,
    };

    const finalizeResult: AnyRecord = await finalizeQueueEntry({
      cpbRoot,
      hubRoot,
      dataRoot: effectiveDataRoot,
      project: assignment.projectId,
      entry,
      job,
      sourcePath: assignment.sourcePath,
      mode: finalizeMode,
      allowLiveFinalize: liveFinalize,
      issueCloser: liveFinalize ? transport?.closeIssue || null : null,
      createPullRequest: liveFinalize ? transport?.createPullRequest || null : null,
      pushToken: liveFinalize && transport?.getToken ? await transport.getToken().catch(() => null) : null,
      transportMode: transport?.mode || null,
    });

    if (finalizeResult.ok) {
      log?.info?.(`finalize: ${finalizeResult.status} pr=${finalizeResult.prUrl || "n/a"}`);
    } else {
      log?.warn?.(`finalize: ${finalizeResult.status} code=${finalizeResult.code || "unknown"}`);
    }

    return finalizeResult;
  } catch (err: unknown) {
    log?.warn?.(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
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
  writeResult = writeJsonOnce,
}: AnyRecord = {}) {
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
  });

  await writeResult(path.join(attemptDir, "result.json"), {
    assignmentId,
    attempt: attemptNum,
    attemptToken: assignment.attemptToken,
    status: result.status,
    jobResult: result,
    finalizeResult: finalizeResult || null,
    writtenAt: new Date().toISOString(),
  });

  return finalizeResult;
}
