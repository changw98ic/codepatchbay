import path from "node:path";

type DiagnosticRecord = Record<string, any>;

export type LivePipelineDiagnosticInput = {
  queue: unknown;
  assignment: unknown;
  workers?: unknown[];
};

export type LivePipelineCompletionInput = LivePipelineDiagnosticInput & {
  timedOut: boolean;
  timeoutMs: number;
};

export type LivePipelineDiagnostics = {
  queue: DiagnosticRecord;
  assignment: DiagnosticRecord;
  workers: DiagnosticRecord[];
};

export type LiveWorktreeEvidence = {
  path: string;
  cleanup: DiagnosticRecord;
};

const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_KEYS = 100;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 50;
const MAX_DIAGNOSTIC_STRING_LENGTH = 4_096;
const SECRET_KEY = /(?:authorization|cookie|credential|password|secret|session|token)/i;

const STATE_KEYS = [
  "id",
  "entryId",
  "assignmentId",
  "projectId",
  "status",
  "workerId",
  "currentAssignmentId",
  "activeAttempt",
  "attempt",
  "attempts",
  "pid",
  "exitCode",
  "createdAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "failedAt",
  "lastHeartbeatAt",
  "progressUpdatedAt",
  "reason",
  "failureReason",
  "blockedReason",
  "error",
  "lastError",
  "failure",
  "jobResult",
  "dispatchFailure",
  "metadata",
  "disposition",
  "ok",
  "cleanupVerified",
  "canonicalPathRemoved",
  "quarantinePreserved",
  "quarantinePath",
] as const;

function recordValue(value: unknown): DiagnosticRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as DiagnosticRecord
    : {};
}

function sanitizeDiagnosticValue(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= MAX_DIAGNOSTIC_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…[truncated]`;
  }
  if (depth >= MAX_DIAGNOSTIC_DEPTH) return "[truncated-depth]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
      .map((entry) => sanitizeDiagnosticValue(entry, "", depth + 1));
  }
  if (typeof value !== "object") return String(value);

  const entries = Object.entries(value as DiagnosticRecord).slice(0, MAX_DIAGNOSTIC_KEYS);
  return Object.fromEntries(entries.map(([entryKey, entryValue]) => [
    entryKey,
    sanitizeDiagnosticValue(entryValue, entryKey, depth + 1),
  ]));
}

function diagnosticState(value: unknown): DiagnosticRecord {
  const record = recordValue(value);
  const selected: DiagnosticRecord = {};
  for (const key of STATE_KEYS) {
    if (!(key in record)) continue;
    selected[key] = sanitizeDiagnosticValue(record[key], key);
  }
  return selected;
}

export function buildLivePipelineDiagnostics(
  input: LivePipelineDiagnosticInput,
): LivePipelineDiagnostics {
  return {
    queue: diagnosticState(input.queue),
    assignment: diagnosticState(input.assignment),
    workers: Array.isArray(input.workers)
      ? input.workers.map((worker) => diagnosticState(worker))
      : [],
  };
}

export function assertLivePipelineCompleted(input: LivePipelineCompletionInput): void {
  const diagnostics = buildLivePipelineDiagnostics(input);
  if (diagnostics.queue.status === "completed" && diagnostics.assignment.status === "completed") {
    return;
  }

  const code = input.timedOut
    ? "CPB_LIVE_PIPELINE_TIMEOUT"
    : "CPB_LIVE_PIPELINE_TERMINAL_FAILURE";
  const summary = input.timedOut
    ? `live pipeline did not reach completion within ${input.timeoutMs}ms`
    : "live pipeline reached a non-completed terminal state";
  throw Object.assign(new Error(`${summary}: ${JSON.stringify(diagnostics)}`), {
    code,
    diagnostics,
  });
}

export function resolveLiveWorktreeEvidence(resultValue: unknown): LiveWorktreeEvidence {
  const result = recordValue(resultValue);
  const cleanup = recordValue(recordValue(result.cleanup).worktree);
  const quarantinePath = typeof cleanup.quarantinePath === "string" ? cleanup.quarantinePath : "";
  if (
    result.status !== "completed"
    || cleanup.disposition !== "quarantined"
    || cleanup.ok !== true
    || cleanup.cleanupVerified !== true
    || cleanup.canonicalPathRemoved !== true
    || cleanup.quarantinePreserved !== true
    || !path.isAbsolute(quarantinePath)
  ) {
    throw Object.assign(new Error(`live pipeline result lacks verified worktree quarantine evidence: ${JSON.stringify(
      diagnosticState(cleanup),
    )}`), {
      code: "CPB_LIVE_WORKTREE_EVIDENCE_INVALID",
      diagnostics: { cleanup: diagnosticState(cleanup) },
    });
  }
  return { path: quarantinePath, cleanup };
}
