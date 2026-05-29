export function jobCompleted({ jobId, phaseResults }) {
  return {
    schemaVersion: 1,
    status: "completed",
    jobId,
    phaseResults,
    failure: null,
    completedAt: new Date().toISOString(),
  };
}

export function jobFailed({ jobId, phaseResults, failure }) {
  return {
    schemaVersion: 1,
    status: "failed",
    jobId,
    phaseResults,
    failure,
    failedAt: new Date().toISOString(),
  };
}

export function isJobCompleted(result) {
  return result?.status === "completed";
}
