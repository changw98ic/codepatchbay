#!/usr/bin/env node
import type { LooseRecord } from "../shared/types.js";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

type ProductGateRecord = LooseRecord & {
  validationMode?: unknown;
  reviewer?: unknown;
  representativeRepository?: unknown;
  validatedAt?: unknown;
  evidenceBundleRef?: unknown;
  unfamiliarMaintainerOrTeam?: unknown;
  dryRunFinalizerStatus?: unknown;
  draftPrPreview?: unknown;
  noLiveSideEffects?: unknown;
  evidenceBundleUnderstood?: unknown;
  trustObjections?: unknown;
  prBodyRequiredManualReconstruction?: unknown;
  blockedFinalizerReasonCategories?: unknown;
  wouldOptIntoLiveDraftPr?: unknown;
  benchmarkDataset?: unknown;
  benchmarkSplit?: unknown;
  benchmarkInstanceId?: unknown;
  baseCommit?: unknown;
  datasetRowRef?: unknown;
  problemStatementSha256?: unknown;
  failToPassTests?: unknown;
  passToPassTests?: unknown;
  officialBenchmarkHumanValidated?: unknown;
  benchmarkIssuePullRequestPair?: unknown;
};

type SupplementalOfficialScoreBundle = LooseRecord & {
  validationMode?: unknown;
  evidenceBundleRef?: unknown;
};

export type ProductGateEvidence = {
  schemaVersion?: unknown;
  records?: unknown;
  supplementalOfficialScoreBundles?: unknown;
};

type ProductGateViolation = {
  path: string;
  reason: string;
};

type VerifyProductGateOptions = {
  minRecords?: number;
  maxEvidenceAgeDays?: number;
  referenceTime?: Date | string | number;
};

type VerifyProductGateFileOptions = VerifyProductGateOptions & {
  root?: string;
};

