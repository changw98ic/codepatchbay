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
  // (fixScope) from the frozen boundary suggested by the verifier
  // (allowedFixScope). Both are audit hints only: a successful executor may
  // add source or test files anywhere inside its isolated worktree.
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

export async function evaluateExecuteScopeGuard({
  cpbRoot,
  project,
  jobId,
  phase,
  phaseSourceContext = {},
  phaseResult,
  appendEvent,
  now = () => new Date().toISOString(),
}: ScopeGuardInput): Promise<null> {
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

  // fixScope is a planning hint, not a file-write allowlist. The changed file
  // list is kept in the durable event above for review, while the isolated
  // worktree and protected-path controls remain the enforcement boundary.
  return null;
}
