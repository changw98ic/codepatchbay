import { validateEvidenceObservation } from "./evidence-probes.js";
import { FailureKind } from "../contracts/failure.js";

type AnyRecord = Record<string, any>;

export function mapChecklistRoutingLabel(label: string, context: AnyRecord = {}): { kind: string; action: string; retryPhase: string | null; requiresFixScope: boolean; retryable: boolean } {
  const fixScope: string[] = Array.isArray(context.fixScope) ? context.fixScope : [];
  const hasFixScope = fixScope.length > 0;
  const evidenceMissingCause = context.evidenceMissingCause || "";

  const closed: { kind: string; action: string; retryPhase: string | null; requiresFixScope: boolean; retryable: boolean } = {
    kind: FailureKind.SCOPE_VIOLATION,
    action: "mark_failed",
    retryPhase: null,
    requiresFixScope: false,
    retryable: false,
  };

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
      if (hasFixScope) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: true, retryable: true };
      }
      return { kind: FailureKind.VERIFICATION_FAILED, action: "mark_failed", retryPhase: null, requiresFixScope: false, retryable: false };
    case "evidence_stale":
      if (hasFixScope) {
        return { kind: FailureKind.VERIFICATION_FAILED, action: "retry_same_worker", retryPhase: "execute", requiresFixScope: true, retryable: true };
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

const ITEM_RESULTS = new Set(["pass", "fail", "unchecked"]);
const TOP_STATUSES = new Set(["pass", "fail"]);
const RISK_VALUES = new Set(["low", "medium", "high"]);
const VERIFICATION_METHODS = new Set(["command", "test", "static", "runtime_event", "artifact_event", "audit_export", "dag_event", "worker_lifecycle", "manual", "absence_check"]);

function text(value: any) {
  return typeof value === "string" ? value.trim() : "";
}

function isRepoRelativePosixPath(value: any) {
  const path = text(value);
  return Boolean(path) && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");
}

const CHECKLIST_ID_RE = /^AC-\d+$/;

/** A fixScope entry must be a file path, never a checklist ID like "AC-002". */
function isChecklistId(value: any) {
  return CHECKLIST_ID_RE.test(text(value));
}

function stripGitStatusPrefix(value: any) {
  return text(value).replace(/^[ MADRCU?!]{1,2}\s+/, "");
}

export function normalizeRepoRelativePaths(values: unknown) {
  const normalized = new Set<string>();
  for (const value of Array.isArray(values) ? values : [values]) {
    const path = stripGitStatusPrefix(value);
    if (!isRepoRelativePosixPath(path)) throw new Error(`invalid repo-relative path: ${String(value)}`);
    normalized.add(path);
  }
  return [...normalized].sort();
}

export const normalizeFixScope = normalizeRepoRelativePaths;

function fail(reason: string, details: AnyRecord = {}) {
  return { ok: false, reason, details };
}

function evidenceKey(ref: AnyRecord) {
  return `${text(ref.ledgerId)}:${text(ref.evidenceId)}`;
}

export function validateAcceptanceChecklist(checklist: AnyRecord) {
  if (!checklist || typeof checklist !== "object") return fail("checklist must be an object");
  if (checklist.schemaVersion !== 1) return fail("schemaVersion must be 1");
  if (!text(checklist.jobId)) return fail("jobId is required");
  if (!text(checklist.project)) return fail("project is required");
  if (checklist.status !== "frozen") return fail("checklist status must be frozen");
  if (!Array.isArray(checklist.items) || checklist.items.length === 0) return fail("items must be a non-empty array");
  for (const [index, assumption] of (Array.isArray(checklist.assumptions) ? checklist.assumptions : []).entries()) {
    if (assumption?.risk === "high" && assumption.acceptedForExecution === true) {
      return fail(`assumptions[${index}] high-risk assumption cannot be silently accepted`);
    }
    if (/\b(must|should|required|remain unchanged|non-regression)\b/i.test(text(assumption?.text))) {
      return fail(`assumptions[${index}] appears to contain an acceptance requirement`);
    }
  }
  const ids = new Set<string>();
  for (const [index, item] of checklist.items.entries()) {
    const prefix = `items[${index}]`;
    if (!text(item?.id)) return fail(`${prefix}.id is required`);
    if (ids.has(item.id)) return fail(`duplicate checklist id: ${item.id}`);
    ids.add(item.id);
    if (!text(item.requirement)) return fail(`${prefix}.requirement is required`);
    if (!text(item.source)) return fail(`${prefix}.source is required`);
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) return fail(`${prefix}.sourceRefs is required`);
    if (!text(item.predicateId)) return fail(`${prefix}.predicateId is required`);
    if (typeof item.required !== "boolean") return fail(`${prefix}.required must be boolean`);
    if (!text(item.area)) return fail(`${prefix}.area is required`);
    if (!RISK_VALUES.has(item.risk)) return fail(`${prefix}.risk must be low, medium, or high`);
    if (!VERIFICATION_METHODS.has(item.verificationMethod)) return fail(`${prefix}.verificationMethod is invalid`);
    if (!text(item.expectedEvidence)) return fail(`${prefix}.expectedEvidence is required`);
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) return fail(`${prefix}.dependsOn must be an array`);
    if (item.allowedFiles !== undefined && !Array.isArray(item.allowedFiles)) return fail(`${prefix}.allowedFiles must be an array`);
    for (const file of item.allowedFiles || []) {
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.allowedFiles contains invalid repo-relative path`);
    }
  }
  return { ok: true as const, reason: "", ids: [...ids] };
}

/**
 * Validate LLM-decomposed checklist items — the partial item definition the
 * planner produces BEFORE buildAcceptanceChecklist fills id/required/risk/area.
 * Mirrors validateAcceptanceChecklist's per-item checks for the fields the LLM
 * owns: requirement, predicateId (unique), verificationMethod (supported),
 * allowedFiles (repo-relative, NON-EMPTY — decomposition must declare scope,
 * otherwise the probe runner cannot match >0 and the whole point is lost).
 */
export function validateDecomposedItems(items: AnyRecord) {
  if (!Array.isArray(items) || items.length === 0) return fail("decomposedItems must be a non-empty array");
  const predicateIds = new Set<string>();
  for (const [index, entry] of items.entries()) {
    const prefix = `decomposedItems[${index}]`;
    if (!text(entry?.requirement)) return fail(`${prefix}.requirement is required`);
    const predicateId = text(entry?.predicateId);
    if (!predicateId) return fail(`${prefix}.predicateId is required`);
    if (predicateIds.has(predicateId)) return fail(`${prefix}.predicateId duplicate: ${predicateId}`);
    predicateIds.add(predicateId);
    if (!VERIFICATION_METHODS.has(entry.verificationMethod)) return fail(`${prefix}.verificationMethod is invalid`);
    const allowedFiles = Array.isArray(entry?.allowedFiles) ? entry.allowedFiles : [];
    if (allowedFiles.length === 0) return fail(`${prefix}.allowedFiles must be non-empty (decomposition must declare scope)`);
    for (const file of allowedFiles) {
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.allowedFiles contains invalid repo-relative path`);
    }
    if (entry.sourceRefs !== undefined && !Array.isArray(entry.sourceRefs)) return fail(`${prefix}.sourceRefs must be an array`);
  }
  return { ok: true as const, reason: "" };
}

