import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
const CLI_TIMEOUT_MS = 30_000;

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

function validDryRunBundleForRecord(record: any) {
  if (record.validationMode === "swe-bench-verified") {
    return {
      schemaVersion: 1,
      validationMode: "swe-bench-verified",
      validatedAt: record.validatedAt,
      source: {
        dataset: record.benchmarkDataset,
        split: record.benchmarkSplit,
        datasetRowsApi: record.datasetRowRef,
      },
      sample: {
        instanceId: record.benchmarkInstanceId,
        repository: record.representativeRepository,
        baseCommit: record.baseCommit,
        problemStatementSha256: record.problemStatementSha256,
        failToPassTests: record.failToPassTests,
        passToPassTests: record.passToPassTests,
      },
      cpbDryRunEvidence: {
        dryRunFinalizerStatus: record.dryRunFinalizerStatus,
        draftPrPreview: record.draftPrPreview,
        noLiveSideEffects: record.noLiveSideEffects,
        prBodyRequiredManualReconstruction: record.prBodyRequiredManualReconstruction,
      },
    };
  }
  return {
    schemaVersion: 1,
    validationMode: "maintainer-dry-run",
    validatedAt: record.validatedAt,
    reviewer: record.reviewer,
    representativeRepository: record.representativeRepository,
    cpbDryRunEvidence: {
      dryRunFinalizerStatus: record.dryRunFinalizerStatus,
      draftPrPreview: record.draftPrPreview,
      noLiveSideEffects: record.noLiveSideEffects,
      prBodyRequiredManualReconstruction: record.prBodyRequiredManualReconstruction,
    },
  };
}

async function writeDryRunBundles(root: string, records: any[]) {
  await Promise.all(records.map(async (record) => {
    await writeJson(path.join(root, record.evidenceBundleRef), validDryRunBundleForRecord(record));
  }));
}

function sha256Hex(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function jsonArtifact(value: any) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const officialScoreInstanceIds = [
  "django__django-13343",
  "django__django-13346",
  "django__django-13363",
  "django__django-13401",
];

function officialPatchContent(instanceId: string) {
  return `diff --git a/${instanceId}.py b/${instanceId}.py\n--- a/${instanceId}.py\n+++ b/${instanceId}.py\n@@ -1 +1 @@\n-old\n+new\n`;
}

function validOfficialScoreBundle(artifactBase = "evidence/official-score-artifacts") {
  const totals = {
    submitted_instances: 4,
    completed_instances: 4,
    resolved_instances: 4,
    unresolved_instances: 0,
    empty_patch_instances: 0,
    error_instances: 0,
  };
  const samples = officialScoreInstanceIds.map((instanceId, index) => {
    const patch = officialPatchContent(instanceId);
    return {
      instanceId,
      repository: "django/django",
      baseCommit: `${index + 1}`.repeat(40),
      sourcePatch: {
        path: `${artifactBase}/patches/${instanceId}.patch`,
        bytes: Buffer.byteLength(patch),
        sha256: sha256Hex(patch),
        sourceOnly: true,
      },
      officialResult: {
        resolved: true,
        patchSuccessfullyApplied: true,
        failToPass: {
          success: index + 1,
          failure: 0,
        },
        passToPass: {
          success: index + 10,
          failure: 0,
        },
      },
    };
  });
  const aggregateReport = {
    ...totals,
    resolved_ids: officialScoreInstanceIds,
    unresolved_ids: [],
    error_ids: [],
  };
  const officialScoreSummary = {
    totals,
    resolved_ids: officialScoreInstanceIds,
    unresolved_ids: [],
    error_ids: [],
    instances: samples.map((sample) => ({
      instance_id: sample.instanceId,
      resolved: sample.officialResult.resolved,
      patch_successfully_applied: sample.officialResult.patchSuccessfullyApplied,
      fail_to_pass_success: sample.officialResult.failToPass.success,
      fail_to_pass_failure: sample.officialResult.failToPass.failure,
      pass_to_pass_success: sample.officialResult.passToPass.success,
      pass_to_pass_failure: sample.officialResult.passToPass.failure,
    })),
  };
  const sourcePatchManifest = {
    records: samples.map((sample) => ({
      instance_id: sample.instanceId,
      patchPath: sample.sourcePatch.path,
      bytes: sample.sourcePatch.bytes,
      sourceOnly: true,
    })),
  };
  const predictionJsonl = samples.map((sample) => JSON.stringify({
    instance_id: sample.instanceId,
    model_name_or_path: "codepatchbay-codex-real-run",
    model_patch: officialPatchContent(sample.instanceId),
  })).join("\n") + "\n";
  const artifactFiles = [
    {
      role: "aggregate-report",
      path: `${artifactBase}/aggregate-report.json`,
      content: jsonArtifact(aggregateReport),
    },
    {
      role: "official-score-summary",
      path: `${artifactBase}/official-score-summary.json`,
      content: jsonArtifact(officialScoreSummary),
    },
    {
      role: "source-patch-manifest",
      path: `${artifactBase}/source-patch-manifest.json`,
      content: jsonArtifact(sourcePatchManifest),
    },
    {
      role: "prediction-jsonl",
      path: `${artifactBase}/prediction.jsonl`,
      content: predictionJsonl,
    },
    ...samples.map((sample) => ({
      role: "source-patch",
      instanceId: sample.instanceId,
      path: sample.sourcePatch.path,
      content: officialPatchContent(sample.instanceId),
    })),
  ];
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
      totals,
      resolvedIds: officialScoreInstanceIds,
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
    samples,
    auditArtifacts: artifactFiles.map(({ content, ...artifact }) => ({
      ...artifact,
      bytes: Buffer.byteLength(content),
      sha256: sha256Hex(content),
    })),
    __artifactFiles: artifactFiles,
  };
}

