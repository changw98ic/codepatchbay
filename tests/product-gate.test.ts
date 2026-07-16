import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  formatProductGateViolations,
  verifyProductGateEvidence,
  verifyProductGateEvidenceFile,
} from "../scripts/verify-product-gate.js";
import { tempRoot, writeJson } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(import.meta.dirname, "..", "scripts", "verify-product-gate.js");

function validRecord(index: number) {
  return {
    reviewer: `unfamiliar-team-${index}`,
    representativeRepository: `owner/repo-${index}`,
    validatedAt: `2026-06-2${index}T10:00:00.000Z`,
    evidenceBundleRef: `dry-run-evidence/job-${index}-audit.json`,
    unfamiliarMaintainerOrTeam: true,
    dryRunFinalizerStatus: "dry-run",
    draftPrPreview: true,
    noLiveSideEffects: true,
    evidenceBundleUnderstood: index !== 2,
    trustObjections: index === 1 ? ["wanted clearer token provenance"] : [],
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
    evidenceBundleRef: `dry-run-evidence/swe-bench-${index}-audit.json`,
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
      excludedInstances: [
        {
          instanceId: "django__django-13344",
          reason: "test-only patch",
        },
      ],
    },
    officialReport: {
      totals: {
        submitted_instances: 4,
        completed_instances: 4,
        resolved_instances: 4,
        unresolved_instances: 0,
        empty_patch_instances: 0,
        error_instances: 0,
      },
    },
    scoredReportSummary: {
      sourcePatchJobs: 4,
      scorerRequired: 4,
      scorerCompleted: 4,
      scorerResolved: 4,
      scorerUnresolved: 0,
      scorerFailed: 0,
      scorerExempted: 1,
      validation: {
        valid: true,
        violations: [],
      },
    },
  };
}

test("product gate accepts three unfamiliar dry-run validation records", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  });

  assert.equal(result.ok, true);
  assert.equal(result.recordCount, 3);
  assert.deepEqual(result.violations, []);
});

test("product gate accepts SWE-bench Verified dry-run sample records without maintainer feedback fields", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)],
  });

  assert.equal(result.ok, true);
  assert.equal(result.recordCount, 3);
  assert.deepEqual(result.violations, []);
});

test("product gate accepts supplemental official score bundle refs without weakening representative records", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)],
    supplementalOfficialScoreBundles: [
      {
        validationMode: "swe-bench-verified-official-score-bundle",
        evidenceBundleRef: "docs/product/evidence/swe-bench-real-runs/verified-5-codex-runtime-official-score.json",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.recordCount, 3);
  assert.equal(result.supplementalOfficialScoreBundleCount, 1);
  assert.deepEqual(result.violations, []);
});

test("product gate requires unique SWE-bench Verified instance ids", () => {
  const duplicateInstance = {
    ...validSweBenchRecord(3),
    benchmarkInstanceId: "verified-owner__repo-1",
  };

  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), duplicateInstance],
  });

  assert.equal(result.ok, false);
  assert.match(
    formatProductGateViolations(result.violations),
    /SWE-bench Verified instance already used by records\[0\]/,
  );
});

test("product gate fails closed when validation records are missing", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2)],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { path: "records", reason: "must contain at least 3 product validation records" },
  ]);
});

test("product gate validates dry-run evidence fields", () => {
  const invalid = {
    ...validRecord(1),
    validatedAt: "not-a-date",
    evidenceBundleRef: "",
    unfamiliarMaintainerOrTeam: false,
    draftPrPreview: false,
    trustObjections: "none",
  };

  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [invalid, validRecord(2), validRecord(3)],
  });

  assert.equal(result.ok, false);
  assert.match(formatProductGateViolations(result.violations), /validatedAt: must be an ISO timestamp/);
  assert.match(formatProductGateViolations(result.violations), /evidenceBundleRef: must identify the dry-run evidence bundle/);
  assert.match(formatProductGateViolations(result.violations), /unfamiliarMaintainerOrTeam: must be true/);
  assert.match(formatProductGateViolations(result.violations), /draftPrPreview: must be true/);
  assert.match(formatProductGateViolations(result.violations), /trustObjections: must be an array/);
});

test("product gate requires unique reviewers, repositories, and evidence bundles", () => {
  const duplicateReviewer = { ...validRecord(2), reviewer: "unfamiliar-team-1" };
  const duplicateRepo = { ...validRecord(3), representativeRepository: "owner/repo-1" };
  const duplicateEvidence = { ...validRecord(3), evidenceBundleRef: "dry-run-evidence/job-1-audit.json" };

  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validRecord(1), duplicateReviewer, duplicateRepo, duplicateEvidence],
  });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(formatted, /reviewer\/team already used by records\[0\]/);
  assert.match(formatted, /representative repository already used by records\[0\]/);
  assert.match(formatted, /dry-run evidence bundle already used by records\[0\]/);
});

