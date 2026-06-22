type LooseRecord = Record<string, unknown>;

type CompletedJobResult = {
  status: "completed";
  jobId: string;
  exitCode: 0;
  failure: null;
  phaseResults: LooseRecord[];
};

type CompletionSuccessInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phaseResults: LooseRecord[];
  completeJob: (cpbRoot: string, project: string, jobId: string) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

async function reportProgress(
  onProgress: CompletionSuccessInput["onProgress"],
  event: LooseRecord,
  now: () => string,
) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({ ts: now(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

export async function handleCompletionSuccess({
  cpbRoot,
  project,
  jobId,
  phaseResults,
  completeJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: CompletionSuccessInput): Promise<CompletedJobResult> {
  await reportProgress(onProgress, { type: "completion_gate_passed", jobId, project }, now);
  await completeJob(cpbRoot, project, jobId);
  await reportProgress(onProgress, { type: "job_completed", jobId, project }, now);

  return {
    status: "completed",
    jobId,
    exitCode: 0,
    failure: null,
    phaseResults,
  };
}