const DEFAULT_EVIDENCE_FILE = "docs/product/cpb-flagship-product-validation.json";
const MIN_RECORDS = 3;
const MAX_EVIDENCE_AGE_DAYS = 90;
const SWE_BENCH_VALIDATION_MODE = "swe-bench-verified";
const SUPPLEMENTAL_OFFICIAL_SCORE_MODE = "swe-bench-verified-official-score-bundle";
const MAINTAINER_VALIDATION_MODE = "maintainer-dry-run";
const SWE_BENCH_VERIFIED_DATASET = "SWE-bench/SWE-bench_Verified";
const PLACEHOLDER_STRINGS = new Set([
  "team-or-maintainer-label",
  "owner/repository-or-internal-repo-label",
  "owner/repository",
  "owner__repo-issue-number",
  "path-or-url-to-dry-run-evidence-bundle",
  "path-or-url-to-swe-bench-dry-run-evidence-bundle",
  "path-or-url-to-official-score-bundle",
  "dry-run-evidence/job-id-audit.json",
  "40-character-base-commit-sha",
  "64-character-problem-statement-sha256",
]);

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedString(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function rejectPlaceholderString(
  violations: ProductGateViolation[],
  value: unknown,
  pathName: string,
) {
  const normalized = normalizedString(value);
  if (PLACEHOLDER_STRINGS.has(normalized) || normalized.startsWith("example:")) {
    violations.push({ path: pathName, reason: "must be real observed product validation data, not template placeholder text" });
  }
}

function addRequiredBoolean(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
) {
  if (typeof record[key] !== "boolean") {
    violations.push({ path: `records[${index}].${key}`, reason: "must be boolean" });
  }
}

function addRequiredExactBoolean(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
  expected: boolean,
) {
  if (record[key] !== expected) {
    violations.push({ path: `records[${index}].${key}`, reason: `must be ${expected}` });
  }
}

function addRequiredString(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
  reason: string,
) {
  if (!nonEmptyString(record[key])) {
    violations.push({ path: `records[${index}].${key}`, reason });
    return false;
  }
  rejectPlaceholderString(violations, record[key], `records[${index}].${key}`);
  return true;
}

function addRequiredExactString(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
  expected: string,
) {
  if (record[key] !== expected) {
    violations.push({ path: `records[${index}].${key}`, reason: `must be "${expected}"` });
  }
}

function addRequiredPatternString(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
  pattern: RegExp,
  reason: string,
) {
  if (!addRequiredString(violations, record, index, key, reason)) return;
  const value = record[key];
  if (typeof value === "string" && !pattern.test(value.trim())) {
    violations.push({ path: `records[${index}].${key}`, reason });
  }
}

function addRequiredPositiveInteger(
  violations: ProductGateViolation[],
  record: ProductGateRecord,
  index: number,
  key: keyof ProductGateRecord,
) {
  if (!Number.isInteger(record[key]) || Number(record[key]) <= 0) {
    violations.push({ path: `records[${index}].${key}`, reason: "must be a positive integer" });
  }
}

function validateCommonDryRunFields(record: ProductGateRecord, index: number) {
  const violations: ProductGateViolation[] = [];
  addRequiredString(violations, record, index, "representativeRepository", "must identify the representative repository");
  if (!isIsoTimestamp(record.validatedAt)) {
    violations.push({ path: `records[${index}].validatedAt`, reason: "must be an ISO timestamp for the observed dry-run validation" });
  }
  addRequiredString(violations, record, index, "evidenceBundleRef", "must identify the dry-run evidence bundle");
  if (record.dryRunFinalizerStatus !== "dry-run") {
    violations.push({ path: `records[${index}].dryRunFinalizerStatus`, reason: "must be \"dry-run\"" });
  }
  if (record.draftPrPreview !== true) {
    violations.push({ path: `records[${index}].draftPrPreview`, reason: "must be true" });
  }
  if (record.noLiveSideEffects !== true) {
    violations.push({ path: `records[${index}].noLiveSideEffects`, reason: "must be true" });
  }
  return violations;
}

function timestampFreshnessViolation(
  value: unknown,
  pathName: string,
  maxEvidenceAgeDays: number,
  referenceTime: Date | string | number,
) {
  if (!isIsoTimestamp(value)) return null;
  const observedMs = Date.parse(value);
  const referenceMs = referenceTime instanceof Date ? referenceTime.getTime() : Date.parse(String(referenceTime));
  if (!Number.isFinite(referenceMs)) {
    return { path: "referenceTime", reason: "must be a valid timestamp when provided" };
  }
  const maxAgeMs = maxEvidenceAgeDays * 24 * 60 * 60 * 1000;
  if (observedMs > referenceMs + 5 * 60 * 1000) {
    return { path: pathName, reason: "must not be in the future beyond five minutes" };
  }
  if (referenceMs - observedMs > maxAgeMs) {
    return { path: pathName, reason: `must be no older than ${maxEvidenceAgeDays} days` };
  }
  return null;
}

function validateMaintainerDryRunRecord(record: ProductGateRecord, index: number) {
  const violations = validateCommonDryRunFields(record, index);
  if (record.validationMode !== undefined && record.validationMode !== MAINTAINER_VALIDATION_MODE) {
    violations.push({
      path: `records[${index}].validationMode`,
      reason: `must be "${MAINTAINER_VALIDATION_MODE}" or omitted for maintainer dry-run records`,
    });
  }
  if (!nonEmptyString(record.reviewer)) {
    violations.push({ path: `records[${index}].reviewer`, reason: "must identify the unfamiliar maintainer or team" });
  } else {
    rejectPlaceholderString(violations, record.reviewer, `records[${index}].reviewer`);
  }
  if (record.unfamiliarMaintainerOrTeam !== true) {
    violations.push({ path: `records[${index}].unfamiliarMaintainerOrTeam`, reason: "must be true" });
  }
  addRequiredBoolean(violations, record, index, "evidenceBundleUnderstood");
  addRequiredBoolean(violations, record, index, "prBodyRequiredManualReconstruction");
  addRequiredBoolean(violations, record, index, "wouldOptIntoLiveDraftPr");
  if (!Array.isArray(record.trustObjections)) {
    violations.push({ path: `records[${index}].trustObjections`, reason: "must be an array" });
  } else {
    record.trustObjections.forEach((item, itemIndex) => {
      rejectPlaceholderString(violations, item, `records[${index}].trustObjections[${itemIndex}]`);
    });
  }
  if (!Array.isArray(record.blockedFinalizerReasonCategories)) {
    violations.push({ path: `records[${index}].blockedFinalizerReasonCategories`, reason: "must be an array" });
  } else {
    record.blockedFinalizerReasonCategories.forEach((item, itemIndex) => {
      rejectPlaceholderString(violations, item, `records[${index}].blockedFinalizerReasonCategories[${itemIndex}]`);
    });
  }
  return violations;
}

function validateSweBenchVerifiedRecord(record: ProductGateRecord, index: number) {
  const violations = validateCommonDryRunFields(record, index);
  addRequiredExactString(violations, record, index, "benchmarkDataset", SWE_BENCH_VERIFIED_DATASET);
  addRequiredExactString(violations, record, index, "benchmarkSplit", "test");
  addRequiredString(violations, record, index, "benchmarkInstanceId", "must identify the SWE-bench Verified instance");
  addRequiredPatternString(
    violations,
    record,
    index,
    "baseCommit",
    /^[0-9a-f]{40}$/i,
    "must be a 40-character git commit hash",
  );
  addRequiredPatternString(
    violations,
    record,
    index,
    "problemStatementSha256",
    /^[0-9a-f]{64}$/i,
    "must be a SHA-256 hash of the benchmark problem statement",
  );
  if (!addRequiredString(violations, record, index, "datasetRowRef", "must identify the benchmark dataset row")) {
    // Already recorded.
  } else if (typeof record.datasetRowRef === "string" && !isUrlRef(record.datasetRowRef.trim())) {
    violations.push({ path: `records[${index}].datasetRowRef`, reason: "must be a URL to the benchmark dataset row" });
  }
  addRequiredPositiveInteger(violations, record, index, "failToPassTests");
  addRequiredPositiveInteger(violations, record, index, "passToPassTests");
  addRequiredExactBoolean(violations, record, index, "officialBenchmarkHumanValidated", true);
  addRequiredExactBoolean(violations, record, index, "benchmarkIssuePullRequestPair", true);
  addRequiredExactBoolean(violations, record, index, "prBodyRequiredManualReconstruction", false);
  return violations;
}

function validateRecord(record: ProductGateRecord, index: number) {
  if (record.validationMode === SWE_BENCH_VALIDATION_MODE) {
    return validateSweBenchVerifiedRecord(record, index);
  }
  return validateMaintainerDryRunRecord(record, index);
}

function addFreshnessViolations(
  violations: ProductGateViolation[],
  records: unknown[],
  maxEvidenceAgeDays: number,
  referenceTime: Date | string | number,
) {
  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const violation = timestampFreshnessViolation(
      record.validatedAt,
      `records[${index}].validatedAt`,
      maxEvidenceAgeDays,
      referenceTime,
    );
    if (violation) violations.push(violation);
  });
}

