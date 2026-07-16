import { normalizeRepoRelativePaths } from "../engine/scope-guard.js";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";

export { isRecord, recordValue };

// Re-exported by acceptance-checklist.ts for backwards-compatible API.
export { normalizeRepoRelativePaths };

export type RoutingContext = LooseRecord & {
  fixScope?: unknown;
  evidenceMissingCause?: unknown;
  targetChecklistIds?: unknown;
};
export type SourceRef = LooseRecord & {
  kind?: unknown;
  locator?: unknown;
  ledgerId?: unknown;
  evidenceId?: unknown;
};
export type ChecklistItem = LooseRecord & {
  id?: unknown;
  requirement?: unknown;
  source?: unknown;
  sourceRefs?: SourceRef[];
  predicateId?: unknown;
  required?: unknown;
  area?: unknown;
  risk?: unknown;
  verificationMethod?: unknown;
  expectedEvidence?: unknown;
  evidenceClass?: unknown;
  requiredEvidenceClass?: unknown;
  evidenceOrigin?: unknown;
  requiredEvidenceOrigin?: unknown;
  requiresRealPathEvidence?: unknown;
  observableContract?: unknown;
  dependsOn?: unknown;
  allowedFiles?: unknown;
};
export type AcceptanceChecklist = LooseRecord & {
  schemaVersion?: unknown;
  jobId?: string | null;
  project?: string | null;
  status?: string | null;
  attemptId?: unknown;
  items?: ChecklistItem[];
  assumptions?: Array<LooseRecord & { risk?: unknown; acceptedForExecution?: unknown; text?: unknown }>;
};
export type ChecklistVerdictItem = LooseRecord & {
  checklistId?: unknown;
  result?: unknown;
  evidenceRefs?: SourceRef[];
  reason?: unknown;
  fixScope?: unknown;
};
export type ChecklistVerdict = LooseRecord & {
  schemaVersion?: unknown;
  status?: unknown;
  items?: ChecklistVerdictItem[];
  fixScope?: unknown;
  blocking?: Array<LooseRecord & { checklistId?: unknown; criterion?: unknown; evidence?: unknown }>;
  reason?: unknown;
};
export type DocumentInput = LooseRecord & {
  kind?: unknown;
  locator?: unknown;
  text?: unknown;
  content?: unknown;
  path?: unknown;
};
export type ClassifiedRequirement = LooseRecord & {
  id?: unknown;
  kind?: unknown;
  locator?: unknown;
  acceptanceRelevant?: unknown;
  summary?: unknown;
  text?: unknown;
  sha256?: unknown;
};
export type RequirementClassification = LooseRecord & {
  classifiedRequirements?: ClassifiedRequirement[];
  artifact?: unknown;
};
export type RuntimeFailureRef = {
  type: string;
  attemptId: string | null;
  phase: string | null;
  nodeId: string | null;
  reason: string | null;
};
export type WorkflowDagNode = LooseRecord & {
  id?: unknown;
  phase?: unknown;
  dependsOn?: unknown;
  checklistIds?: unknown;
  custom?: unknown;
  sideEffecting?: unknown;
  checklistNeutral?: unknown;
};
export type WorkflowDagInput = LooseRecord & {
  nodes?: WorkflowDagNode[];
};

export const ITEM_RESULTS = new Set(["pass", "fail", "unchecked"]);
export const TOP_STATUSES = new Set(["pass", "fail"]);
export const RISK_VALUES = new Set(["low", "medium", "high"]);
export const VERIFICATION_METHODS = new Set(["command", "test", "static", "runtime_event", "artifact_event", "audit_export", "dag_event", "worker_lifecycle", "manual", "absence_check"]);

const CHECKLIST_ID_RE = /^AC-\d+$/;

export function recordArray<T extends LooseRecord = LooseRecord>(value: unknown): T[] {
  // retain: `filter(isRecord)` narrows to LooseRecord[] at most; the generic `T extends LooseRecord`
  // is a caller-declared narrower element type that the runtime record-shape guard cannot statically
  // prove, so the cast is the honest contract (no `any` introduced).
  return Array.isArray(value) ? value.filter(isRecord) as T[] : [];
}

export function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function isRepoRelativePosixPath(value: unknown) {
  const path = text(value);
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

/** A fixScope entry must be a file path, never a checklist ID like "AC-002". */
export function isChecklistId(value: unknown) {
  return CHECKLIST_ID_RE.test(text(value));
}

export function fail(reason: string, details: LooseRecord = {}) {
  return { ok: false as const, reason, details };
}

export function evidenceKey(ref: SourceRef) {
  return `${text(ref.ledgerId)}:${text(ref.evidenceId)}`;
}
