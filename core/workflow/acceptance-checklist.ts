// Facade module: re-exports the checklist domain split across
// checklist-shared / checklist-build / checklist-validate / checklist-match.
// Public API is preserved 1:1 — callers import from here unchanged.

import { FailureKind } from "../contracts/failure.js";
import {
  type RoutingContext,
  normalizeRepoRelativePaths,
} from "./checklist-shared.js";

export { normalizeRepoRelativePaths };
export const normalizeFixScope = normalizeRepoRelativePaths;

export {
  classifyAcceptanceRequirements,
  buildAcceptanceChecklist,
  extractTaskRequirementSlices,
} from "./checklist-build.js";

export {
  validateAcceptanceChecklist,
  validateDecomposedItems,
  validateChecklistSourceCoverage,
  validateChecklistVerdict,
  validateChecklistDagCoverage,
} from "./checklist-validate.js";

export {
  computeImpactedChecklistIds,
  evaluateChecklistCompletion,
} from "./checklist-match.js";

export function mapChecklistRoutingLabel(label: string, context: RoutingContext = {}): { kind: string; action: string; retryPhase: string | null; requiresFixScope: boolean; retryable: boolean } {
  const fixScope: string[] = Array.isArray(context.fixScope) ? context.fixScope : [];
  const targetChecklistIds: string[] = Array.isArray(context.targetChecklistIds) ? context.targetChecklistIds : [];
  const hasFixScope = fixScope.length > 0;
  const hasTargetChecklist = targetChecklistIds.length > 0;
  const evidenceMissingCause = context.evidenceMissingCause || "";

  switch (label) {
    case "scope_violation":
      return { kind: FailureKind.SCOPE_VIOLATION, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "checklist_failed":
      if (hasFixScope) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: true, retryable: true };
      }
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "checklist_incomplete":
      if (evidenceMissingCause === "probe_available_not_run") {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "verify", requiresFixScope: false, retryable: true };
      }
      if (hasFixScope) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: true, retryable: true };
      }
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "evidence_missing":
      if (evidenceMissingCause === "probe_available_not_run") {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "verify", requiresFixScope: false, retryable: true };
      }
      if (evidenceMissingCause === "probe_definition_missing") {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
      }
      if (evidenceMissingCause === "manual_approval_missing") {
        return { kind: FailureKind.HUMAN_APPROVAL_REQUIRED, action: "mark_blocked", retryPhase: null, requiresFixScope: false, retryable: false };
      }
      if (evidenceMissingCause === "behavior_failed_before_probe" || evidenceMissingCause === "implementationGap" || evidenceMissingCause === "implementation_gap") {
        if (hasFixScope) {
          return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: true, retryable: true };
        }
        return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
      }
      // Default evidence_missing: fail closed
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "evidence_mismatch":
      if (hasFixScope || hasTargetChecklist) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: hasFixScope, retryable: true };
      }
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "oracle_polluted":
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "evidence_stale":
      if (hasFixScope || hasTargetChecklist) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: hasFixScope, retryable: true };
      }
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "artifact_invalid":
      return { kind: FailureKind.ARTIFACT_INVALID, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "verdict_invalid":
    case "checklist_invalid":
      return { kind: FailureKind.VERDICT_INVALID, action: "retry_same_worker", retryPhase: "verify", requiresFixScope: false, retryable: true };
    case "dag_uncovered":
      return { kind: FailureKind.ARTIFACT_INVALID, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "runtime_failure_ambiguous":
      return { kind: FailureKind.ARTIFACT_INVALID, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "poisoned_session":
      return { kind: FailureKind.POISONED_SESSION, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "runjob_panic":
      return { kind: FailureKind.RUNJOB_PANIC, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "needs_clarification":
      return { kind: FailureKind.HUMAN_APPROVAL_REQUIRED, action: "mark_blocked", retryPhase: null, requiresFixScope: false, retryable: false };
    case "infra_error":
      // infra_error maps to existing runtime/timeout/worker kinds; use unknown for V1
      return { kind: FailureKind.RUNTIME_INTERRUPTED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    default:
      // Unknown labels fail closed
      return { kind: FailureKind.UNKNOWN, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
  }
}
