/**
 * Assignment Finalizer — PR/review bundle finalization after successful job.
 *
 * Extracted from managed-worker.js for single-responsibility:
 * post-job finalization and result persistence.
 */

import path from "node:path";
import { AnyRecord } from "../../shared/types.js";
import { finalizeSuccessfulQueueEntry, resolveGithubTransport } from "../../bridges/runtime-services.js";
import { writeJsonOnce } from "../../shared/fs-utils.js";

export async function maybeFinalizeSuccessfulAssignment({
  cpbRoot,
  hubRoot,
  assignment,
  attemptNum,
  jobId,
  result,
  worktreeInfo,
  log = null,
  resolveTransport = resolveGithubTransport,
  finalizeQueueEntry = finalizeSuccessfulQueueEntry,
}: AnyRecord = {}) {
  const metadata = assignment?.metadata || {};
  const autoFinalize = Boolean(metadata.autoFinalize && assignment?.sourcePath);
  if (!autoFinalize || result?.status !== "completed" || !worktreeInfo) return null;

  try {
    const transport = await resolveTransport(hubRoot);
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
    };

    const finalizeResult: AnyRecord = await finalizeQueueEntry({
      cpbRoot,
      hubRoot,
      project: assignment.projectId,
      entry,
      job,
      sourcePath: assignment.sourcePath,
      mode: "pr",
      issueCloser: transport?.closeIssue || null,
      createPullRequest: transport?.createPullRequest || null,
      pushToken: transport?.getToken ? await transport.getToken().catch(() => null) : null,
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