function validateSupplementalOfficialScoreBundleRef(bundle: SupplementalOfficialScoreBundle, index: number) {
  const violations: ProductGateViolation[] = [];
  if (bundle.validationMode !== SUPPLEMENTAL_OFFICIAL_SCORE_MODE) {
    violations.push({
      path: `supplementalOfficialScoreBundles[${index}].validationMode`,
      reason: `must be "${SUPPLEMENTAL_OFFICIAL_SCORE_MODE}"`,
    });
  }
  if (!nonEmptyString(bundle.evidenceBundleRef)) {
    violations.push({
      path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
      reason: "must identify the local official-score evidence bundle",
    });
    return violations;
  }
  const ref = bundle.evidenceBundleRef.trim();
  rejectPlaceholderString(violations, ref, `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`);
  if (isUrlRef(ref)) {
    violations.push({
      path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
      reason: "must be a local repo-relative official-score evidence bundle so scorer totals can be validated",
    });
  }
  return violations;
}

function validateSupplementalOfficialScoreBundleRefs(evidence: ProductGateEvidence) {
  const violations: ProductGateViolation[] = [];
  if (evidence.supplementalOfficialScoreBundles === undefined) return violations;
  if (!Array.isArray(evidence.supplementalOfficialScoreBundles)) {
    return [{ path: "supplementalOfficialScoreBundles", reason: "must be an array when present" }];
  }
  evidence.supplementalOfficialScoreBundles.forEach((bundle, index) => {
    if (!isRecord(bundle)) {
      violations.push({ path: `supplementalOfficialScoreBundles[${index}]`, reason: "must be an object" });
      return;
    }
    violations.push(...validateSupplementalOfficialScoreBundleRef(bundle, index));
  });
  return violations;
}

function addUniqueValueViolations(
  violations: ProductGateViolation[],
  records: unknown[],
  key: keyof ProductGateRecord,
  label: string,
) {
  const seen = new Map<string, number>();
  records.forEach((record, index) => {
    if (!isRecord(record)) return;
    const normalized = normalizedString(record[key]);
    if (!normalized) return;
    const previous = seen.get(normalized);
    if (previous == null) {
      seen.set(normalized, index);
      return;
    }
    violations.push({
      path: `records[${index}].${key}`,
      reason: `must be unique across product validation records (${label} already used by records[${previous}])`,
    });
  });
}

function isUrlRef(value: string) {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol);
  } catch {
    return false;
  }
}

function recordValidationMode(record: ProductGateRecord) {
  return record.validationMode === SWE_BENCH_VALIDATION_MODE
    ? SWE_BENCH_VALIDATION_MODE
    : MAINTAINER_VALIDATION_MODE;
}

function nestedRecord(root: LooseRecord, key: string) {
  return isRecord(root[key]) ? root[key] as LooseRecord : null;
}

function nestedValue(root: LooseRecord, keys: string[]) {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function addRequiredExactBundleValue(
  violations: ProductGateViolation[],
  bundle: LooseRecord,
  pathName: string,
  keyPath: string[],
  expected: unknown,
) {
  const actual = nestedValue(bundle, keyPath);
  if (actual !== expected) {
    violations.push({
      path: `${pathName}.${keyPath.join(".")}`,
      reason: `must match records entry value ${JSON.stringify(expected)}`,
    });
  }
}

function validateDryRunEvidenceBundleContent(bundle: unknown, record: ProductGateRecord, index: number) {
  const pathName = `records[${index}].evidenceBundle`;
  const violations: ProductGateViolation[] = [];
  if (!isRecord(bundle)) {
    return [{ path: pathName, reason: "dry-run evidence bundle must be a JSON object" }];
  }

  addRequiredExactBundleValue(violations, bundle, pathName, ["schemaVersion"], 1);
  addRequiredExactBundleValue(violations, bundle, pathName, ["validationMode"], recordValidationMode(record));
  addRequiredExactBundleValue(violations, bundle, pathName, ["validatedAt"], record.validatedAt);

  const dryRunEvidence = nestedRecord(bundle, "cpbDryRunEvidence");
  if (!dryRunEvidence) {
    violations.push({ path: `${pathName}.cpbDryRunEvidence`, reason: "must include CPB dry-run finalizer evidence" });
  } else {
    addRequiredExactRecordString(violations, dryRunEvidence, `${pathName}.cpbDryRunEvidence`, "dryRunFinalizerStatus", "dry-run");
    addRequiredExactRecordBoolean(violations, dryRunEvidence, `${pathName}.cpbDryRunEvidence`, "draftPrPreview", true);
    addRequiredExactRecordBoolean(violations, dryRunEvidence, `${pathName}.cpbDryRunEvidence`, "noLiveSideEffects", true);
    addRequiredExactRecordBoolean(
      violations,
      dryRunEvidence,
      `${pathName}.cpbDryRunEvidence`,
      "prBodyRequiredManualReconstruction",
      record.prBodyRequiredManualReconstruction === true,
    );
  }

  if (record.validationMode === SWE_BENCH_VALIDATION_MODE) {
    addRequiredExactBundleValue(violations, bundle, pathName, ["source", "dataset"], record.benchmarkDataset);
    addRequiredExactBundleValue(violations, bundle, pathName, ["source", "split"], record.benchmarkSplit);
    addRequiredExactBundleValue(violations, bundle, pathName, ["source", "datasetRowsApi"], record.datasetRowRef);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "instanceId"], record.benchmarkInstanceId);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "repository"], record.representativeRepository);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "baseCommit"], record.baseCommit);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "problemStatementSha256"], record.problemStatementSha256);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "failToPassTests"], record.failToPassTests);
    addRequiredExactBundleValue(violations, bundle, pathName, ["sample", "passToPassTests"], record.passToPassTests);
    return violations;
  }

  addRequiredExactBundleValue(violations, bundle, pathName, ["representativeRepository"], record.representativeRepository);
  if (record.reviewer !== undefined) {
    addRequiredExactBundleValue(violations, bundle, pathName, ["reviewer"], record.reviewer);
  }
  return violations;
}