async function writeOfficialScoreBundle(root: string, bundlePath: string, bundle = validOfficialScoreBundle()) {
  const { __artifactFiles, ...jsonBundle } = bundle;
  await Promise.all(__artifactFiles.map(async (artifact: any) => {
    await mkdir(path.dirname(path.join(root, artifact.path)), { recursive: true });
    await writeFile(path.join(root, artifact.path), artifact.content, "utf8");
  }));
  await writeJson(bundlePath, jsonBundle);
  return jsonBundle;
}

test("product gate accepts three unfamiliar dry-run validation records", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validRecord(1), validRecord(2), validRecord(3)],
  }, {
    referenceTime: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.recordCount, 3);
  assert.deepEqual(result.violations, []);
});

test("product gate accepts SWE-bench Verified dry-run sample records without maintainer feedback fields", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)],
  }, {
    referenceTime: "2026-07-01T00:00:00.000Z",
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
  }, {
    referenceTime: "2026-07-01T00:00:00.000Z",
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
  await writeOfficialScoreBundle(root, scoreBundle);
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeDryRunBundles(root, records);
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

test("product gate rejects supplemental official score bundles without audit artifacts", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-no-artifacts");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  const { __artifactFiles: _artifactFiles, auditArtifacts: _auditArtifacts, ...bundleWithoutArtifacts } = validOfficialScoreBundle();
  await writeJson(scoreBundle, bundleWithoutArtifacts);
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeDryRunBundles(root, records);

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
  assert.match(formatProductGateViolations(result.violations), /auditArtifacts: must include repo-local official scorer artifacts/);
});

test("product gate rejects tampered official score artifact hashes", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-tampered");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  await writeOfficialScoreBundle(root, scoreBundle);
  await writeFile(path.join(root, "evidence", "official-score-artifacts", "aggregate-report.json"), "{}\n", "utf8");
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeDryRunBundles(root, records);

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
  assert.match(formatted, /auditArtifacts\[0\]\.bytes: must match artifact bytes/);
  assert.match(formatted, /auditArtifacts\[0\]\.sha256: must match the repo-local artifact content/);
});

