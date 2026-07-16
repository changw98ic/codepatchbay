import { FailureKind } from "../contracts/failure.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import { evaluateScopeGuard, normalizeFixScope } from "./scope-guard.js";
import type { PhaseResult } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type ScopeGuardInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  nodeId: string;
  phase: string;
  role: string;
  attemptId?: string | null;
  dagNode?: unknown;
  phaseSourceContext?: unknown;
  phaseResult: PhaseResult;
  phaseResults: LooseRecord[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

type FailedJobResult = {
  status: "failed";
  jobId: string;
  exitCode: 1;
  failure: LooseRecord;
  phaseResults: LooseRecord[];
};

function retryFixScope(sourceContext: unknown) {
  const context = recordValue(sourceContext);
  const retryContext = recordValue(context.retryContext);
  const retry = recordValue(context.retry);
  const retryVerification = recordValue(retry.verification);

  const firstNonEmptyScope = (values: unknown[]) => {
    for (const value of values) {
      if (value === undefined || value === null || value === false || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      const scope = normalizeFixScope(value) || [];
      if (scope.length > 0) return scope;
    }
    return [];
  };

  // Verification feedback distinguishes the narrow requested repair target
  // (fixScope) from the frozen boundary within which that repair may add
  // supporting changes such as regression tests (allowedFixScope). Enforce the
  // frozen boundary when present, and retain the requested scope as the legacy
  // fallback when no explicit allowed boundary exists.
  const allowedFixScope = firstNonEmptyScope([
    retryContext.allowedFixScope,
    retry.allowedFixScope,
    retryContext.allowed_fix_scope,
    retry.allowed_fix_scope,
    retryVerification.allowedFixScope,
    retryVerification.allowed_fix_scope,
  ]);
  if (allowedFixScope.length > 0) return allowedFixScope;

  return firstNonEmptyScope([
    retryContext.fixScope,
    retry.fixScope,
    retryContext.fix_scope,
    retry.fix_scope,
    retryVerification.retryScope,
  ]);
}

function rawChangedFiles(result: PhaseResult): unknown[] {
  const files = recordValue(result.artifact?.metadata).changedFiles || result.artifact?.files || [];
  return Array.isArray(files) ? files : [];
}

function checklistIds(dagNode: unknown) {
  const node = recordValue(dagNode);
  return Array.isArray(node.checklistIds) ? node.checklistIds : [];
}

async function reportProgress(
  onProgress: ScopeGuardInput["onProgress"],
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

export async function evaluateExecuteScopeGuard({
  cpbRoot,
  project,
  jobId,
  nodeId,
  phase,
  role,
  attemptId = null,
  dagNode = {},
  phaseSourceContext = {},
  phaseResult,
  phaseResults,
  appendEvent,
  failJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: ScopeGuardInput): Promise<FailedJobResult | null> {
  if (phase !== "execute" || !isPhasePassed(phaseResult)) return null;

  const fixScope = retryFixScope(phaseSourceContext);
  if (!Array.isArray(fixScope) || fixScope.length === 0) return null;

  const scopeResult = evaluateScopeGuard({
    changedFiles: rawChangedFiles(phaseResult),
    fixScope,
  });
  await appendEvent(cpbRoot, project, jobId, {
    type: "scope_guard_evaluated",
    jobId,
    project,
    phase,
    withinScope: scopeResult.withinScope,
    violations: scopeResult.violations,
    fixScope: scopeResult.fixScope,
    changedFiles: scopeResult.changedFiles,
    ts: now(),
  });
  if (scopeResult.withinScope) return null;

  const violationList = scopeResult.violations.join(", ");
  await reportProgress(onProgress, {
    type: "scope_guard_violation",
    jobId,
    project,
    phase,
    violations: scopeResult.violations,
    fixScope: scopeResult.fixScope,
  }, now);
  await appendEvent(cpbRoot, project, jobId, {
    type: "dag_node_failed",
    jobId,
    project,
    nodeId,
    phase,
    role,
    attemptId,
    code: "scope_guard_violation",
    reason: `Scope guard violation: changed files outside fix_scope: ${violationList}`,
    error: `Scope guard violation: ${violationList}`,
    checklistIds: checklistIds(dagNode),
    ts: now(),
  });
  await failJob(cpbRoot, project, jobId, {
    reason: `Scope guard violation: changed files outside fix_scope: ${violationList}`,
    code: "scope_guard_violation",
    phase,
    cause: { violations: scopeResult.violations, fixScope: scopeResult.fixScope },
  });
  await reportProgress(onProgress, {
    type: "job_failed",
    jobId,
    project,
    phase,
    failureKind: FailureKind.SCOPE_VIOLATION,
    reason: `Scope guard violation: ${violationList}`,
  }, now);
  return {
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: FailureKind.SCOPE_VIOLATION,
      phase,
      nodeId,
      reason: `Changed files outside fix_scope: ${violationList}`,
      retryable: false,
      cause: { routingLabel: "scope_violation", violations: scopeResult.violations, fixScope: scopeResult.fixScope },
    },
    phaseResults,
  };
}