async function resolveRepoLocalEvidencePath(
  root: string,
  evidenceBundleRef: string,
  violationPath: string,
  evidenceKind: "dry-run evidence bundle" | "official-score bundle",
  violations: ProductGateViolation[],
) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, evidenceBundleRef);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    violations.push({
      path: violationPath,
      reason: `local ${evidenceKind} path must stay inside the repository root: ${evidenceBundleRef}`,
    });
    return null;
  }

  let realRoot: string;
  let realResolved: string;
  try {
    [realRoot, realResolved] = await Promise.all([
      realpath(resolvedRoot),
      realpath(resolved),
    ]);
  } catch {
    const missingKind = evidenceKind === "dry-run evidence bundle" ? "evidence bundle" : evidenceKind;
    violations.push({
      path: violationPath,
      reason: `local ${missingKind} path does not exist: ${evidenceBundleRef}`,
    });
    return null;
  }

  const realRelative = path.relative(realRoot, realResolved);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    violations.push({
      path: violationPath,
      reason: `local ${evidenceKind} path must stay inside the repository root after symlink resolution: ${evidenceBundleRef}`,
    });
    return null;
  }

  return realResolved;
}

async function localEvidenceBundleViolations(
  evidence: ProductGateEvidence,
  { root = process.cwd() }: VerifyProductGateFileOptions = {},
) {
  const violations: ProductGateViolation[] = [];
  if (!Array.isArray(evidence.records)) return violations;

  await Promise.all(evidence.records.map(async (record, index) => {
    if (!isRecord(record) || !nonEmptyString(record.evidenceBundleRef)) return;
    const evidenceBundleRef = record.evidenceBundleRef.trim();
    if (isUrlRef(evidenceBundleRef)) {
      violations.push({
        path: `records[${index}].evidenceBundleRef`,
        reason: "must be a local repo-relative dry-run evidence bundle so release gates can validate its content",
      });
      return;
    }

    const resolved = await resolveRepoLocalEvidencePath(
      root,
      evidenceBundleRef,
      `records[${index}].evidenceBundleRef`,
      "dry-run evidence bundle",
      violations,
    );
    if (resolved === null) return;

    const raw = await readFile(resolved, "utf8").catch(() => {
      violations.push({
        path: `records[${index}].evidenceBundleRef`,
        reason: `local dry-run evidence bundle path could not be read: ${evidenceBundleRef}`,
      });
      return null;
    });
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      violations.push({
        path: `records[${index}].evidenceBundleRef`,
        reason: `dry-run evidence bundle JSON is invalid: ${message}`,
      });
      return;
    }
    violations.push(...validateDryRunEvidenceBundleContent(parsed, record as ProductGateRecord, index));
  }));

  return violations;
}

function numberField(record: LooseRecord, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addRequiredExactRecordString(
  violations: ProductGateViolation[],
  record: LooseRecord,
  pathName: string,
  key: string,
  expected: string,
) {
  if (record[key] !== expected) {
    violations.push({ path: `${pathName}.${key}`, reason: `must be "${expected}"` });
  }
}

function addRequiredExactRecordBoolean(
  violations: ProductGateViolation[],
  record: LooseRecord,
  pathName: string,
  key: string,
  expected: boolean,
) {
  if (record[key] !== expected) {
    violations.push({ path: `${pathName}.${key}`, reason: `must be ${expected}` });
  }
}

function addRequiredExactRecordNumber(
  violations: ProductGateViolation[],
  record: LooseRecord,
  pathName: string,
  key: string,
  expected: number,
) {
  if (record[key] !== expected) {
    violations.push({ path: `${pathName}.${key}`, reason: `must be ${expected}` });
  }
}

function sha256Hex(content: Buffer | string) {
  return createHash("sha256").update(content).digest("hex");
}

function stringArrayField(record: LooseRecord | null, key: string) {
  const value = record?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function sortedStrings(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStringSet(left: string[], right: string[]) {
  return JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));
}

function artifactKey(artifact: LooseRecord) {
  const role = typeof artifact.role === "string" ? artifact.role : "";
  const instanceId = typeof artifact.instanceId === "string" ? artifact.instanceId : "";
  return instanceId ? `${role}:${instanceId}` : role;
}

function parseJsonArtifact(
  artifacts: Map<string, Buffer>,
  key: string,
  pathName: string,
  violations: ProductGateViolation[],
) {
  const content = artifacts.get(key);
  if (!content) return null;
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    violations.push({ path: `${pathName}.auditArtifacts.${key}`, reason: `must be valid JSON: ${message}` });
    return null;
  }
}