export function validateChecklistSourceCoverage({ checklist, task, documents = [], requirementClassification }: AnyRecord) {
  const validation = validateAcceptanceChecklist(checklist);
  if (!validation.ok) return validation;
  const corpus = [
    { kind: "task_text", locator: "task:0", text: text(task) },
    ...documents.map((doc: AnyRecord, index: number) => ({ kind: doc.kind || "document", locator: doc.locator || `document:${index}`, text: text(doc.text || doc.content) })),
  ].filter((entry) => entry.text);
  const sourceKeys = new Set(corpus.map((entry) => `${entry.kind}:${entry.locator}`));
  for (const item of checklist.items) {
    for (const ref of item.sourceRefs || []) {
      if (!sourceKeys.has(`${text(ref.kind)}:${text(ref.locator)}`)) return fail(`missing checklist source ref: ${text(ref.kind)}:${text(ref.locator)}`);
    }
  }
  const requiredSources = (Array.isArray(requirementClassification?.classifiedRequirements)
    ? requirementClassification.classifiedRequirements
    : [])
    .filter((entry: AnyRecord) => entry.acceptanceRelevant === true)
    .map((entry: AnyRecord) => text(entry.locator))
    .filter(Boolean);
  for (const required of requiredSources) {
    if (!checklist.items.some((item: AnyRecord) => (item.sourceRefs || []).some((ref: AnyRecord) => text(ref.locator) === required))) {
      return fail(`acceptance-relevant source not covered: ${required}`);
    }
  }
  return { ok: true as const, reason: "" };
}

