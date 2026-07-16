#!/usr/bin/env node
import type { LooseRecord } from "../shared/types.js";
import { access, readFile } from "node:fs/promises";
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

type ProductGateEvidence = {
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
};

type VerifyProductGateFileOptions = VerifyProductGateOptions & {
  root?: string;
};

const DEFAULT_EVIDENCE_FILE = "docs/product/cpb-flagship-product-validation.json";
const MIN_RECORDS = 3;
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

function isIsoTimestamp(value: unknown) {
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

async function localEvidenceBundleViolations(
  evidence: ProductGateEvidence,
  { root = process.cwd() }: VerifyProductGateFileOptions = {},
) {
  const violations: ProductGateViolation[] = [];
  if (!Array.isArray(evidence.records)) return violations;

  await Promise.all(evidence.records.map(async (record, index) => {
    if (!isRecord(record) || !nonEmptyString(record.evidenceBundleRef)) return;
    const evidenceBundleRef = record.evidenceBundleRef.trim();
    if (isUrlRef(evidenceBundleRef)) return;

    const resolved = path.resolve(root, evidenceBundleRef);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      violations.push({
        path: `records[${index}].evidenceBundleRef`,
        reason: `local evidence bundle path must stay inside the repository root: ${evidenceBundleRef}`,
      });
      return;
    }
    await access(resolved).catch(() => {
      violations.push({
        path: `records[${index}].evidenceBundleRef`,
        reason: `local evidence bundle path does not exist: ${evidenceBundleRef}`,
      });
    });
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

  return violations;
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

    const resolved = path.resolve(root, evidenceBundleRef);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      violations.push({
        path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
        reason: `local official-score bundle path must stay inside the repository root: ${evidenceBundleRef}`,
      });
      return;
    }

    const raw = await readFile(resolved, "utf8").catch((error: unknown) => {
      violations.push({
        path: `supplementalOfficialScoreBundles[${index}].evidenceBundleRef`,
        reason: `local official-score bundle path does not exist: ${evidenceBundleRef}`,
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
    violations.push(...validateOfficialScoreBundleContent(parsed, `supplementalOfficialScoreBundles[${index}].bundle`));
  }));

  return violations;
}

export function verifyProductGateEvidence(
  evidence: ProductGateEvidence,
  { minRecords = MIN_RECORDS }: VerifyProductGateOptions = {},
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
