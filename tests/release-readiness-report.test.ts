import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildReleaseReadinessReport } from "../scripts/release-readiness-report.js";
import { tempRoot, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function validRecord(index: number) {
  return {
    reviewer: `team-${index}`,
    representativeRepository: `owner/repo-${index}`,
    validatedAt: `2026-06-2${index}T10:00:00.000Z`,
    evidenceBundleRef: `dry-run-evidence/readiness-${index}.json`,
    unfamiliarMaintainerOrTeam: true,
    dryRunFinalizerStatus: "dry-run",
    draftPrPreview: true,
    noLiveSideEffects: true,
    evidenceBundleUnderstood: true,
    trustObjections: [],
    prBodyRequiredManualReconstruction: false,
    blockedFinalizerReasonCategories: [],
    wouldOptIntoLiveDraftPr: index !== 3,
  };
}

function validSweBenchRecord(index: number) {
  return {
    validationMode: "swe-bench-verified",
    benchmarkDataset: "SWE-bench/SWE-bench_Verified",
    benchmarkSplit: "test",
    benchmarkInstanceId: `verified-owner__repo-${index}`,
    representativeRepository: `owner/repo-${index}`,
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    datasetRowRef: `https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified?row=${index}`,
    problemStatementSha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    failToPassTests: index,
    passToPassTests: index + 10,
    officialBenchmarkHumanValidated: true,
    benchmarkIssuePullRequestPair: true,
    validatedAt: `2026-06-2${index}T10:00:00.000Z`,
    evidenceBundleRef: `dry-run-evidence/swe-bench-${index}.json`,
    dryRunFinalizerStatus: "dry-run",
    draftPrPreview: true,
    noLiveSideEffects: true,
    prBodyRequiredManualReconstruction: false,
  };
}

function validOfficialScoreBundle() {
  return {
    validationMode: "swe-bench-verified-official-docker-score-codex-runtime-5",
    harness: {
      dataset: "SWE-bench/SWE-bench_Verified",
      split: "test",
    },
    predictionBuild: {
      sourceOnly: true,
      excludedInstances: [],
    },
    officialReport: {
      totals: {
        submitted_instances: 2,
        completed_instances: 2,
        resolved_instances: 2,
        unresolved_instances: 0,
        empty_patch_instances: 0,
        error_instances: 0,
      },
    },
    scoredReportSummary: {
      sourcePatchJobs: 2,
      scorerRequired: 2,
      scorerCompleted: 2,
      scorerResolved: 2,
      scorerUnresolved: 0,
      scorerFailed: 0,
      scorerExempted: 0,
      validation: {
        valid: true,
        violations: [],
      },
    },
  };
}

async function initRepo(root: string) {
  await execFileAsync("git", ["init"], { cwd: root });
}

test("release readiness report identifies missing product evidence as the remaining gate", async () => {
  const root = await tempRoot("cpb-release-readiness-missing-product");
  await initRepo(root);

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, false);
  assert.equal(report.gates.patchIntegrity.ok, true);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.gates.productGate.missingEvidence, true);
  assert.deepEqual(report.remaining.map((item) => item.gate), ["product-gate"]);
});

test("release readiness report keeps malformed product evidence as structured product-gate failure", async () => {
  const root = await tempRoot("cpb-release-readiness-malformed-product");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, "{ not valid json\n", "utf8");
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, false);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.gates.productGate.missingEvidence, false);
  assert.equal(report.remaining[0].gate, "product-gate");
  assert.match(report.gates.productGate.violations[0].reason, /invalid product validation JSON/);
});

test("release readiness report rejects missing local product evidence bundles", async () => {
  const root = await tempRoot("cpb-release-readiness-missing-bundles");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  });
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, false);
  assert.equal(report.gates.productGate.ok, false);
  assert.equal(report.remaining[0].gate, "product-gate");
  assert.match(report.gates.productGate.violations[0].reason, /local evidence bundle path does not exist/);
});

test("release readiness report passes when patch and product evidence gates pass", async () => {
  const root = await tempRoot("cpb-release-readiness-ready");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "readiness-1.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "readiness-2.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "readiness-3.json"), "{}\n", "utf8");
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  });
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, true);
  assert.equal(report.gates.patchIntegrity.ok, true);
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.deepEqual(report.remaining, []);
});

test("release readiness report accepts SWE-bench Verified product evidence", async () => {
  const root = await tempRoot("cpb-release-readiness-swe-bench-ready");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-1.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-2.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-3.json"), "{}\n", "utf8");
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)],
  });
  await execFileAsync("git", ["add", "-N", "docs/product/cpb-flagship-product-validation.json"], { cwd: root });

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, true);
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.deepEqual(report.remaining, []);
});

test("release readiness report exposes supplemental official score bundle count", async () => {
  const root = await tempRoot("cpb-release-readiness-official-score-ready");
  await initRepo(root);
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  const officialBundle = path.join(root, "docs", "product", "evidence", "official-score.json");
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await mkdir(path.dirname(officialBundle), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-1.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-2.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-3.json"), "{}\n", "utf8");
  await writeJson(officialBundle, validOfficialScoreBundle());
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)],
    supplementalOfficialScoreBundles: [
      {
        validationMode: "swe-bench-verified-official-score-bundle",
        evidenceBundleRef: "docs/product/evidence/official-score.json",
      },
    ],
  });
  await execFileAsync("git", [
    "add",
    "-N",
    "docs/product/cpb-flagship-product-validation.json",
    "docs/product/evidence/official-score.json",
  ], { cwd: root });

  const report = await buildReleaseReadinessReport({ root });

  assert.equal(report.ready, true);
  assert.equal(report.gates.productGate.ok, true);
  assert.equal(report.gates.productGate.recordCount, 3);
  assert.equal(report.gates.productGate.supplementalOfficialScoreBundleCount, 1);
  assert.deepEqual(report.remaining, []);
});

test("package exposes release readiness report entrypoint", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(
    pkg.scripts["report:release-readiness"],
    "npm run build:node && node dist/scripts/release-readiness-report.js",
  );
});