function parsePredictionJsonl(
  artifacts: Map<string, Buffer>,
  pathName: string,
  violations: ProductGateViolation[],
) {
  const content = artifacts.get("prediction-jsonl");
  if (!content) return [];
  const lines = content.toString("utf8").trim().split(/\n+/).filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      violations.push({ path: `${pathName}.auditArtifacts.prediction-jsonl[${index}]`, reason: `must be valid JSONL: ${message}` });
      return null;
    }
  }).filter((item): item is LooseRecord => isRecord(item));
}

function validateOfficialScoreBundleContent(bundle: unknown, pathName: string) {
  const violations: ProductGateViolation[] = [];
  if (!isRecord(bundle)) {
    return [{ path: pathName, reason: "official-score evidence bundle must be an object" }];
  }

  if (typeof bundle.validationMode !== "string" || !bundle.validationMode.startsWith("swe-bench-verified-official-docker-score")) {
    violations.push({
      path: `${pathName}.validationMode`,
      reason: "must identify a SWE-bench Verified official Docker score bundle",
    });
  }

  const harness = isRecord(bundle.harness) ? bundle.harness : null;
  if (!harness) {
    violations.push({ path: `${pathName}.harness`, reason: "must include official harness metadata" });
  } else {
    addRequiredExactRecordString(violations, harness, `${pathName}.harness`, "dataset", SWE_BENCH_VERIFIED_DATASET);
    addRequiredExactRecordString(violations, harness, `${pathName}.harness`, "split", "test");
  }

  const predictionBuild = isRecord(bundle.predictionBuild) ? bundle.predictionBuild : null;
  if (!predictionBuild) {
    violations.push({ path: `${pathName}.predictionBuild`, reason: "must include prediction build metadata" });
  } else {
    addRequiredExactRecordBoolean(violations, predictionBuild, `${pathName}.predictionBuild`, "sourceOnly", true);
  }

  const officialReport = isRecord(bundle.officialReport) ? bundle.officialReport : null;
  const totals = officialReport && isRecord(officialReport.totals) ? officialReport.totals : null;
  if (!totals) {
    violations.push({ path: `${pathName}.officialReport.totals`, reason: "must include official scorer totals" });
  } else {
    const submitted = numberField(totals, "submitted_instances");
    const completed = numberField(totals, "completed_instances");
    const resolved = numberField(totals, "resolved_instances");
    if (submitted === null || submitted <= 0) {
      violations.push({ path: `${pathName}.officialReport.totals.submitted_instances`, reason: "must be a positive number" });
    }
    if (completed !== submitted) {
      violations.push({ path: `${pathName}.officialReport.totals.completed_instances`, reason: "must equal submitted_instances" });
    }
    if (resolved !== submitted) {
      violations.push({ path: `${pathName}.officialReport.totals.resolved_instances`, reason: "must equal submitted_instances" });
    }
    addRequiredExactRecordNumber(violations, totals, `${pathName}.officialReport.totals`, "unresolved_instances", 0);
    addRequiredExactRecordNumber(violations, totals, `${pathName}.officialReport.totals`, "empty_patch_instances", 0);
    addRequiredExactRecordNumber(violations, totals, `${pathName}.officialReport.totals`, "error_instances", 0);
  }

  const scoredReportSummary = isRecord(bundle.scoredReportSummary) ? bundle.scoredReportSummary : null;
  if (!scoredReportSummary) {
    violations.push({ path: `${pathName}.scoredReportSummary`, reason: "must include merged CPB/scorer summary" });
  } else {
    const sourcePatchJobs = numberField(scoredReportSummary, "sourcePatchJobs");
    const scorerRequired = numberField(scoredReportSummary, "scorerRequired");
    const scorerCompleted = numberField(scoredReportSummary, "scorerCompleted");
    const scorerResolved = numberField(scoredReportSummary, "scorerResolved");
    if (scorerRequired === null || scorerRequired <= 0) {
      violations.push({ path: `${pathName}.scoredReportSummary.scorerRequired`, reason: "must be a positive number" });
    }
    if (sourcePatchJobs !== scorerRequired) {
      violations.push({ path: `${pathName}.scoredReportSummary.sourcePatchJobs`, reason: "must equal scorerRequired" });
    }
    if (scorerCompleted !== scorerRequired) {
      violations.push({ path: `${pathName}.scoredReportSummary.scorerCompleted`, reason: "must equal scorerRequired" });
    }
    if (scorerResolved !== scorerRequired) {
      violations.push({ path: `${pathName}.scoredReportSummary.scorerResolved`, reason: "must equal scorerRequired" });
    }
    addRequiredExactRecordNumber(violations, scoredReportSummary, `${pathName}.scoredReportSummary`, "scorerUnresolved", 0);
    addRequiredExactRecordNumber(violations, scoredReportSummary, `${pathName}.scoredReportSummary`, "scorerFailed", 0);

    const validation = isRecord(scoredReportSummary.validation) ? scoredReportSummary.validation : null;
    if (!validation) {
      violations.push({ path: `${pathName}.scoredReportSummary.validation`, reason: "must include scored report validation status" });
    } else {
      addRequiredExactRecordBoolean(violations, validation, `${pathName}.scoredReportSummary.validation`, "valid", true);
      if (!Array.isArray(validation.violations) || validation.violations.length !== 0) {
        violations.push({ path: `${pathName}.scoredReportSummary.validation.violations`, reason: "must be an empty array" });
      }
    }

    const scorerExempted = numberField(scoredReportSummary, "scorerExempted") || 0;
    const excluded = predictionBuild && Array.isArray(predictionBuild.excludedInstances)
      ? predictionBuild.excludedInstances
      : [];
    if (scorerExempted !== excluded.length) {
      violations.push({
        path: `${pathName}.predictionBuild.excludedInstances`,
        reason: "must explain each scorer-exempted instance",
      });
    }
  }

  if (!Array.isArray(bundle.auditArtifacts) || bundle.auditArtifacts.length === 0) {
    violations.push({
      path: `${pathName}.auditArtifacts`,
      reason: "must include repo-local official scorer artifacts with sha256 and byte counts",
    });
  }

  return violations;
}

