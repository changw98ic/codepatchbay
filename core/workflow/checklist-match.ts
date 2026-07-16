import { validateEvidenceObservation } from "./evidence-probes.js";
import { normalizeRepoRelativePaths } from "../engine/scope-guard.js";
import {
  type AcceptanceChecklist,
  type ChecklistItem,
  type ChecklistVerdict,
  type ChecklistVerdictItem,
  type RuntimeFailureRef,
  type SourceRef,
  evidenceKey,
  isRepoRelativePosixPath,
  recordArray,
  recordValue,
  text,
} from "./checklist-shared.js";
import { validateChecklistVerdict } from "./checklist-validate.js";
import type { LooseRecord } from "../contracts/types.js";

function evidenceMatchesChecklistItem(entry: LooseRecord, checklistItem: ChecklistItem, context: LooseRecord = {}) {
  const baseMatch = entry?.type === "evidence_claim"
    && text(entry.checklistId) === text(checklistItem.id)
    && text(entry.verificationMethod) === text(checklistItem.verificationMethod)
    && text(entry.predicateId) === text(checklistItem.predicateId)
    && text(entry.result) === "pass";
  if (!baseMatch) return false;
  if (!evidenceMetadataMatchesChecklistItem(entry, checklistItem)) return false;
  return validateEvidenceObservation(entry, checklistItem, context).satisfied;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function evidenceMetadataMatchesChecklistItem(entry: LooseRecord, checklistItem: ChecklistItem) {
  const requiredClasses = stringList(checklistItem.requiredEvidenceClass);
  if (requiredClasses.length > 0 && !requiredClasses.includes(text(entry.evidenceClass))) return false;

  const requiredOrigins = stringList(checklistItem.requiredEvidenceOrigin);
  const entryOrigin = text(entry.evidenceOrigin || entry.origin);
  if (requiredOrigins.length > 0 && !requiredOrigins.includes(entryOrigin)) return false;

  if (checklistItem.requiresRealPathEvidence === true) {
    if (entry.coversRealPath !== true) return false;
    if (entry.coversOnlyMinimalRepro === true) return false;
  }

  return true;
}

const ORACLE_PROTECTED_ORIGINS = new Set([
  "benchmark_required",
  "user_required",
  "external_oracle",
  "user_acceptance",
  "user_provided",
  "ci_required",
  "ci_owned",
  "ci",
]);

const CLEAN_ORACLE_FLAGS = [
  "externalOracleSatisfied",
  "cleanOracleReplayPassed",
  "oracleOverlayPassed",
  "officialScorerResolved",
  "scorerResolved",
  "externalScorerResolved",
];

const ORACLE_PATH_FIELDS = [
  "oracleFiles",
  "protectedFiles",
  "acceptanceFiles",
  "externalOracleFiles",
  "userAcceptanceFiles",
  "ciFiles",
  "commandFiles",
];

function pathMatchesScope(filePath: string, scopePath: string) {
  const file = filePath.split("\\").join("/");
  const scope = scopePath.split("\\").join("/");
  if (!file || !scope) return false;
  if (scope.startsWith("**/")) {
    const suffix = scope.slice(3);
    return file.startsWith(suffix) || file.includes(`/${suffix}`);
  }
  if (scope.endsWith("/")) return file.startsWith(scope);
  return file === scope || file.startsWith(`${scope}/`);
}

function cleanPathToken(value: unknown) {
  let candidate = text(value)
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^[([{]+|[)\]},;]+$/g, "");
  if (!candidate) return "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate)) return "";
  if (/^[A-Za-z_][\w.-]*:\d+$/.test(candidate) && !candidate.includes("/")) return "";
  if (candidate.includes("=")) candidate = candidate.slice(candidate.lastIndexOf("=") + 1);
  candidate = candidate.replace(/^\.\/+/, "");
  candidate = candidate.replace(/:\d+(?::\d+)?$/, "");
  if (!candidate || !isRepoRelativePosixPath(candidate)) return "";
  return candidate;
}

function collectPathField(value: unknown, paths: Set<string>) {
  if (Array.isArray(value)) {
    for (const entry of value) collectPathField(entry, paths);
    return;
  }
  const path = cleanPathToken(value);
  if (path) paths.add(path);
}

