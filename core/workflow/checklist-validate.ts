import {
  type AcceptanceChecklist,
  type ChecklistItem,
  type ChecklistVerdict,
  type ClassifiedRequirement,
  type DocumentInput,
  type RequirementClassification,
  type SourceRef,
  type WorkflowDagInput,
  type WorkflowDagNode,
  RISK_VALUES,
  VERIFICATION_METHODS,
  ITEM_RESULTS,
  TOP_STATUSES,
  fail,
  isRecord,
  recordValue,
  isRepoRelativePosixPath,
  isChecklistId,
  recordArray,
  text,
} from "./checklist-shared.js";
import type { LooseRecord } from "../contracts/types.js";
import { extractTaskRequirementSlices } from "./checklist-build.js";
import { observableContractSha256, validateObservableContract } from "./observable-contract.js";

export function validateAcceptanceChecklist(checklist: unknown) {
  if (!isRecord(checklist)) return fail("checklist must be an object");
  const checklistRecord: AcceptanceChecklist = checklist;
  if (checklistRecord.schemaVersion !== 1) return fail("schemaVersion must be 1");
  if (!text(checklistRecord.jobId)) return fail("jobId is required");
  if (!text(checklistRecord.project)) return fail("project is required");
  if (checklistRecord.status !== "frozen") return fail("checklist status must be frozen");
  if (!Array.isArray(checklistRecord.items) || checklistRecord.items.length === 0) return fail("items must be a non-empty array");
  for (const [index, assumption] of recordArray<LooseRecord & { risk?: unknown; acceptedForExecution?: unknown; text?: unknown }>(checklistRecord.assumptions).entries()) {
    if (assumption?.risk === "high" && assumption.acceptedForExecution === true) {
      return fail(`assumptions[${index}] high-risk assumption cannot be silently accepted`);
    }
    if (/\b(must|should|required|remain unchanged|non-regression)\b/i.test(text(assumption?.text))) {
      return fail(`assumptions[${index}] appears to contain an acceptance requirement`);
    }
  }
  const ids = new Set<string>();
  for (const [index, item] of checklistRecord.items.entries()) {
    const prefix = `items[${index}]`;
    if (!text(item?.id)) return fail(`${prefix}.id is required`);
    const itemId = text(item.id);
    if (ids.has(itemId)) return fail(`duplicate checklist id: ${itemId}`);
    ids.add(itemId);
    if (!text(item.requirement)) return fail(`${prefix}.requirement is required`);
    if (!text(item.source)) return fail(`${prefix}.source is required`);
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length === 0) return fail(`${prefix}.sourceRefs is required`);
    if (!text(item.predicateId)) return fail(`${prefix}.predicateId is required`);
    if (typeof item.required !== "boolean") return fail(`${prefix}.required must be boolean`);
    if (!text(item.area)) return fail(`${prefix}.area is required`);
    if (!RISK_VALUES.has(text(item.risk))) return fail(`${prefix}.risk must be low, medium, or high`);
    if (!VERIFICATION_METHODS.has(text(item.verificationMethod))) return fail(`${prefix}.verificationMethod is invalid`);
    if (item.requiresRealPathEvidence === true && text(item.verificationMethod) === "static") {
      return fail(`${prefix}.requiresRealPathEvidence cannot be satisfied by static diff-scope evidence`);
    }
    if (item.requiresRealPathEvidence === true && text(item.evidenceOrigin) === "agent_written") {
      return fail(`${prefix}.requiresRealPathEvidence cannot be satisfied by agent_written evidence`);
    }
    if (!text(item.expectedEvidence)) return fail(`${prefix}.expectedEvidence is required`);
    if (item.observableContract !== undefined) {
      const contractValidation = validateObservableContract(item.observableContract, `${prefix}.observableContract`);
      if (!contractValidation.ok) return fail(contractValidation.reason);
      const contract = recordValue(item.observableContract);
      if (contract.frozenBeforeExecution !== true) return fail(`${prefix}.observableContract must be frozen before execution`);
      if (!text(contract.contractId)) return fail(`${prefix}.observableContract.contractId is required`);
      if (!/^sha256:[a-f0-9]{64}$/.test(text(contract.contractSha256))) {
        return fail(`${prefix}.observableContract.contractSha256 is invalid`);
      }
      if (text(contract.contractSha256) !== observableContractSha256(contract)) {
        return fail(`${prefix}.observableContract.contractSha256 does not match the frozen contract`);
      }
    }
    if (item.dependsOn !== undefined && !Array.isArray(item.dependsOn)) return fail(`${prefix}.dependsOn must be an array`);
    const allowedFiles = Array.isArray(item.allowedFiles) ? item.allowedFiles : [];
    if (item.allowedFiles !== undefined && !Array.isArray(item.allowedFiles)) return fail(`${prefix}.allowedFiles must be an array`);
    for (const file of allowedFiles) {
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
export function validateDecomposedItems(items: unknown) {
  if (!Array.isArray(items) || items.length === 0) return fail("decomposedItems must be a non-empty array");
  const predicateIds = new Set<string>();
  for (const [index, entry] of items.entries()) {
    const prefix = `decomposedItems[${index}]`;
    if (!text(entry?.requirement)) return fail(`${prefix}.requirement is required`);
    const predicateId = text(entry?.predicateId);
    if (!predicateId) return fail(`${prefix}.predicateId is required`);
    if (predicateIds.has(predicateId)) return fail(`${prefix}.predicateId duplicate: ${predicateId}`);
    predicateIds.add(predicateId);
    if (!VERIFICATION_METHODS.has(text(entry.verificationMethod))) return fail(`${prefix}.verificationMethod is invalid`);
    if (entry.requiresRealPathEvidence === true && text(entry.verificationMethod) === "static") {
      return fail(`${prefix}.requiresRealPathEvidence cannot be satisfied by static diff-scope evidence`);
    }
    if (entry.requiresRealPathEvidence === true && text(entry.evidenceOrigin) === "agent_written") {
      return fail(`${prefix}.requiresRealPathEvidence cannot be satisfied by agent_written evidence`);
    }
    const allowedFiles = Array.isArray(entry?.allowedFiles) ? entry.allowedFiles : [];
    if (allowedFiles.length === 0) return fail(`${prefix}.allowedFiles must be non-empty (decomposition must declare scope)`);
    for (const file of allowedFiles) {
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.allowedFiles contains invalid repo-relative path`);
    }
    if (entry.sourceRefs !== undefined && !Array.isArray(entry.sourceRefs)) return fail(`${prefix}.sourceRefs must be an array`);
    if (entry.observableContract !== undefined) {
      const contractValidation = validateObservableContract(entry.observableContract, `${prefix}.observableContract`);
      if (!contractValidation.ok) return fail(contractValidation.reason);
    }
  }
  return { ok: true as const, reason: "" };
}

const REPO_LOCAL_SOURCE_REF_KINDS = new Set(["document", "file", "repo", "repo_file", "repository", "repository_path", "code"]);

function stripSourceLocatorLineSuffix(locator: string) {
  const hashLine = locator.match(/^(.+)#L\d+(?:-L\d+)?$/);
  if (hashLine) return hashLine[1];
  const colonLine = locator.match(/^(.+?):\d+(?:-\d+)?(?::\d+)?$/);
  if (colonLine) return colonLine[1];
  return locator;
}

function repoLocalSourcePath(ref: SourceRef) {
  const kind = text(ref.kind);
  if (!REPO_LOCAL_SOURCE_REF_KINDS.has(kind)) return "";
  const locator = stripSourceLocatorLineSuffix(text(ref.locator));
  return isRepoRelativePosixPath(locator) ? locator : "";
}

function allowedFileCoversSource(allowedFile: string, sourcePath: string) {
  if (allowedFile === sourcePath) return true;
  return allowedFile.endsWith("/") && sourcePath.startsWith(allowedFile);
}

function sourceRefCoveredByItemScope(item: ChecklistItem, ref: SourceRef) {
  const sourcePath = repoLocalSourcePath(ref);
  if (!sourcePath) return false;
  const allowedFiles = Array.isArray(item.allowedFiles) ? item.allowedFiles.map((entry) => text(entry)).filter(Boolean) : [];
  return allowedFiles.some((allowedFile) => allowedFileCoversSource(allowedFile, sourcePath));
}

export function validateChecklistSourceCoverage({ checklist, task, documents = [], requirementClassification, evidenceLocators = [] }: {
  checklist: AcceptanceChecklist;
  task?: unknown;
  documents?: DocumentInput[];
  requirementClassification?: RequirementClassification;
  evidenceLocators?: string[];
}) {
  const validation = validateAcceptanceChecklist(checklist);
  if (!validation.ok) return validation;
  // validateAcceptanceChecklist already proved items is a non-empty array; bind a typed, non-null local.
  const items: ChecklistItem[] = Array.isArray(checklist.items) ? checklist.items : [];
  const corpus = [
    ...extractTaskRequirementSlices(task),
    ...documents.map((doc: DocumentInput, index: number) => ({ kind: doc.kind || "document", locator: doc.locator || `document:${index}`, text: text(doc.text || doc.content) })),
  ].filter((entry) => entry.text);
  const sourceKeys = new Set(corpus.map((entry) => `${entry.kind}:${entry.locator}`));
  const frozenEvidenceLocators = new Set(evidenceLocators.map((entry) => text(entry)).filter(Boolean));
  for (const item of items) {
    for (const ref of item.sourceRefs || []) {
      const sourceKey = `${text(ref.kind)}:${text(ref.locator)}`;
      if (
        !sourceKeys.has(sourceKey)
        && !frozenEvidenceLocators.has(text(ref.locator))
        && !sourceRefCoveredByItemScope(item, ref)
      ) {
        return fail(`missing checklist source ref: ${sourceKey}`);
      }
    }
  }
  const requiredSources = (Array.isArray(requirementClassification?.classifiedRequirements)
    ? requirementClassification.classifiedRequirements
    : [])
    .filter((entry: ClassifiedRequirement) => entry.acceptanceRelevant === true)
    .map((entry: ClassifiedRequirement) => text(entry.locator))
    .filter(Boolean);
  for (const required of requiredSources) {
    if (!items.some((item: ChecklistItem) => (item.sourceRefs || []).some((ref: SourceRef) => text(ref.locator) === required))) {
      return fail(`acceptance-relevant source not covered: ${required}`);
    }
  }
  return { ok: true as const, reason: "" };
}

export function validateChecklistVerdict(verdict: unknown, checklist: unknown) {
  const checklistValidation = validateAcceptanceChecklist(checklist);
  if (!checklistValidation.ok) return checklistValidation;
  if (!isRecord(verdict)) return fail("verdict must be an object");
  const verdictRecord: ChecklistVerdict = verdict;
  // validateAcceptanceChecklist already proved checklist is a record with a non-empty items array.
  // isRecord here is a no-op narrowing guard (guaranteed true post-validation), kept to satisfy the type system without a cast.
  const checklistItems: ChecklistItem[] = isRecord(checklist) && Array.isArray(checklist.items) ? checklist.items : [];
  if (verdictRecord.schemaVersion !== 1) return fail("verdict schemaVersion must be 1");
  if (!TOP_STATUSES.has(text(verdictRecord.status))) return fail("verdict.status must be pass or fail");
  if (!Array.isArray(verdictRecord.items)) return fail("verdict.items must be an array");
  const checklistIds = new Set<string>(checklistItems.map((item: ChecklistItem) => text(item.id)));
  const requiredIds = new Set<string>(checklistItems.filter((item: ChecklistItem) => item.required).map((item: ChecklistItem) => text(item.id)));
  const seen = new Set<string>();
  let allRequiredPassed = true;
  for (const [index, item] of verdictRecord.items.entries()) {
    const prefix = `items[${index}]`;
    const checklistId = text(item?.checklistId);
    if (!checklistId) return fail(`${prefix}.checklistId is required`);
    if (!checklistIds.has(checklistId)) return fail(`${prefix}.checklistId does not exist in checklist: ${checklistId}`);
    if (seen.has(checklistId)) return fail(`duplicate verdict item for checklist id: ${checklistId}`);
    seen.add(checklistId);
    if (!ITEM_RESULTS.has(text(item.result))) return fail(`${prefix}.result must be pass, fail, or unchecked`);
    if (!Array.isArray(item.evidenceRefs)) return fail(`${prefix}.evidenceRefs must be an array`);
    if (item.result === "pass" && item.evidenceRefs.length === 0) return fail(`${prefix}.pass requires at least one evidence ref`);
    if (requiredIds.has(checklistId) && item.result !== "pass") allRequiredPassed = false;
    if (!text(item.reason)) return fail(`${prefix}.reason is required`);
    const itemFixScope = Array.isArray(item.fixScope) ? item.fixScope : [];
    if (item.fixScope !== undefined && !Array.isArray(item.fixScope)) return fail(`${prefix}.fixScope must be an array`);
    for (const file of itemFixScope) {
      if (isChecklistId(file)) return fail(`${prefix}.fixScope must contain only file paths, not checklist IDs (found ${text(file)})`);
      if (!isRepoRelativePosixPath(file)) return fail(`${prefix}.fixScope contains invalid repo-relative path`);
    }
  }
  const missingRequired = [...requiredIds].filter((id: string) => !seen.has(id));
  if (missingRequired.length > 0) return fail(`verdict missing required checklist ids: ${missingRequired.join(", ")}`, { missingRequired });
  if (verdictRecord.status === "pass" && !allRequiredPassed) return fail("verdict.status pass requires every required item to pass");
  if (verdictRecord.status === "fail" && allRequiredPassed) return fail("verdict.status fail conflicts with all required items passing");
  if (!Array.isArray(verdictRecord.fixScope)) return fail("verdict.fixScope must be an array");
  for (const [index, entry] of recordArray<LooseRecord & { checklistId?: unknown; criterion?: unknown; evidence?: unknown }>(verdictRecord.blocking).entries()) {
    if (!checklistIds.has(text(entry?.checklistId))) return fail(`blocking[${index}].checklistId must reference the frozen checklist`);
    if (entry.criterion !== undefined || entry.evidence !== undefined) return fail(`blocking[${index}] must not define criterion/evidence prose; use requirementSnapshot/evidenceIssue`);
  }
  for (const file of verdictRecord.fixScope) {
    if (isChecklistId(file)) return fail(`verdict.fixScope must contain only file paths, not checklist IDs (found ${text(file)})`);
    if (!isRepoRelativePosixPath(file)) return fail("verdict.fixScope contains invalid repo-relative path");
  }
  if (!text(verdictRecord.reason)) return fail("verdict.reason is required");
  return { ok: true as const, reason: "" };
}

export function validateChecklistDagCoverage(workflowDag: WorkflowDagInput, acceptanceChecklist: AcceptanceChecklist | null) {
  if (!acceptanceChecklist?.items?.length) return { ok: true as const, outcome: "complete", violations: [], reason: "" };
  const requiredIds = new Set<string>(acceptanceChecklist.items.filter((item: ChecklistItem) => item.required).map((item: ChecklistItem) => text(item.id)));
  const nodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : [];
  const violations: LooseRecord[] = [];
  const nodeById = new Map<string, WorkflowDagNode>();
  for (const node of nodes) {
    const nodeId = text(node.id) || text(node.phase);
    if (nodeId) nodeById.set(nodeId, node);
  }

  function dependsOnNode(start: WorkflowDagNode, targetIds: Set<string>, seen = new Set<string>()): boolean {
    const deps = Array.isArray(start.dependsOn) ? start.dependsOn.map((dep) => text(dep)).filter(Boolean) : [];
    for (const depId of deps) {
      if (targetIds.has(depId)) return true;
      if (seen.has(depId)) continue;
      seen.add(depId);
      const depNode = nodeById.get(depId);
      if (depNode && dependsOnNode(depNode, targetIds, seen)) return true;
    }
    return false;
  }

  const executeNodesByCoveredId = new Map<string, WorkflowDagNode[]>();
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
        const targetIds = new Set(coveringExecuteNodes.map((execNode: WorkflowDagNode) => text(execNode.id) || text(execNode.phase)).filter(Boolean));
        const hasDependency = targetIds.size > 0 && (
          [...targetIds].some((targetId) => deps.has(targetId))
          || dependsOnNode(node, targetIds)
        );
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
    return { ok: false as const, outcome: "dag_uncovered" as const, violations, reason: `DAG coverage violations: ${violations.map((v: LooseRecord) => v.reason).join("; ")}` };
  }
  return { ok: true as const, outcome: "complete" as const, violations: [], reason: "" };
}
