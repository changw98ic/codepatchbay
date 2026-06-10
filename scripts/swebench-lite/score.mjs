#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  parseArgs,
  pathExists,
  readJson,
  usageError,
  writeJson,
} from "./lib.mjs";

function usage() {
  return `Usage: node scripts/swebench-lite/score.mjs --run-dir <dir> [options]

Summarize SWE-bench evaluation results for a CPB run.

Options:
  --run-dir <dir>        Run directory containing manifest/all_preds/report files (required)
  --report-path <file>   Explicit official SWE-bench JSON report to score
  --json                 Print machine-readable summary
  --help                 Show this help`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    defaults: {
      json: false,
    },
    types: {
      json: "boolean",
    },
  });

  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.runDir) throw usageError("--run-dir is required");

  const summary = await scoreRunDir(path.resolve(options.runDir), {
    reportPath: options.reportPath ? path.resolve(options.reportPath) : "",
  });
  await writeJson(path.join(summary.runDir, "score-summary.json"), summary);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHuman(summary);
  }
  return 0;
}

export async function scoreRunDir(runDir, options = {}) {
  const manifest = await readOptionalJson(path.join(runDir, "manifest.json"));
  const predictionsPath = path.join(runDir, "all_preds.jsonl");
  const predictions = await readOptionalJsonLines(predictionsPath);
  const predictionCount = predictions.length;
  const nonEmptyPatchCount = predictions.filter((row) => String(row.model_patch || "").trim()).length;

  const reportCandidates = options.reportPath
    ? [options.reportPath]
    : await findJsonFiles(runDir);

  let official = null;
  const instanceReports = [];
  for (const candidate of reportCandidates) {
    if (candidate.endsWith("manifest.json") || candidate.endsWith("collection-summary.json") || candidate.endsWith("score-summary.json")) {
      continue;
    }
    const parsed = await readOptionalJson(candidate);
    if (!parsed) continue;
    const extracted = extractOfficialScore(parsed, {
      sourcePath: candidate,
      fallbackTotal: manifest?.instances?.length || predictionCount,
    });
    if (extracted) {
      if (extracted.kind === "aggregate") {
        official = extracted;
        break;
      }
      instanceReports.push(extracted);
    }
  }
  if (!official && instanceReports.length > 0) {
    official = combineInstanceReports(instanceReports, runDir);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runDir,
    runId: manifest?.runId || path.basename(runDir),
    datasetName: manifest?.datasetName || null,
    split: manifest?.split || null,
    totalInstances: manifest?.instances?.length || predictionCount,
    predictionCount,
    nonEmptyPatchCount,
    officialScoreAvailable: Boolean(official),
    officialScore: official,
    workflowGateCompliance: computeWorkflowGateCompliance(manifest),
    instanceGateReports: buildInstanceGateReports(manifest, official),
    note: official
      ? null
      : "No official SWE-bench JSON report was found. nonEmptyPatchCount is a prediction coverage metric, not a benchmark score.",
  };
}

function printHuman(summary) {
  console.log(`Run: ${summary.runId}`);
  if (summary.datasetName) console.log(`Dataset: ${summary.datasetName}/${summary.split || "test"}`);
  console.log(`Predictions: ${summary.predictionCount}/${summary.totalInstances}`);
  console.log(`Non-empty patches: ${summary.nonEmptyPatchCount}/${summary.totalInstances}`);
  if (!summary.officialScoreAvailable) {
    console.log("Official score: unavailable");
    console.log(summary.note);
    return;
  }

  const score = summary.officialScore;
  console.log(`Official score: ${score.resolved}/${score.total} (${formatPercent(score.rate)})`);
  console.log(`Report: ${score.sourcePath}`);

  const gates = summary.workflowGateCompliance;
  if (gates) {
    console.log("");
    console.log("Workflow gate compliance:");
    console.log(`  Enforced (verify ran): ${gates.enforced}/${gates.totalWithPhases}`);
    console.log(`  Verify skipped:        ${gates.verifySkipped}`);
    console.log(`  Gate rate:             ${formatPercent(gates.gateRate)}`);
  }
}

function extractOfficialScore(value, context) {
  const direct = extractDirectScore(value, context);
  if (direct) return direct;
  const instanceStatus = extractInstanceStatusScore(value, context);
  if (instanceStatus) return instanceStatus;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractOfficialScore(item, context);
      if (nested) return nested;
    }
    return null;
  }

  if (!value || typeof value !== "object") return null;
  for (const nested of Object.values(value)) {
    if (!nested || typeof nested !== "object") continue;
    const score = extractOfficialScore(nested, context);
    if (score) return score;
  }
  return null;
}

function extractDirectScore(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const resolved = countField(value, [
    "resolved_instances",
    "resolvedInstances",
    "resolved_ids",
    "resolvedIds",
  ]);
  if (resolved === null) return null;

  const total = numberField(value, [
    "submitted_instances",
    "submittedInstances",
    "completed_instances",
    "completedInstances",
    "total_instances",
    "totalInstances",
    "total",
  ]) ?? context.fallbackTotal;
  if (!Number.isFinite(total) || total <= 0) return null;

  return {
    kind: "aggregate",
    sourcePath: context.sourcePath,
    resolved,
    total,
    rate: resolved / total,
  };
}