function collectPathTokens(value: unknown, paths: Set<string>) {
  const raw = text(value);
  if (!raw) return;
  for (const token of raw.split(/[\s'"`]+/)) {
    const path = cleanPathToken(token);
    if (!path) continue;
    if (path.includes("/") || /\.[A-Za-z0-9]+$/.test(path)) paths.add(path);
  }
}

function collectSourceRefPaths(value: unknown, paths: Set<string>) {
  for (const ref of recordArray(value)) {
    const kind = text(ref.kind);
    const locator = text(ref.locator);
    if (kind === "task_text" || locator.startsWith("task:")) continue;
    collectPathField(ref.path || ref.file || ref.locator, paths);
  }
}

function oracleProtectedPaths(entry: LooseRecord, checklistItem: ChecklistItem) {
  const paths = new Set<string>();
  for (const field of ORACLE_PATH_FIELDS) {
    collectPathField(checklistItem[field], paths);
    collectPathField(entry[field], paths);
  }
  collectSourceRefPaths(checklistItem.sourceRefs, paths);
  collectSourceRefPaths(entry.sourceRefs, paths);
  collectPathTokens(checklistItem.expectedEvidence, paths);
  collectPathTokens(entry.command, paths);
  collectPathTokens(entry.displayCommand, paths);
  return [...paths].sort();
}

function requiresCleanOracleProvenance(entry: LooseRecord, checklistItem: ChecklistItem) {
  const origins = [
    ...stringList(checklistItem.requiredEvidenceOrigin),
    text(checklistItem.evidenceOrigin),
    text(entry.evidenceOrigin || entry.origin),
  ].filter(Boolean);
  return origins.some((origin) => ORACLE_PROTECTED_ORIGINS.has(origin));
}

function hasCleanOracleReplay(entry: LooseRecord) {
  return CLEAN_ORACLE_FLAGS.some((field) => entry[field] === true);
}

function executionChangedFiles(executionMap: LooseRecord | null | undefined) {
  const direct = Array.isArray(executionMap?.changedFiles) ? executionMap.changedFiles : [];
  if (direct.length > 0) return normalizeRepoRelativePaths(direct);
  const mapped = recordArray(executionMap?.mappings).flatMap((entry) => (
    Array.isArray(entry.changedFiles) ? entry.changedFiles : []
  ));
  return normalizeRepoRelativePaths(mapped);
}

function pollutedOracleFilesForEvidence(entry: LooseRecord, checklistItem: ChecklistItem, changedFiles: string[]) {
  if (!requiresCleanOracleProvenance(entry, checklistItem)) return [];
  if (hasCleanOracleReplay(entry)) return [];
  const protectedPaths = oracleProtectedPaths(entry, checklistItem);
  if (protectedPaths.length === 0 || changedFiles.length === 0) return [];
  return changedFiles
    .filter((changedFile) => protectedPaths.some((scope) => pathMatchesScope(changedFile, scope)))
    .sort();
}

function checklistOutcome(outcome: string, reason: string, fields: LooseRecord = {}) {
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
    pollutedEvidenceRefs: [],
    pollutedOracleFiles: [],
    runtimeFailureRefs: [],
    attemptId: null,
    unmappedChangedFiles: [],
    evidenceMissingCause: null as string | null,
    ...fields,
  };
}

function evidenceRecoveryCause(
  checklistIds: string[],
  checklistItems: ChecklistItem[],
  evidenceEntries: LooseRecord[],
  attemptId: string,
) {
  const ids = new Set(checklistIds.filter(Boolean));
  const items = checklistItems.filter((item) => ids.has(text(item.id)));
  if (items.some((item) => text(item.verificationMethod) === "manual")) {
    return "manual_approval_missing";
  }

  for (const item of items) {
    if (evidenceEntries.some((entry) => (
      text(entry.checklistId) === text(item.id)
      && evidenceMatchesChecklistItem(entry, item, { attemptId })
    ))) {
      return "probe_available_not_run";
    }
  }

  const relevantEvidence = evidenceEntries.filter((entry) => ids.has(text(entry.checklistId)));
  const missingProbeDefinition = relevantEvidence.length === 0 || relevantEvidence.some((entry) => {
    const note = text(entry.note).toLowerCase();
    return note.includes("no trusted structured probe")
      || note.includes("no deterministic probe")
      || note.includes("unsupported verificationmethod");
  });
  if (missingProbeDefinition) return "probe_definition_missing";
  return "implementation_gap";
}

function normalizeRuntimeFailureRefs(runtimeFailures: unknown, { attemptId, multiAttempt = false }: { attemptId?: unknown; multiAttempt?: boolean } = {}) {
  const allowed = new Set(["phase_poisoned_session", "poisoned_session", "job_panic", "runjob_panic"]);
  const activeAttemptId = text(attemptId);
  const ambiguous: RuntimeFailureRef[] = [];
  const refs = (Array.isArray(runtimeFailures) ? runtimeFailures : [])
    .map((entry: LooseRecord) => {
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
    .filter((entry): entry is {
      type: string;
      attemptId: string | null;
      phase: string | null;
      nodeId: string | null;
      reason: string | null;
    } => Boolean(entry));
  return { refs, ambiguous };
}

export function computeImpactedChecklistIds({ changedFiles, acceptanceChecklist, previousExecutionMap, lockedPassedChecklistIds }: {
  changedFiles?: unknown;
  acceptanceChecklist?: AcceptanceChecklist | null;
  previousExecutionMap?: LooseRecord | null;
  lockedPassedChecklistIds?: unknown;
}): string[] {
  if (!acceptanceChecklist?.items?.length) return [];
  const normalizedChanged = normalizeRepoRelativePaths(changedFiles || []);
  if (normalizedChanged.length === 0) return [];
  const lockedSet = new Set<string>(Array.isArray(lockedPassedChecklistIds) ? lockedPassedChecklistIds : []);
  const impacted: string[] = [];
  // Check each locked-passed item: if its allowedFiles overlap with current
  // changed files, it needs fresh evidence
  for (const item of acceptanceChecklist.items) {
    const itemId = text(item.id);
    if (!lockedSet.has(itemId)) continue;
    const allowed = Array.isArray(item.allowedFiles) ? item.allowedFiles : [];
    const previousMappedFiles = Array.isArray(previousExecutionMap?.mappings)
      ? previousExecutionMap.mappings
        .filter((m: LooseRecord) => text(m.checklistId) === itemId)
        .flatMap((m: LooseRecord) => Array.isArray(m.changedFiles) ? m.changedFiles : [])
      : [];
    const relevantFiles = [...new Set([...allowed, ...previousMappedFiles])];
    if (relevantFiles.length > 0 && normalizedChanged.some((changed: string) => relevantFiles.includes(changed))) {
      impacted.push(itemId);
    }
  }
  return [...new Set(impacted)].sort();
}

export function evaluateChecklistCompletion({ checklist, verdict, evidenceLedger, executionMap, runtimeFailures, attemptId, multiAttempt }: {
  checklist: unknown;
  verdict: unknown;
  evidenceLedger?: LooseRecord | null;
  executionMap?: LooseRecord | null;
  runtimeFailures?: unknown;
  attemptId?: unknown;
  multiAttempt?: boolean;
}) {
  const checklistRecord: AcceptanceChecklist = recordValue(checklist);
  const verdictRecord: ChecklistVerdict = recordValue(verdict);
  const evidenceLedgerRecord = recordValue(evidenceLedger);
  const finalWorktree = recordValue(evidenceLedgerRecord.finalWorktree);
  const activeAttemptId = text(attemptId || evidenceLedgerRecord.attemptId || checklistRecord.attemptId);
  const { refs: runtimeFailureRefs, ambiguous } = normalizeRuntimeFailureRefs(runtimeFailures, { attemptId, multiAttempt });
  if (ambiguous.length > 0) {
    return checklistOutcome("runtime_failure_ambiguous", "runtime failure event is missing attempt ownership", { runtimeFailureRefs: ambiguous, attemptId: text(attemptId) || null });
  }
  if (runtimeFailureRefs.length > 0) {
    const hasPanic = runtimeFailureRefs.some((entry: RuntimeFailureRef) => entry.type === "job_panic" || entry.type === "runjob_panic");
    return checklistOutcome(hasPanic ? "runjob_panic" : "poisoned_session", "runtime failure event blocks checklist completion", { runtimeFailureRefs, attemptId: text(attemptId) || null });
  }
  // validateChecklistVerdict (called above) already proved both items arrays are
  // non-empty; bind typed locals the same way checklist-validate.ts does, without a cast.
  const validation = validateChecklistVerdict(verdictRecord, checklistRecord);
  if (!validation.ok) {
    return checklistOutcome("checklist_invalid", "reason" in validation ? validation.reason : "invalid verdict");
  }
  const checkedItems: ChecklistItem[] = Array.isArray(checklistRecord.items) ? checklistRecord.items : [];
  const checkedVerdictItems: ChecklistVerdictItem[] = Array.isArray(verdictRecord.items) ? verdictRecord.items : [];
  const ledgerId = text(evidenceLedgerRecord.ledgerId);
  const finalHead = text(finalWorktree.head);
  const finalDiffHash = text(finalWorktree.diffHash);
  const changedFiles = executionChangedFiles(executionMap);
  const evidenceByKey = new Map<string, LooseRecord>();
  for (const entry of recordArray(evidenceLedgerRecord.evidence)) {
    evidenceByKey.set(`${ledgerId}:${text(entry.id)}`, entry);
  }
  const evidenceCoveredFiles = new Set<string>();
  for (const entry of recordArray(evidenceLedgerRecord.evidence)) {
    const checklistItem = checkedItems.find((item: ChecklistItem) => text(item.id) === text(entry.checklistId));
    if (!checklistItem) continue;
    if (!evidenceMatchesChecklistItem(entry, checklistItem, { attemptId: activeAttemptId })) continue;
    for (const file of normalizeRepoRelativePaths(entry.changedFilesInScope || [])) {
      evidenceCoveredFiles.add(file);
    }
  }
  const unmappedChangedFiles = normalizeRepoRelativePaths(
    Array.isArray(executionMap?.unmappedChangedFiles) ? executionMap.unmappedChangedFiles : [],
  ).filter((file) => !evidenceCoveredFiles.has(file));
  if (unmappedChangedFiles.length > 0) {
    return checklistOutcome("scope_violation", "execution map contains unmapped changed files", { unmappedChangedFiles });
  }
  const failedChecklistIds: string[] = [];
  const uncheckedChecklistIds: string[] = [];
  const failedFixScope: string[] = [];
  const missingEvidenceRefs: SourceRef[] = [];
  const mismatchedEvidenceRefs: SourceRef[] = [];
  const staleEvidenceRefs: SourceRef[] = [];
  const poisonedEvidenceRefs: SourceRef[] = [];
  const pollutedEvidenceRefs: SourceRef[] = [];
  const pollutedOracleFiles: string[] = [];
  for (const item of checkedVerdictItems) {
    const checklistItem = checkedItems.find((entry: ChecklistItem) => text(entry.id) === text(item.checklistId));
    if (!checklistItem?.required) continue;
    const checklistId = text(item.checklistId);
    if (item.result === "fail") failedChecklistIds.push(checklistId);
    if (item.result === "unchecked") uncheckedChecklistIds.push(checklistId);
    if (item.result === "fail" || item.result === "unchecked") {
      const explicitFixScope = Array.isArray(item.fixScope) ? item.fixScope.map(text).filter(Boolean) : [];
      const derivedFixScope = explicitFixScope.length > 0
        ? explicitFixScope
        : normalizeRepoRelativePaths(Array.isArray(checklistItem?.allowedFiles) ? checklistItem.allowedFiles : []);
      for (const file of derivedFixScope) failedFixScope.push(file);
    }
    if (item.result === "pass") {
      for (const ref of item.evidenceRefs || []) {
        const entry = evidenceByKey.get(evidenceKey(ref));
        if (!entry) {
          missingEvidenceRefs.push(ref);
          continue;
        }
        const matchesChecklist = evidenceMatchesChecklistItem(entry, checklistItem, { attemptId: activeAttemptId });
        if (!matchesChecklist) {
          mismatchedEvidenceRefs.push(ref);
        }
        const pollutedFiles = matchesChecklist ? pollutedOracleFilesForEvidence(entry, checklistItem, changedFiles) : [];
        if (pollutedFiles.length > 0) {
          pollutedEvidenceRefs.push(ref);
          for (const file of pollutedFiles) pollutedOracleFiles.push(file);
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
  const common = {
    failedChecklistIds,
    uncheckedChecklistIds,
    failedFixScope: [...new Set(failedFixScope)].sort(),
    missingEvidenceRefs,
    mismatchedEvidenceRefs,
    staleEvidenceRefs,
    poisonedEvidenceRefs,
    pollutedEvidenceRefs,
    pollutedOracleFiles: [...new Set(pollutedOracleFiles)].sort(),
    unmappedChangedFiles,
  };
  if (poisonedEvidenceRefs.length > 0) return checklistOutcome("poisoned_session", "pass verdict references poisoned-session evidence", common);
  if (pollutedEvidenceRefs.length > 0) return checklistOutcome("oracle_polluted", "pass verdict references external oracle evidence from executor-modified files", common);
  if (failedChecklistIds.length > 0) return checklistOutcome("checklist_failed", "required checklist items failed", common);
  if (uncheckedChecklistIds.length > 0) {
    return checklistOutcome("checklist_incomplete", "required checklist items were not checked", {
      ...common,
      evidenceMissingCause: evidenceRecoveryCause(uncheckedChecklistIds, checkedItems, recordArray(evidenceLedgerRecord.evidence), activeAttemptId),
    });
  }
  if (missingEvidenceRefs.length > 0) {
    const missingChecklistIds = checkedVerdictItems
      .filter((item) => (item.evidenceRefs || []).some((ref) => missingEvidenceRefs.some((missing) => evidenceKey(missing) === evidenceKey(ref))))
      .map((item) => text(item.checklistId))
      .filter(Boolean);
    return checklistOutcome("evidence_missing", "pass verdict references missing evidence", {
      ...common,
      evidenceMissingCause: evidenceRecoveryCause(missingChecklistIds, checkedItems, recordArray(evidenceLedgerRecord.evidence), activeAttemptId),
    });
  }
  if (mismatchedEvidenceRefs.length > 0) return checklistOutcome("evidence_mismatch", "pass verdict references evidence that does not prove the checklist item", common);
  if (staleEvidenceRefs.length > 0) return checklistOutcome("evidence_stale", "pass verdict references stale evidence", common);
  return checklistOutcome("complete", "all required checklist items passed with fresh evidence", common);
}