export async function classifyAcceptanceRequirements({ task, documents = [] }: AnyRecord) {
  // V1 starts with deterministic source slices. Later prompt-assisted
  // classification may add richer spans, but checklist coverage must be
  // validated against this independent input, not against the checklist itself.
  return {
    schemaVersion: 1,
    classifiedRequirements: [
      { id: "REQ-001", kind: "task_text", locator: "task:0", acceptanceRelevant: Boolean(text(task)) },
      ...documents.map((doc: AnyRecord, index: number) => ({
        id: `REQ-DOC-${index + 1}`,
        kind: doc.kind || "document",
        locator: doc.locator || `document:${index}`,
        acceptanceRelevant: Boolean(text(doc.text || doc.content)),
      })),
    ].filter((entry) => entry.acceptanceRelevant),
  };
}

export async function buildAcceptanceChecklist({ jobId, project, task, documents = [], riskMap, requirementClassification, decomposedItems }: AnyRecord) {
  const classification = requirementClassification || await classifyAcceptanceRequirements({ task, documents, riskMap });
  const risk = riskMap?.riskLevel === "high" ? "high" : "medium";
  const expectedEvidenceDefault = "method-specific evidence claim generated by a declared probe";
  // When the LLM decomposer supplies structured items (with allowedFiles scope),
  // build checklist items from them so the probe runner can match >0. Otherwise
  // fall back to the deterministic per-requirement map (allowedFiles:[]).
  const items = Array.isArray(decomposedItems) && decomposedItems.length > 0
    ? decomposedItems.map((entry: AnyRecord, index: number) => ({
        id: `AC-${String(index + 1).padStart(3, "0")}`,
        requirement: text(entry.requirement) || task,
        source: text(entry.source) || "task_text",
        sourceRefs: Array.isArray(entry.sourceRefs) && entry.sourceRefs.length > 0
          ? entry.sourceRefs
          : [{ kind: "task_text", locator: "task:0", sha256: null }],
        predicateId: text(entry.predicateId) || `PRED-${String(index + 1).padStart(3, "0")}`,
        required: true,
        area: text(entry.area) || "core",
        risk,
        verificationMethod: text(entry.verificationMethod) || "static",
        expectedEvidence: text(entry.expectedEvidence) || expectedEvidenceDefault,
        dependsOn: Array.isArray(entry.dependsOn) ? entry.dependsOn : [],
        allowedFiles: Array.isArray(entry.allowedFiles) ? entry.allowedFiles.filter((f: any) => isRepoRelativePosixPath(f)) : [],
      }))
    : classification.classifiedRequirements.map((entry: AnyRecord, index: number) => ({
        id: `AC-${String(index + 1).padStart(3, "0")}`,
        requirement: text(entry.summary || entry.text || task),
        source: entry.kind || "task_text",
        sourceRefs: [{ kind: entry.kind || "task_text", locator: entry.locator, sha256: entry.sha256 || null }],
        predicateId: `PRED-${String(index + 1).padStart(3, "0")}`,
        required: true,
        area: "core",
        risk,
        verificationMethod: "static",
        expectedEvidence: expectedEvidenceDefault,
        dependsOn: [],
        allowedFiles: [],
      }));
  return {
    schemaVersion: 1,
    jobId,
    project,
    source: { task, issue: null, documents: documents.map((doc: AnyRecord) => doc.locator || doc.path).filter(Boolean), requirementClassificationArtifact: classification.artifact || null },
    status: "frozen",
    items,
    assumptions: [],
  };
}

