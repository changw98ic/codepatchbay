import type { failure } from "../contracts/failure.js";
import { recordValue, type LooseRecord } from "../contracts/types.js";

export type ProgressReporter = (event: LooseRecord) => Promise<unknown> | unknown;
export type AppendEvent = (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
export type BlockJob = (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
export type FailJob = (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
export type CompletePhase = (cpbRoot: string, project: string, jobId: string, payload: { phase: string; artifact: unknown }) => Promise<unknown> | unknown;
export type CompleteJob = (cpbRoot: string, project: string, jobId: string) => Promise<unknown> | unknown;

export type JobRecord = LooseRecord & {
  jobId: string;
};

export type JobRunResult = LooseRecord & {
  status: string;
  jobId: string;
  exitCode: number;
  failure?: LooseRecord | null;
};

export function ts() {
  return new Date().toISOString();
}

export async function reportProgress(ctx: { onProgress?: ProgressReporter | null }, event: LooseRecord) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: ts(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

export async function blockPreparedJob({
  cpbRoot,
  project,
  jobId,
  appendEvent,
  blockJob,
  failure: fail,
}: {
  cpbRoot: string;
  project: string;
  jobId: string;
  appendEvent: AppendEvent;
  blockJob?: BlockJob;
  failure: ReturnType<typeof failure>;
}) {
  const failCause = recordValue(fail.cause);
  const reason = failCause.code === undefined || failCause.code === null ? fail.reason : String(failCause.code);
  if (typeof blockJob === "function") {
    await blockJob(cpbRoot, project, jobId, {
      reason,
      code: fail.kind,
      kind: fail.kind,
      cause: fail.cause,
    });
    return;
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    code: fail.kind,
    kind: fail.kind,
    cause: fail.cause,
    ts: ts(),
  });
}

export async function failPreparedJob({
  cpbRoot,
  project,
  jobId,
  appendEvent,
  failJob,
  failure: fail,
}: {
  cpbRoot: string;
  project: string;
  jobId: string;
  appendEvent: AppendEvent;
  failJob?: FailJob;
  failure: ReturnType<typeof failure>;
}) {
  const failCause = recordValue(fail.cause);
  const reason = failCause.code === undefined || failCause.code === null ? fail.reason : String(failCause.code);
  const phase = fail.phase || "prepare_task";
  if (typeof failJob === "function") {
    await failJob(cpbRoot, project, jobId, {
      reason,
      code: fail.kind,
      kind: fail.kind,
      phase,
      cause: fail.cause,
    });
    return;
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    reason,
    code: fail.kind,
    kind: fail.kind,
    phase,
    cause: fail.cause,
    ts: ts(),
  });
}