async function validateOfficialScoreBundleArtifacts(
  bundle: unknown,
  pathName: string,
  root: string,
  violations: ProductGateViolation[],
) {
  if (!isRecord(bundle) || !Array.isArray(bundle.auditArtifacts)) return;

  const artifactBytes = new Map<string, Buffer>();
  const artifactsByKey = new Map<string, LooseRecord>();

  await Promise.all(bundle.auditArtifacts.map(async (artifact, index) => {
    const artifactPath = `${pathName}.auditArtifacts[${index}]`;
    if (!isRecord(artifact)) {
      violations.push({ path: artifactPath, reason: "must be an object" });
      return;
    }
    const key = artifactKey(artifact);
    if (!key || artifactsByKey.has(key)) {
      violations.push({ path: `${artifactPath}.role`, reason: "must identify a unique artifact role and optional instanceId" });
      return;
    }
    artifactsByKey.set(key, artifact);

    if (!nonEmptyString(artifact.path)) {
      violations.push({ path: `${artifactPath}.path`, reason: "must identify the repo-local artifact path" });
      return;
    }
    const artifactRef = artifact.path.trim();
    if (isUrlRef(artifactRef)) {
      violations.push({ path: `${artifactPath}.path`, reason: "must be a repo-local artifact path" });
      return;
    }
    if (!Number.isInteger(artifact.bytes) || Number(artifact.bytes) <= 0) {
      violations.push({ path: `${artifactPath}.bytes`, reason: "must be a positive byte count" });
      return;
    }
    if (!nonEmptyString(artifact.sha256) || !/^[0-9a-f]{64}$/i.test(artifact.sha256.trim())) {
      violations.push({ path: `${artifactPath}.sha256`, reason: "must be a SHA-256 digest" });
      return;
    }

    const resolved = await resolveRepoLocalEvidencePath(
      root,
      artifactRef,
      `${artifactPath}.path`,
      "official-score bundle",
      violations,
    );
    if (resolved === null) return;

    const content = await readFile(resolved).catch(() => {
      violations.push({ path: `${artifactPath}.path`, reason: `local official-score artifact path could not be read: ${artifactRef}` });
      return null;
    });
    if (content === null) return;

    const actualBytes = content.byteLength;
    const actualSha = sha256Hex(content);
    if (actualBytes !== artifact.bytes) {
      violations.push({ path: `${artifactPath}.bytes`, reason: `must match artifact bytes ${actualBytes}` });
    }
    if (actualSha !== String(artifact.sha256).toLowerCase()) {
      violations.push({ path: `${artifactPath}.sha256`, reason: "must match the repo-local artifact content" });
    }
    artifactBytes.set(key, content);
  }));

  const samples = Array.isArray(bundle.samples) && bundle.samples.every(isRecord)
    ? bundle.samples as LooseRecord[]
    : [];
  const sampleIds = samples
    .map((sample) => typeof sample.instanceId === "string" ? sample.instanceId : "")
    .filter(Boolean);
  const requiredRoles = ["aggregate-report", "official-score-summary", "source-patch-manifest", "prediction-jsonl"];
  for (const role of requiredRoles) {
    if (!artifactBytes.has(role)) {
      violations.push({ path: `${pathName}.auditArtifacts`, reason: `must include ${role} artifact` });
    }
  }
  for (const instanceId of sampleIds) {
    if (!artifactBytes.has(`source-patch:${instanceId}`)) {
      violations.push({ path: `${pathName}.auditArtifacts`, reason: `must include source-patch artifact for ${instanceId}` });
    }
  }
  if (sampleIds.length !== 4) {
    violations.push({ path: `${pathName}.samples`, reason: "must include exactly four source-patch scored samples" });
  }

  const aggregate = parseJsonArtifact(artifactBytes, "aggregate-report", pathName, violations);
  const summary = parseJsonArtifact(artifactBytes, "official-score-summary", pathName, violations);
  const manifest = parseJsonArtifact(artifactBytes, "source-patch-manifest", pathName, violations);
  const predictions = parsePredictionJsonl(artifactBytes, pathName, violations);

  const officialReport = isRecord(bundle.officialReport) ? bundle.officialReport : null;
  const totals = officialReport && isRecord(officialReport.totals) ? officialReport.totals : null;
  if (isRecord(aggregate) && totals) {
    for (const key of ["submitted_instances", "completed_instances", "resolved_instances", "unresolved_instances", "empty_patch_instances", "error_instances"]) {
      if (aggregate[key] !== totals[key]) {
        violations.push({ path: `${pathName}.auditArtifacts.aggregate-report.${key}`, reason: "must match officialReport.totals" });
      }
    }
    const aggregateResolved = stringArrayField(aggregate, "resolved_ids");
    const bundleResolved = stringArrayField(officialReport, "resolvedIds");
    if (!aggregateResolved || !bundleResolved || !sameStringSet(aggregateResolved, bundleResolved)) {
      violations.push({ path: `${pathName}.auditArtifacts.aggregate-report.resolved_ids`, reason: "must match officialReport.resolvedIds" });
    }
  }

  if (isRecord(summary) && totals) {
    const summaryTotals = isRecord(summary.totals) ? summary.totals : null;
    if (!summaryTotals) {
      violations.push({ path: `${pathName}.auditArtifacts.official-score-summary.totals`, reason: "must include official scorer totals" });
    } else {
      for (const key of ["submitted_instances", "completed_instances", "resolved_instances", "unresolved_instances", "empty_patch_instances", "error_instances"]) {
        if (summaryTotals[key] !== totals[key]) {
          violations.push({ path: `${pathName}.auditArtifacts.official-score-summary.totals.${key}`, reason: "must match officialReport.totals" });
        }
      }
    }
    const summaryResolved = stringArrayField(summary, "resolved_ids");
    const bundleResolved = stringArrayField(officialReport || {}, "resolvedIds");
    if (!summaryResolved || !bundleResolved || !sameStringSet(summaryResolved, bundleResolved)) {
      violations.push({ path: `${pathName}.auditArtifacts.official-score-summary.resolved_ids`, reason: "must match officialReport.resolvedIds" });
    }
  }

  if (isRecord(manifest) && Array.isArray(manifest.records)) {
    const manifestById = new Map<string, LooseRecord>();
    manifest.records.forEach((record) => {
      if (isRecord(record) && typeof record.instance_id === "string") manifestById.set(record.instance_id, record);
    });
    for (const sample of samples) {
      const instanceId = typeof sample.instanceId === "string" ? sample.instanceId : "";
      const sourcePatch = isRecord(sample.sourcePatch) ? sample.sourcePatch : null;
      const artifact = artifactsByKey.get(`source-patch:${instanceId}`);
      const manifestRecord = manifestById.get(instanceId);
      if (!sourcePatch || !artifact || !manifestRecord) {
        violations.push({ path: `${pathName}.samples.${instanceId || "unknown"}.sourcePatch`, reason: "must have sample, manifest, and audit artifact entries" });
        continue;
      }
      if (sourcePatch.path !== artifact.path || sourcePatch.sha256 !== artifact.sha256 || sourcePatch.bytes !== artifact.bytes) {
        violations.push({ path: `${pathName}.samples.${instanceId}.sourcePatch`, reason: "must match source-patch audit artifact path, sha256, and bytes" });
      }
      if (manifestRecord.patchPath !== sourcePatch.path || manifestRecord.bytes !== sourcePatch.bytes || manifestRecord.sourceOnly !== true) {
        violations.push({ path: `${pathName}.auditArtifacts.source-patch-manifest.${instanceId}`, reason: "must match sample sourcePatch metadata" });
      }
      const patchBytes = artifactBytes.get(`source-patch:${instanceId}`);
      if (patchBytes && sourcePatch.sha256 !== sha256Hex(patchBytes)) {
        violations.push({ path: `${pathName}.samples.${instanceId}.sourcePatch.sha256`, reason: "must match source-patch artifact content" });
      }
    }
  } else if (artifactBytes.has("source-patch-manifest")) {
    violations.push({ path: `${pathName}.auditArtifacts.source-patch-manifest`, reason: "must include records array" });
  }

  if (predictions.length > 0) {
    const predictionIds = predictions
      .map((prediction) => typeof prediction.instance_id === "string" ? prediction.instance_id : "")
      .filter(Boolean);
    if (!sameStringSet(predictionIds, sampleIds)) {
      violations.push({ path: `${pathName}.auditArtifacts.prediction-jsonl`, reason: "must contain exactly the scored sample instance ids" });
    }
    for (const prediction of predictions) {
      const instanceId = typeof prediction.instance_id === "string" ? prediction.instance_id : "";
      const patchBytes = artifactBytes.get(`source-patch:${instanceId}`);
      if (!patchBytes || typeof prediction.model_patch !== "string") continue;
      if (prediction.model_patch.trimEnd() !== patchBytes.toString("utf8").trimEnd()) {
        violations.push({ path: `${pathName}.auditArtifacts.prediction-jsonl.${instanceId}.model_patch`, reason: "must match source-patch artifact content" });
      }
    }
  }

  if (isRecord(summary) && samples.length > 0 && Array.isArray(summary.instances)) {
    const summaryById = new Map<string, LooseRecord>();
    summary.instances.forEach((instance) => {
      if (isRecord(instance) && typeof instance.instance_id === "string") summaryById.set(instance.instance_id, instance);
    });
    for (const sample of samples) {
      const instanceId = typeof sample.instanceId === "string" ? sample.instanceId : "";
      const officialResult = isRecord(sample.officialResult) ? sample.officialResult : null;
      const summaryInstance = summaryById.get(instanceId);
      if (!officialResult || !summaryInstance) {
        violations.push({ path: `${pathName}.auditArtifacts.official-score-summary.${instanceId || "unknown"}`, reason: "must match each sample official result" });
        continue;
      }
      if (
        summaryInstance.resolved !== officialResult.resolved
        || summaryInstance.patch_successfully_applied !== officialResult.patchSuccessfullyApplied
        || summaryInstance.fail_to_pass_failure !== nestedValue(officialResult, ["failToPass", "failure"])
        || summaryInstance.pass_to_pass_failure !== nestedValue(officialResult, ["passToPass", "failure"])
      ) {
        violations.push({ path: `${pathName}.auditArtifacts.official-score-summary.${instanceId}`, reason: "must match sample officialResult" });
      }
    }
  }
}