export function validateChecklistVerdict(verdict: AnyRecord, checklist: AnyRecord) {
  const checklistValidation = validateAcceptanceChecklist(checklist);
  if (!checklistValidation.ok) return checklistValidation;
  if (!verdict || typeof verdict !== "object") return fail("verdict must be an object");
  if (verdict.schemaVersion !== 1) return fail("verdict schemaVersion must be 1");
  if (!TOP_STATUSES.has(verdict.status)) return fail("verdict.status must be pass or fail");
  if (!Array.isArray(verdict.items)) return fail("verdict.items must be an array");
  const checklistIds = new Set(checklist.items.map((item: AnyRecord) => item.id));
  const requiredIds = new Set(checklist.items.filter((item: AnyRecord) => item.required).map((item: AnyRecord) => item.id));
  const seen = new Set<string>();
  let allRequiredPassed = true;
  for (const [index, item] of verdict.items.entries()) {
    const prefix = `items[${index}]`;
    const checklistId = text(item?.checklistId);
    if (!checklistId) return fail(`${prefix}.checklistId is required`);
    if (!checklistIds.has(checklistId)) return fail(`${prefix}.checklistId does not exist in checklist: ${checklistId}`);
    if (seen.has(checklistId)) return fail(`duplicate verdict item for checklist id: ${checklistId}`);
    seen.add(checklistId);
    if (!ITEM_RESULTS.has(item.result)) return fail(`${prefix}.result must be pass, fail, or unchecked`);
    if (!Array.isArray(item.evidenceRefs)) return fail(`${prefix}.evidenceRefs must be an array`);
    if (item.result === "pass" && item.evidenceRefs.length === 0) return fail(`${prefix}.pass requires at least one evidence ref`);
    if (requiredIds.has(checklistId) && item.result !== "pass") allRequiredPassed = false;
    if (!text(item.reason)) return fail(`${prefix}.reason is required`);
    if (item.fixScope !== undefined && !Array.isArray(item.fixScope)) return fail(`${prefix}.fixScope must be an array`);
    for (const file of item.fixScope || []) {
      if (isChecklistId(file)) return fail(`${prefix}.fixScope must contain only file paths, not checklist IDs (found ${text(file)})`);
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.fixScope contains invalid repo-relative path`);
    }
  }
  const missingRequired = [...requiredIds].filter((id: string) => !seen.has(id));
  if (missingRequired.length > 0) return fail(`verdict missing required checklist ids: ${missingRequired.join(", ")}`, { missingRequired });
  if (verdict.status === "pass" && !allRequiredPassed) return fail("verdict.status pass requires every required item to pass");
  if (verdict.status === "fail" && allRequiredPassed) return fail("verdict.status fail conflicts with all required items passing");
  if (!Array.isArray(verdict.fixScope)) return fail("verdict.fixScope must be an array");
  for (const [index, entry] of (Array.isArray(verdict.blocking) ? verdict.blocking : []).entries()) {
    if (!checklistIds.has(text(entry?.checklistId))) return fail(`blocking[${index}].checklistId must reference the frozen checklist`);
    if (entry.criterion !== undefined || entry.evidence !== undefined) return fail(`blocking[${index}] must not define criterion/evidence prose; use requirementSnapshot/evidenceIssue`);
  }
  for (const file of verdict.fixScope) {
    if (isChecklistId(file)) return fail(`verdict.fixScope must contain only file paths, not checklist IDs (found ${text(file)})`);
    if (!isRepoRelativePosixPath(file)) return fail("verdict.fixScope contains invalid repo-relative path");
  }
  if (!text(verdict.reason)) return fail("verdict.reason is required");
  return { ok: true as const, reason: "" };
}

function evidenceMatchesChecklistItem(entry: AnyRecord, checklistItem: AnyRecord, context: AnyRecord = {}) {
  const baseMatch = entry?.type === "evidence_claim"
    && text(entry.checklistId) === text(checklistItem.id)
    && text(entry.verificationMethod) === text(checklistItem.verificationMethod)
    && text(entry.predicateId) === text(checklistItem.predicateId)
    && text(entry.result) === "pass";
  if (!baseMatch) return false;
  return validateEvidenceObservation(entry, checklistItem, context).satisfied;
}

function checklistOutcome(outcome: string, reason: string, fields: AnyRecord = {}) {
  return {
    outcome,
    reason,
    failedChecklistIds: [],
    uncheckedChecklistIds: [],
    failedFixScope: [],
    missingEvidenceRefs: [],
    mismatchedEvidenceRefs: [],
    staleEvidenceRefs: [],
    poisonedEvidenceRefs: [],
    runtimeFailureRefs: [],
    attemptId: null,
    unmappedChangedFiles: [],
    ...fields,
  };
}

function normalizeRuntimeFailureRefs(runtimeFailures: unknown, { attemptId, multiAttempt = false }: AnyRecord = {}) {
  const allowed = new Set(["phase_poisoned_session", "poisoned_session", "job_panic", "runjob_panic"]);
  const activeAttemptId = text(attemptId);
  const ambiguous: AnyRecord[] = [];
  const refs = (Array.isArray(runtimeFailures) ? runtimeFailures : [])
    .map((entry: AnyRecord) => {
      const type = text(entry?.type || entry?.kind || entry?.code);
      if (!allowed.has(type)) return null;
      const ref = {
        type,
        attemptId: text(entry.attemptId) || null,
        phase: text(entry.phase) || null,
        nodeId: text(entry.nodeId) || null,
        reason: text(entry.reason) || null,
      };
      if (multiAttempt && !ref.attemptId) ambiguous.push(ref);
      if (activeAttemptId && ref.attemptId && ref.attemptId !== activeAttemptId) return null;
      return ref;
    })
    .filter(Boolean);
  return { refs, ambiguous };
}

export function validateChecklistDagCoverage(workflowDag: AnyRecord, acceptanceChecklist: AnyRecord | null) {
  if (!acceptanceChecklist?.items?.length) return { ok: true as const, outcome: "complete", violations: [], reason: "" };
  const requiredIds = new Set<string>(acceptanceChecklist.items.filter((item: AnyRecord) => item.required).map((item: AnyRecord) => item.id as string));
  const nodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : [];
  const violations: AnyRecord[] = [];

  const executeNodesByCoveredId = new Map<string, AnyRecord[]>();
  for (const node of nodes) {
    if (node.phase === "execute" && Array.isArray(node.checklistIds)) {
      for (const id of node.checklistIds) {
        if (!executeNodesByCoveredId.has(id)) executeNodesByCoveredId.set(id, []);
        executeNodesByCoveredId.get(id)!.push(node);
      }
    }
  }

  for (const node of nodes) {
    const isMutating = node.phase === "execute" || node.phase === "remediate" || node.phase === "verify" || node.phase === "adversarial_verify";
    const isCustomOrSideEffect = node.custom === true || node.sideEffecting === true;
    const hasChecklistIds = Array.isArray(node.checklistIds) && node.checklistIds.length > 0;
    const isNeutral = node.checklistNeutral === true;
    const isCanonical = !isCustomOrSideEffect && (node.phase === "execute" || node.phase === "verify" || node.phase === "adversarial_verify");

    if ((isMutating || isCustomOrSideEffect) && !hasChecklistIds && !isNeutral && !isCanonical) {
      violations.push({
        nodeId: node.id || node.phase,
        phase: node.phase,
        reason: "custom or side-effecting node must have checklistIds or be marked checklistNeutral: true",
      });
    }

    // Verify nodes must depend on execute nodes covering the same required ids
    if (node.phase === "verify" || node.phase === "adversarial_verify") {
      const nodeIds = new Set(Array.isArray(node.checklistIds) ? node.checklistIds : []);
      const deps = new Set(Array.isArray(node.dependsOn) ? node.dependsOn : []);
      for (const requiredId of requiredIds) {
        if (!nodeIds.has(requiredId)) continue;
        const coveringExecuteNodes = executeNodesByCoveredId.get(requiredId) || [];
        const hasDependency = coveringExecuteNodes.some((execNode: AnyRecord) => deps.has(execNode.id || execNode.phase));
        if (!hasDependency && coveringExecuteNodes.length > 0) {
          violations.push({
            nodeId: node.id || node.phase,
            phase: node.phase,
            checklistId: requiredId,
            reason: `verify node must depend on execute node covering ${requiredId}`,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false as const, outcome: "dag_uncovered" as const, violations, reason: `DAG coverage violations: ${violations.map((v: AnyRecord) => v.reason).join("; ")}` };
  }
  return { ok: true as const, outcome: "complete" as const, violations: [], reason: "" };
}

export function computeImpactedChecklistIds({ changedFiles, acceptanceChecklist, previousExecutionMap, lockedPassedChecklistIds }: AnyRecord): string[] {
  if (!acceptanceChecklist?.items?.length) return [];
  const normalizedChanged = normalizeRepoRelativePaths(changedFiles || []);
  if (normalizedChanged.length === 0) return [];
  const lockedSet = new Set<string>(Array.isArray(lockedPassedChecklistIds) ? lockedPassedChecklistIds : []);
  const impacted: string[] = [];
  // Check each locked-passed item: if its allowedFiles overlap with current
  // changed files, it needs fresh evidence
  for (const item of acceptanceChecklist.items) {
    if (!lockedSet.has(item.id)) continue;
    const allowed = Array.isArray(item.allowedFiles) ? item.allowedFiles : [];
    const previousMappedFiles = Array.isArray(previousExecutionMap?.mappings)
      ? previousExecutionMap.mappings
        .filter((m: AnyRecord) => m.checklistId === item.id)
        .flatMap((m: AnyRecord) => Array.isArray(m.changedFiles) ? m.changedFiles : [])
      : [];
    const relevantFiles = [...new Set([...allowed, ...previousMappedFiles])];
    if (relevantFiles.length > 0 && normalizedChanged.some((changed: string) => relevantFiles.includes(changed))) {
      impacted.push(item.id);
    }
  }
  return [...new Set(impacted)].sort();
}

export function evaluateChecklistCompletion({ checklist, verdict, evidenceLedger, executionMap, runtimeFailures, attemptId, multiAttempt }: AnyRecord) {
  const activeAttemptId = text(attemptId || evidenceLedger?.attemptId || checklist?.attemptId);
  const { refs: runtimeFailureRefs, ambiguous } = normalizeRuntimeFailureRefs(runtimeFailures, { attemptId, multiAttempt });
  if (ambiguous.length > 0) {
    return checklistOutcome("runtime_failure_ambiguous", "runtime failure event is missing attempt ownership", { runtimeFailureRefs: ambiguous, attemptId: text(attemptId) || null });
  }
  if (runtimeFailureRefs.length > 0) {
    const hasPanic = runtimeFailureRefs.some((entry: AnyRecord) => entry.type === "job_panic" || entry.type === "runjob_panic");
    return checklistOutcome(hasPanic ? "runjob_panic" : "poisoned_session", "runtime failure event blocks checklist completion", { runtimeFailureRefs, attemptId: text(attemptId) || null });
  }
  const validation = validateChecklistVerdict(verdict, checklist);
  if (!validation.ok) {
    return checklistOutcome("checklist_invalid", "reason" in validation ? validation.reason : "invalid verdict");
  }
  const unmappedChangedFiles = Array.isArray(executionMap?.unmappedChangedFiles) ? executionMap.unmappedChangedFiles : [];
  if (unmappedChangedFiles.length > 0) {
    return checklistOutcome("scope_violation", "execution map contains unmapped changed files", { unmappedChangedFiles });
  }
  const ledgerId = text(evidenceLedger?.ledgerId);
  const finalHead = text(evidenceLedger?.finalWorktree?.head);
  const finalDiffHash = text(evidenceLedger?.finalWorktree?.diffHash);
  const evidenceByKey = new Map<string, AnyRecord>();
  for (const entry of Array.isArray(evidenceLedger?.evidence) ? evidenceLedger.evidence : []) {
    evidenceByKey.set(`${ledgerId}:${text(entry.id)}`, entry);
  }
  const failedChecklistIds: string[] = [];
  const uncheckedChecklistIds: string[] = [];
  const failedFixScope: string[] = [];
  const missingEvidenceRefs: AnyRecord[] = [];
  const mismatchedEvidenceRefs: AnyRecord[] = [];
  const staleEvidenceRefs: AnyRecord[] = [];
  const poisonedEvidenceRefs: AnyRecord[] = [];
  for (const item of verdict.items) {
    const checklistItem = checklist.items.find((entry: AnyRecord) => entry.id === item.checklistId);
    if (!checklistItem?.required) continue;
    if (item.result === "fail") failedChecklistIds.push(item.checklistId);
    if (item.result === "unchecked") uncheckedChecklistIds.push(item.checklistId);
    if (item.result === "fail" || item.result === "unchecked") {
      for (const file of Array.isArray(item.fixScope) ? item.fixScope : []) failedFixScope.push(text(file));
    }
    if (item.result === "pass") {
      for (const ref of item.evidenceRefs) {
        const entry = evidenceByKey.get(evidenceKey(ref));
        if (!entry) {
          missingEvidenceRefs.push(ref);
          continue;
        }
        if (!evidenceMatchesChecklistItem(entry, checklistItem, { attemptId: activeAttemptId })) {
          mismatchedEvidenceRefs.push(ref);
        }
        if (text(entry.worktreeHead) !== finalHead || text(entry.diffHash) !== finalDiffHash) {
          staleEvidenceRefs.push(ref);
        }
        if (entry.poisonedSession === true) {
          poisonedEvidenceRefs.push(ref);
        }
      }
    }
  }
  const common = { failedChecklistIds, uncheckedChecklistIds, failedFixScope: [...new Set(failedFixScope)].sort(), missingEvidenceRefs, mismatchedEvidenceRefs, staleEvidenceRefs, poisonedEvidenceRefs, unmappedChangedFiles };
  if (poisonedEvidenceRefs.length > 0) return checklistOutcome("poisoned_session", "pass verdict references poisoned-session evidence", common);
  if (failedChecklistIds.length > 0) return checklistOutcome("checklist_failed", "required checklist items failed", common);
  if (uncheckedChecklistIds.length > 0) return checklistOutcome("checklist_incomplete", "required checklist items were not checked", common);
  if (missingEvidenceRefs.length > 0) return checklistOutcome("evidence_missing", "pass verdict references missing evidence", common);
  if (mismatchedEvidenceRefs.length > 0) return checklistOutcome("evidence_mismatch", "pass verdict references evidence that does not prove the checklist item", common);
  if (staleEvidenceRefs.length > 0) return checklistOutcome("evidence_stale", "pass verdict references stale evidence", common);
  return checklistOutcome("complete", "all required checklist items passed with fresh evidence", common);
}
