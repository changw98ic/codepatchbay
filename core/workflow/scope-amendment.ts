import { createHash } from "node:crypto";

import { isPhasePassed } from "../contracts/phase-result.js";
import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";
import { normalizeRepoRelativePaths } from "./acceptance-checklist.js";

export type ScopeReviewRequest = LooseRecord & {
  schemaVersion: 1;
  requestHash: string;
  candidateId: string;
  unmappedFiles: string[];
  checklistItems: LooseRecord[];
};

export type ScopeReviewValidation = LooseRecord & {
  required: boolean;
  ok: boolean;
  reason: string;
  decision?: "approve" | "deny";
  canonicalMappings?: Array<{ file: string; checklistIds: string[] }>;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function records(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))].sort()
    : [];
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function safeNormalizePaths(value: unknown[]): string[] | null {
  try {
    return normalizeRepoRelativePaths(value);
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function canonicalMappings(value: unknown) {
  return records(value)
    .map((entry) => ({
      file: safeNormalizePaths([text(entry.file)])?.[0] || "",
      checklistIds: strings(entry.checklistIds),
      necessity: text(entry.necessity),
      risk: text(entry.risk),
      evidence: strings(entry.evidence),
    }))
    .filter((entry) => entry.file)
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function executionMapFromPhaseResults(phaseResults: LooseRecord[] = []): LooseRecord | null {
  for (let index = phaseResults.length - 1; index >= 0; index -= 1) {
    const result = recordValue(phaseResults[index]);
    if (result.phase !== "execute") continue;
    const diagnostics = recordValue(result.diagnostics);
    const direct = recordValue(diagnostics.executionMap);
    if (Array.isArray(direct.changedFiles) || Array.isArray(direct.unmappedChangedFiles)) return direct;
    const artifact = recordValue(diagnostics.executionMapArtifact);
    const metadata = recordValue(artifact.metadata);
    if (Array.isArray(metadata.changedFiles) || Array.isArray(metadata.unmappedChangedFiles)) return metadata;
  }
  return null;
}

export function buildScopeReviewRequest({
  executionMap,
  checklist,
  candidateId,
}: {
  executionMap?: LooseRecord | null;
  checklist?: LooseRecord | null;
  candidateId?: string | null;
}): ScopeReviewRequest | null {
  const unmappedFiles = safeNormalizePaths(
    Array.isArray(executionMap?.unmappedChangedFiles) ? executionMap.unmappedChangedFiles : [],
  ) || [];
  const checkedCandidateId = text(candidateId);
  const checklistItems = records(checklist?.items)
    .map((item) => ({
      id: text(item.id),
      requirement: text(item.requirement),
      allowedFiles: safeNormalizePaths(Array.isArray(item.allowedFiles) ? item.allowedFiles : []) || [],
      risk: text(item.risk) || "unknown",
      required: item.required === true,
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (unmappedFiles.length === 0 || !checkedCandidateId || checklistItems.length === 0) return null;

  const requestBody = {
    schemaVersion: 1 as const,
    candidateId: checkedCandidateId,
    unmappedFiles,
    checklistItems,
  };
  return {
    ...requestBody,
    requestHash: sha256(requestBody),
  };
}

export function validateScopeReview(
  review: unknown,
  request: ScopeReviewRequest | null,
): ScopeReviewValidation {
  if (!request) {
    return { required: false, ok: true, reason: "candidate has no unmapped changed files" };
  }
  if (!isRecord(review)) {
    return { required: true, ok: false, reason: "scopeReview is required for unmapped changed files" };
  }
  if (text(review.candidateId) !== request.candidateId) {
    return { required: true, ok: false, reason: "scopeReview candidateId does not match the frozen candidate" };
  }
  if (text(review.requestHash) !== request.requestHash) {
    return { required: true, ok: false, reason: "scopeReview requestHash does not match the frozen review request" };
  }
  const reviewedFiles = safeNormalizePaths(
    Array.isArray(review.unmappedFiles) ? review.unmappedFiles : [],
  );
  if (!reviewedFiles) {
    return { required: true, ok: false, reason: "scopeReview unmappedFiles contain an unsafe repository path" };
  }
  if (!sameStrings(reviewedFiles, request.unmappedFiles)) {
    return { required: true, ok: false, reason: "scopeReview must cover the exact unmapped file set" };
  }
  const decision = text(review.decision);
  if (decision !== "approve" && decision !== "deny") {
    return { required: true, ok: false, reason: "scopeReview decision must be approve or deny" };
  }

  const knownChecklistIds = new Set(request.checklistItems.map((item) => text(item.id)));
  const mappings = canonicalMappings(review.mappings);
  if (records(review.mappings).length !== mappings.length) {
    return { required: true, ok: false, reason: "scopeReview mappings contain an invalid repository-relative file" };
  }
  if (new Set(mappings.map((entry) => entry.file)).size !== mappings.length) {
    return { required: true, ok: false, reason: "scopeReview mappings must contain each file exactly once" };
  }
  for (const mapping of mappings) {
    if (!request.unmappedFiles.includes(mapping.file)) {
      return { required: true, ok: false, reason: `scopeReview maps a file outside the request: ${mapping.file}` };
    }
    if (mapping.checklistIds.length === 0 || mapping.checklistIds.some((id) => !knownChecklistIds.has(id))) {
      return { required: true, ok: false, reason: `scopeReview maps ${mapping.file} to an unknown or empty checklist id set` };
    }
    if (!mapping.necessity || !mapping.risk || mapping.evidence.length === 0) {
      return { required: true, ok: false, reason: `scopeReview mapping for ${mapping.file} lacks necessity, risk, or evidence` };
    }
  }
  if (decision === "approve" && !sameStrings(mappings.map((entry) => entry.file), request.unmappedFiles)) {
    return { required: true, ok: false, reason: "approved scopeReview must map every requested file" };
  }

  return {
    required: true,
    ok: true,
    reason: decision === "approve" ? "scope expansion approved" : "scope expansion denied",
    decision,
    canonicalMappings: mappings.map(({ file, checklistIds }) => ({ file, checklistIds })),
  };
}

function latestPhaseResult(phaseResults: LooseRecord[], phase: string) {
  for (let index = phaseResults.length - 1; index >= 0; index -= 1) {
    if (phaseResults[index]?.phase === phase) return phaseResults[index];
  }
  return null;
}

function reviewFromPhaseResult(result: LooseRecord | null) {
  return recordValue(recordValue(result?.diagnostics).verdict).scopeReview;
}

export function consensusScopeAmendment({
  phaseResults,
  request,
}: {
  phaseResults: LooseRecord[];
  request: ScopeReviewRequest | null;
}) {
  if (!request) return { required: false, approved: false, reason: "scope amendment not required" };
  const verifyResult = latestPhaseResult(phaseResults, "verify");
  const adversarialResult = latestPhaseResult(phaseResults, "adversarial_verify");
  if (!verifyResult || !isPhasePassed(verifyResult)) {
    return { required: true, approved: false, reason: "latest ordinary verifier did not pass" };
  }
  if (!adversarialResult || !isPhasePassed(adversarialResult)) {
    return { required: true, approved: false, reason: "fresh adversarial verifier approval is required for scope expansion" };
  }

  const ordinaryReview = reviewFromPhaseResult(verifyResult);
  const adversarialReview = reviewFromPhaseResult(adversarialResult);
  const ordinary = validateScopeReview(ordinaryReview, request);
  const adversarial = validateScopeReview(adversarialReview, request);
  if (!ordinary.ok || ordinary.decision !== "approve") {
    return { required: true, approved: false, reason: `ordinary verifier did not approve scope expansion: ${ordinary.reason}`, ordinary, adversarial };
  }
  if (!adversarial.ok || adversarial.decision !== "approve") {
    return { required: true, approved: false, reason: `adversarial verifier did not approve scope expansion: ${adversarial.reason}`, ordinary, adversarial };
  }
  if (stableJson(ordinary.canonicalMappings) !== stableJson(adversarial.canonicalMappings)) {
    return { required: true, approved: false, reason: "verifiers disagreed on file-to-checklist scope mappings", ordinary, adversarial };
  }

  const amendmentBody = {
    schemaVersion: 1,
    candidateId: request.candidateId,
    requestHash: request.requestHash,
    unmappedFiles: request.unmappedFiles,
    mappings: ordinary.canonicalMappings || [],
    approvals: {
      verify: ordinaryReview,
      adversarial_verify: adversarialReview,
    },
  };
  return {
    required: true,
    approved: true,
    reason: "independent verifiers approved identical scope mappings",
    amendment: {
      ...amendmentBody,
      amendmentHash: sha256(amendmentBody),
    },
  };
}

export function applyScopeAmendment(executionMap: LooseRecord, amendment: LooseRecord): LooseRecord {
  const approvedFiles = new Set(safeNormalizePaths(
    Array.isArray(amendment.unmappedFiles) ? amendment.unmappedFiles : [],
  ) || []);
  const addedMappings = records(amendment.mappings).flatMap((mapping) => {
    const file = safeNormalizePaths([text(mapping.file)])?.[0];
    if (!file || !approvedFiles.has(file)) return [];
    return strings(mapping.checklistIds).map((checklistId) => ({
      checklistId,
      changedFiles: [file],
      source: "dual_verifier_scope_amendment",
      amendmentHash: text(amendment.amendmentHash),
    }));
  });
  return {
    ...executionMap,
    mappings: [...records(executionMap.mappings), ...addedMappings],
    unmappedChangedFiles: (safeNormalizePaths(
      Array.isArray(executionMap.unmappedChangedFiles) ? executionMap.unmappedChangedFiles : [],
    ) || []).filter((file) => !approvedFiles.has(file)),
    scopeAmendment: amendment,
  };
}