function extractInstanceStatusScore(value, context) {
  const statuses = collectInstanceStatuses(value);
  if (statuses.length === 0) return null;

  const byId = new Map();
  statuses.forEach((entry, index) => {
    const id = entry.instanceId || `${context.sourcePath}#${index}`;
    byId.set(id, Boolean(entry.resolved));
  });
  const values = [...byId.values()];
  const resolved = values.filter(Boolean).length;
  const total = values.length;
  if (total <= 0) return null;
  return {
    kind: "instance-results",
    sourcePath: context.sourcePath,
    resolved,
    total,
    rate: resolved / total,
    results: [...byId.entries()].map(([instanceId, isResolved]) => ({
      instanceId,
      resolved: isResolved,
    })),
  };
}

function collectInstanceStatuses(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectInstanceStatuses(item));
  }

  if (typeof value.resolved === "boolean") {
    return [{
      instanceId: typeof value.instance_id === "string"
        ? value.instance_id
        : typeof value.instanceId === "string"
          ? value.instanceId
          : null,
      resolved: value.resolved,
    }];
  }

  const entries = [];
  for (const [key, nested] of Object.entries(value)) {
    if (!nested || typeof nested !== "object") continue;
    if (typeof nested.resolved === "boolean") {
      entries.push({
        instanceId: typeof nested.instance_id === "string"
          ? nested.instance_id
          : typeof nested.instanceId === "string"
            ? nested.instanceId
            : key,
        resolved: nested.resolved,
      });
    }
  }
  if (entries.length > 0) return entries;

  return Object.values(value).flatMap((nested) => collectInstanceStatuses(nested));
}

function combineInstanceReports(reports, runDir) {
  const byId = new Map();
  for (const report of reports) {
    for (const result of report.results || []) {
      byId.set(result.instanceId, Boolean(result.resolved));
    }
  }
  const values = [...byId.values()];
  const resolved = values.filter(Boolean).length;
  const total = values.length;
  return {
    kind: "instance-results",
    sourcePath: reports.length === 1 ? reports[0].sourcePath : runDir,
    sourcePaths: reports.map((report) => report.sourcePath),
    resolved,
    total,
    rate: total > 0 ? resolved / total : 0,
  };
}

function countField(value, keys) {
  for (const key of keys) {
    if (!(key in value)) continue;
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) return field;
    if (Array.isArray(field)) return field.length;
    if (field && typeof field === "object") return Object.keys(field).length;
  }
  return null;
}

function numberField(value, keys) {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) return field;
  }
  return null;
}

async function findJsonFiles(root) {
  const files = [];
  await walk(root, files);
  return files;
}

async function walk(dir, files) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
}

async function readOptionalJson(filePath) {
  if (!(await pathExists(filePath))) return null;
  try {
    return await readJson(filePath);
  } catch {
    return null;
  }
}

async function readOptionalJsonLines(filePath) {
  if (!(await pathExists(filePath))) return [];
  const text = await readFile(filePath, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function computeWorkflowGateCompliance(manifest) {
  const instances = manifest?.instances || [];
  if (instances.length === 0) return null;

  let totalWithPhases = 0;
  let enforced = 0;
  let verifySkipped = 0;
  let enforcedPass = 0;
  let enforcedFail = 0;

  for (const entry of instances) {
    const phases = entry.completedPhases;
    if (!phases) continue;
    totalWithPhases += 1;
    const hasVerify = phases.includes("verify");
    if (hasVerify) {
      enforced += 1;
      if (entry.verdictStatus === "PASS") enforcedPass += 1;
      if (entry.verdictStatus === "FAIL" || entry.verdictStatus === "PARTIAL") enforcedFail += 1;
    } else {
      verifySkipped += 1;
    }
  }

  if (totalWithPhases === 0) return null;
  return {
    totalWithPhases,
    enforced,
    enforcedPass,
    enforcedFail,
    verifySkipped,
    gateRate: enforced / totalWithPhases,
  };
}

function buildInstanceGateReports(manifest, officialScore) {
  const instances = manifest?.instances || [];
  const officialResults = new Map();
  if (officialScore?.results) {
    for (const r of officialScore.results) {
      officialResults.set(r.instanceId, r);
    }
  }

  return instances.map((entry) => {
    const official = officialResults.get(entry.instanceId);
    const phases = entry.completedPhases || [];
    const repairRecommended = Boolean(
      entry.workflowGateStatus === "verify-skipped"
      || entry.workflowGateStatus === "failed-before-verify"
      || (official && !official.resolved && entry.verdictStatus !== "PASS"),
    );

    return {
      instanceId: entry.instanceId,
      cpbProjectId: entry.projectId || null,
      queueId: entry.queueId || null,
      jobId: entry.jobId || null,
      workflow: entry.workflow || null,
      planMode: entry.planMode || null,
      riskLevel: entry.riskLevel || null,
      verificationDepth: entry.verificationDepth || null,
      adversarialRequired: entry.adversarialRequired || null,
      completedPhases: phases,
      workflowGateStatus: entry.workflowGateStatus || null,
      verdictStatus: entry.verdictStatus || null,
      adversarialVerdictStatus: entry.adversarialVerdictStatus || null,
      officialResolved: official?.resolved ?? null,
      officialFailToPass: null,
      officialPassToPass: null,
      repairRecommended,
    };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err?.usage ? `${err.message}\n\n${usage()}` : err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