async function supplementalOfficialScoreBundleViolations(
  evidence: ProductGateEvidence,
  { root = process.cwd() }: VerifyProductGateFileOptions = {},
) {
  const violations: ProductGateViolation[] = [];
  if (!Array.isArray(evidence.supplementalOfficialScoreBundles)) return violations;

  await Promise.all(evidence.supplementalOfficialScoreBundles.map(async (bundle, index) => {
    if (!isRecord(bundle) || !nonEmptyString(bundle.evidenceBundleRef)) return;
    const evidenceBundleRef = bundle.evidenceBundleRef.trim();
    if (isUrlRef(evidenceBundleRef)) return;

    const resolved = await resolveRepoLocalEvidencePath(
      root,
      evidenceBundleRef,
      `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
      "official-score bundle",
      violations,
    );
    if (resolved === null) return;

    const raw = await readFile(resolved, "utf8").catch(() => {
      violations.push({
        path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
        reason: `local official-score bundle path could not be read: ${evidenceBundleRef}`,
      });
      return null;
    });
    if (raw === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      violations.push({
        path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
        reason: `official-score bundle JSON is invalid: ${message}`,
      });
      return;
    }
    const bundlePath = `supplementalOfficialScoreBundles[${index}].bundle`;
    violations.push(...validateOfficialScoreBundleContent(parsed, bundlePath));
    await validateOfficialScoreBundleArtifacts(parsed, bundlePath, root, violations);
  }));

  return violations;
}

export function verifyProductGateEvidence(
  evidence: ProductGateEvidence,
  {
    minRecords = MIN_RECORDS,
    maxEvidenceAgeDays = MAX_EVIDENCE_AGE_DAYS,
    referenceTime = new Date(),
  }: VerifyProductGateOptions = {},
) {
  const violations: ProductGateViolation[] = [];
  if (evidence.schemaVersion !== 1) {
    violations.push({ path: "schemaVersion", reason: "must be 1" });
  }
  if (!Array.isArray(evidence.records)) {
    violations.push({ path: "records", reason: "must be an array" });
    return { ok: false, recordCount: 0, violations };
  }
  if (evidence.records.length < minRecords) {
    violations.push({ path: "records", reason: `must contain at least ${minRecords} product validation records` });
  }
  evidence.records.forEach((record, index) => {
    if (!isRecord(record)) {
      violations.push({ path: `records[${index}]`, reason: "must be an object" });
      return;
    }
    violations.push(...validateRecord(record, index));
  });
  addUniqueValueViolations(violations, evidence.records, "reviewer", "reviewer/team");
  addUniqueValueViolations(violations, evidence.records, "benchmarkInstanceId", "SWE-bench Verified instance");
  addUniqueValueViolations(violations, evidence.records, "representativeRepository", "representative repository");
  addUniqueValueViolations(violations, evidence.records, "evidenceBundleRef", "dry-run evidence bundle");
  addFreshnessViolations(violations, evidence.records, maxEvidenceAgeDays, referenceTime);
  violations.push(...validateSupplementalOfficialScoreBundleRefs(evidence));

  return {
    ok: violations.length === 0,
    recordCount: evidence.records.length,
    supplementalOfficialScoreBundleCount: Array.isArray(evidence.supplementalOfficialScoreBundles)
      ? evidence.supplementalOfficialScoreBundles.length
      : 0,
    violations,
  };
}

export async function verifyProductGateEvidenceFile(
  evidence: ProductGateEvidence,
  options: VerifyProductGateFileOptions = {},
) {
  const result = verifyProductGateEvidence(evidence, options);
  const evidenceBundleViolations = await localEvidenceBundleViolations(evidence, options);
  const supplementalViolations = await supplementalOfficialScoreBundleViolations(evidence, options);
  const violations = [...result.violations, ...evidenceBundleViolations, ...supplementalViolations];
  return {
    ok: violations.length === 0,
    recordCount: result.recordCount,
    supplementalOfficialScoreBundleCount: result.supplementalOfficialScoreBundleCount,
    violations,
  };
}

export function formatProductGateViolations(violations: ProductGateViolation[]) {
  return violations.map((violation) => `- ${violation.path}: ${violation.reason}`).join("\n");
}

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] || null;
}

async function readEvidence(filePath: string) {
  const raw = await readFile(filePath, "utf8").catch((error: unknown) => {
    const code = isRecord(error) ? error.code : null;
    if (code === "ENOENT") {
      throw new Error(`Product gate evidence file is missing: ${path.relative(process.cwd(), filePath)}`);
    }
    throw error;
  });
  return JSON.parse(raw) as ProductGateEvidence;
}

async function main() {
  const args = process.argv.slice(2);
  const evidencePath = path.resolve(process.cwd(), argValue(args, "--file") || DEFAULT_EVIDENCE_FILE);
  const evidence = await readEvidence(evidencePath);
  const result = await verifyProductGateEvidenceFile(evidence, { root: process.cwd() });
  if (!result.ok) {
    console.error(`Product gate failed for ${path.relative(process.cwd(), evidencePath)}.`);
    console.error(formatProductGateViolations(result.violations));
    process.exitCode = 1;
    return;
  }
  const supplemental = result.supplementalOfficialScoreBundleCount
    ? ` and ${result.supplementalOfficialScoreBundleCount} supplemental official score bundle${result.supplementalOfficialScoreBundleCount === 1 ? "" : "s"}`
    : "";
  console.log(`Product gate passed with ${result.recordCount} dry-run validation records${supplemental}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