test("product gate rejects template placeholder data", () => {
  const placeholder = {
    ...validRecord(1),
    reviewer: "team-or-maintainer-label",
    representativeRepository: "owner/repository-or-internal-repo-label",
    evidenceBundleRef: "example: dry-run-evidence/job-id-audit.json",
    trustObjections: ["example: unclear whether provider token was used"],
    blockedFinalizerReasonCategories: ["example: missing completion gate"],
  };

  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [placeholder, validRecord(2), validRecord(3)],
  });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(formatted, /records\[0\]\.reviewer: must be real observed product validation data/);
  assert.match(formatted, /records\[0\]\.representativeRepository: must be real observed product validation data/);
  assert.match(formatted, /records\[0\]\.evidenceBundleRef: must be real observed product validation data/);
  assert.match(formatted, /records\[0\]\.trustObjections\[0\]: must be real observed product validation data/);
  assert.match(formatted, /records\[0\]\.blockedFinalizerReasonCategories\[0\]: must be real observed product validation data/);
});

test("product gate validates supplemental official score bundle content", async () => {
  const root = await tempRoot("cpb-product-gate-official-score");
  const evidenceFile = path.join(root, "product-gate.json");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  await mkdir(path.dirname(scoreBundle), { recursive: true });
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-1-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-2-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-3-audit.json"), "{}\n", "utf8");
  await writeJson(scoreBundle, validOfficialScoreBundle());
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records,
    supplementalOfficialScoreBundles: [
      {
        validationMode: "swe-bench-verified-official-score-bundle",
        evidenceBundleRef: "evidence/official-score.json",
      },
    ],
  });

  const result = await verifyProductGateEvidenceFile(JSON.parse(await readFile(evidenceFile, "utf8")), { root });

  assert.equal(result.ok, true);
  assert.equal(result.recordCount, 3);
  assert.equal(result.supplementalOfficialScoreBundleCount, 1);
  assert.deepEqual(result.violations, []);
});

test("product gate rejects supplemental official score bundles with unresolved scorer evidence", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-fail");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  await mkdir(path.dirname(scoreBundle), { recursive: true });
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-1-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-2-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "swe-bench-3-audit.json"), "{}\n", "utf8");
  await writeJson(scoreBundle, {
    ...validOfficialScoreBundle(),
    officialReport: {
      totals: {
        submitted_instances: 4,
        completed_instances: 4,
        resolved_instances: 3,
        unresolved_instances: 1,
        empty_patch_instances: 0,
        error_instances: 0,
      },
    },
    scoredReportSummary: {
      ...validOfficialScoreBundle().scoredReportSummary,
      scorerResolved: 3,
      scorerUnresolved: 1,
    },
  });
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));

  const result = await verifyProductGateEvidenceFile({
    schemaVersion: 1,
    records,
    supplementalOfficialScoreBundles: [
      {
        validationMode: "swe-bench-verified-official-score-bundle",
        evidenceBundleRef: "evidence/official-score.json",
      },
    ],
  }, { root });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(formatted, /resolved_instances: must equal submitted_instances/);
  assert.match(formatted, /scorerResolved: must equal scorerRequired/);
  assert.match(formatted, /scorerUnresolved: must be 0/);
});

test("product gate CLI validates an explicit evidence file", async () => {
  const root = await tempRoot("cpb-product-gate-pass");
  const evidenceFile = path.join(root, "product-gate.json");
  await mkdir(path.join(root, "dry-run-evidence"), { recursive: true });
  await writeFile(path.join(root, "dry-run-evidence", "job-1-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "job-2-audit.json"), "{}\n", "utf8");
  await writeFile(path.join(root, "dry-run-evidence", "job-3-audit.json"), "{}\n", "utf8");
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  });

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--file", evidenceFile], {
    cwd: root,
    timeout: 10_000,
  });

  assert.match(stdout, /Product gate passed with 3 dry-run validation records/);
});

test("product gate CLI rejects missing local evidence bundle refs", async () => {
  const root = await tempRoot("cpb-product-gate-missing-bundle");
  const evidenceFile = path.join(root, "docs", "product", "cpb-flagship-product-validation.json");
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  });

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "--file", evidenceFile], {
      cwd: root,
      timeout: 10_000,
    }),
    (error: any) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.equal(error.code, 1);
      assert.match(output, /records\[0\]\.evidenceBundleRef: local evidence bundle path does not exist/);
      assert.match(output, /dry-run-evidence\/job-1-audit\.json/);
      return true;
    },
  );
});

test("product gate CLI permits URL evidence bundle refs", async () => {
  const root = await tempRoot("cpb-product-gate-url-bundle");
  const evidenceFile = path.join(root, "product-gate.json");
  const records = [validRecord(1), validRecord(2), validRecord(3)].map((record, index) => ({
    ...record,
    evidenceBundleRef: `https://example.invalid/cpb/evidence/job-${index + 1}.json`,
  }));
  await writeJson(evidenceFile, { schemaVersion: 1, records });

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--file", evidenceFile], {
    cwd: root,
    timeout: 10_000,
  });

  assert.match(stdout, /Product gate passed with 3 dry-run validation records/);
});

test("product gate CLI fails when the default evidence file is absent", async () => {
  const root = await tempRoot("cpb-product-gate-missing");
  await mkdir(path.join(root, "docs", "product"), { recursive: true });
  await writeFile(path.join(root, "docs", "product", "placeholder.txt"), "no evidence\n", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath], {
      cwd: root,
      timeout: 10_000,
    }),
    (error: any) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.equal(error.code, 1);
      assert.match(output, /Product gate evidence file is missing/);
      assert.match(output, /cpb-flagship-product-validation\.json/);
      return true;
    },
  );
});
