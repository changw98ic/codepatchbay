import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

type DiagnosticRecord = Record<string, any>;

export type SanitizeRuntimeTextContext = {
  cpbRoot?: string;
  hubRoot?: string;
  executorRoot?: string;
};

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

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+\S+/g,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b[A-Za-z0-9+/_=-]{40,}\b/g,
];

const ABSOLUTE_PATH_PATTERN = /\/(?:[A-Za-z0-9._@-]+\/)+[A-Za-z0-9._@-]+/g;

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

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeRuntimeText(value: unknown, ctx: SanitizeRuntimeTextContext = {}): string {
  if (typeof value !== "string") return "";
  let out = value;
  const prefixes = [ctx.cpbRoot, ctx.hubRoot, ctx.executorRoot]
    .filter((candidate): candidate is string => Boolean(candidate));
  prefixes.sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (prefix && out.includes(prefix)) {
      out = out.split(prefix).join(`<root:${sha256Short(prefix)}>`);
    }
  }
  const tmp = os.tmpdir();
  if (tmp && out.includes(tmp)) {
    out = out.split(tmp).join("<tmp>");
  }
  const home = os.homedir();
  if (home && out.includes(home)) {
    out = out.split(home).join("<home>");
  }
  out = out.replace(ABSOLUTE_PATH_PATTERN, (match) => `<path:${sha256Short(match)}>`);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => "[REDACTED:sha256:12]");
  }
  return out.length <= MAX_DIAGNOSTIC_STRING_LENGTH
    ? out
    : `${out.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…[truncated]`;
}

function sanitizeDiagnosticValue(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeRuntimeText(value);
    if (SECRET_KEY.test(key)) return "[REDACTED]";
    return sanitized;
  }
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value;
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