test("product gate rejects missing source patch artifacts", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-missing-patch");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  const bundle = validOfficialScoreBundle();
  bundle.auditArtifacts = bundle.auditArtifacts.filter((artifact: any) => artifact.instanceId !== "django__django-13401");
  bundle.__artifactFiles = bundle.__artifactFiles.filter((artifact: any) => artifact.instanceId !== "django__django-13401");
  await writeOfficialScoreBundle(root, scoreBundle, bundle);
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeDryRunBundles(root, records);

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
  assert.match(
    formatProductGateViolations(result.violations),
    /auditArtifacts: must include source-patch artifact for django__django-13401/,
  );
});

test("product gate rejects empty local dry-run evidence bundles", async () => {
  const root = await tempRoot("cpb-product-gate-empty-bundle");
  const records = [validRecord(1), validRecord(2), validRecord(3)];
  await writeJson(path.join(root, records[0].evidenceBundleRef), {});
  await writeJson(path.join(root, records[1].evidenceBundleRef), validDryRunBundleForRecord(records[1]));
  await writeJson(path.join(root, records[2].evidenceBundleRef), validDryRunBundleForRecord(records[2]));

  const result = await verifyProductGateEvidenceFile({
    schemaVersion: 1,
    records,
  }, { root, referenceTime: "2026-07-01T00:00:00.000Z" });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(formatted, /records\[0\]\.evidenceBundle\.schemaVersion: must match records entry value 1/);
  assert.match(formatted, /records\[0\]\.evidenceBundle\.cpbDryRunEvidence: must include CPB dry-run finalizer evidence/);
});

test("product gate rejects dry-run evidence bundle symlinks that resolve outside the repo root", async () => {
  const root = await tempRoot("cpb-product-gate-symlink-bundle");
  const outsideRoot = await tempRoot("cpb-product-gate-symlink-outside");
  const records = [validRecord(1), validRecord(2), validRecord(3)];
  const outsideBundle = path.join(outsideRoot, "escaped-job-1-audit.json");
  await writeJson(outsideBundle, validDryRunBundleForRecord(records[0]));
  await mkdir(path.dirname(path.join(root, records[0].evidenceBundleRef)), { recursive: true });
  await symlink(outsideBundle, path.join(root, records[0].evidenceBundleRef));
  await writeJson(path.join(root, records[1].evidenceBundleRef), validDryRunBundleForRecord(records[1]));
  await writeJson(path.join(root, records[2].evidenceBundleRef), validDryRunBundleForRecord(records[2]));

  const result = await verifyProductGateEvidenceFile({
    schemaVersion: 1,
    records,
  }, { root, referenceTime: "2026-07-01T00:00:00.000Z" });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(
    formatted,
    /records\[0\]\.evidenceBundleRef: local dry-run evidence bundle path must stay inside the repository root after symlink resolution: dry-run-evidence\/job-1-audit\.json/,
  );
  assert.doesNotMatch(formatted, /escaped-job-1-audit\.json/);
});

test("product gate rejects dry-run evidence bundles that do not match their summary record", async () => {
  const root = await tempRoot("cpb-product-gate-mismatched-bundle");
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)];
  await writeJson(path.join(root, records[0].evidenceBundleRef), {
    ...validDryRunBundleForRecord(records[0]),
    sample: {
      ...validDryRunBundleForRecord(records[0]).sample,
      instanceId: "wrong__instance-1",
      repository: "wrong/repo",
    },
  });
  await writeJson(path.join(root, records[1].evidenceBundleRef), validDryRunBundleForRecord(records[1]));
  await writeJson(path.join(root, records[2].evidenceBundleRef), validDryRunBundleForRecord(records[2]));

  const result = await verifyProductGateEvidenceFile({
    schemaVersion: 1,
    records,
  }, { root, referenceTime: "2026-07-01T00:00:00.000Z" });

  assert.equal(result.ok, false);
  const formatted = formatProductGateViolations(result.violations);
  assert.match(formatted, /records\[0\]\.evidenceBundle\.sample\.instanceId: must match records entry value "verified-owner__repo-1"/);
  assert.match(formatted, /records\[0\]\.evidenceBundle\.sample\.repository: must match records entry value "owner\/repo-1"/);
});

test("product gate rejects stale dry-run product evidence", () => {
  const result = verifyProductGateEvidence({
    schemaVersion: 1,
    records: [
      { ...validRecord(1), validatedAt: "2026-01-01T00:00:00.000Z" },
      validRecord(2),
      validRecord(3),
    ],
  }, {
    referenceTime: "2026-07-01T00:00:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.match(
    formatProductGateViolations(result.violations),
    /records\[0\]\.validatedAt: must be no older than 90 days/,
  );
});

test("product gate rejects supplemental official score bundles with unresolved scorer evidence", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-fail");
  const scoreBundle = path.join(root, "evidence", "official-score.json");
  await writeOfficialScoreBundle(root, scoreBundle, {
    ...validOfficialScoreBundle(),
    officialReport: {
      ...validOfficialScoreBundle().officialReport,
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
  await writeDryRunBundles(root, records);

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

test("product gate rejects supplemental official score bundle symlinks that resolve outside the repo root", async () => {
  const root = await tempRoot("cpb-product-gate-official-score-symlink");
  const outsideRoot = await tempRoot("cpb-product-gate-official-score-outside");
  const scoreBundle = path.join(outsideRoot, "official-score.json");
  await writeJson(scoreBundle, validOfficialScoreBundle());
  await mkdir(path.join(root, "evidence"), { recursive: true });
  await symlink(scoreBundle, path.join(root, "evidence", "official-score.json"));
  const records = [validSweBenchRecord(1), validSweBenchRecord(2), validSweBenchRecord(3)]
    .map((record, index) => ({
      ...record,
      evidenceBundleRef: `dry-run-evidence/swe-bench-${index + 1}-audit.json`,
    }));
  await writeDryRunBundles(root, records);

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
  assert.match(
    formatted,
    /supplementalOfficialScoreBundles\[0\]\.evidenceBundleRef: local official-score bundle path must stay inside the repository root after symlink resolution: evidence\/official-score\.json/,
  );
  assert.doesNotMatch(formatted, /cpb-product-gate-official-score-outside/);
});

test("product gate CLI validates an explicit evidence file", async () => {
  const root = await tempRoot("cpb-product-gate-pass");
  const evidenceFile = path.join(root, "product-gate.json");
  const records = [validRecord(1), validRecord(2), validRecord(3)];
  await writeDryRunBundles(root, records);
  await writeJson(evidenceFile, {
    schemaVersion: 1,
    records,
  });

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--file", evidenceFile], {
    cwd: root,
    timeout: CLI_TIMEOUT_MS,
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
      timeout: CLI_TIMEOUT_MS,
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

test("product gate CLI rejects URL evidence bundle refs because release gates cannot audit remote content", async () => {
  const root = await tempRoot("cpb-product-gate-url-bundle");
  const evidenceFile = path.join(root, "product-gate.json");
  const records = [validRecord(1), validRecord(2), validRecord(3)].map((record, index) => ({
    ...record,
    evidenceBundleRef: `https://example.invalid/cpb/evidence/job-${index + 1}.json`,
  }));
  await writeJson(evidenceFile, { schemaVersion: 1, records });

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath, "--file", evidenceFile], {
      cwd: root,
      timeout: CLI_TIMEOUT_MS,
    }),
    (error: any) => {
      const output = `${error.stdout || ""}\n${error.stderr || ""}`;
      assert.equal(error.code, 1);
      assert.match(output, /records\[0\]\.evidenceBundleRef: must be a local repo-relative dry-run evidence bundle/);
      return true;
    },
  );
});

test("product gate CLI fails when the default evidence file is absent", async () => {
  const root = await tempRoot("cpb-product-gate-missing");
  await mkdir(path.join(root, "docs", "product"), { recursive: true });
  await writeFile(path.join(root, "docs", "product", "placeholder.txt"), "no evidence\n", "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [cliPath], {
      cwd: root,
      timeout: CLI_TIMEOUT_MS,
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
