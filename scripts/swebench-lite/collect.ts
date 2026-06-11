#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseArgs,
  pathExists,
  predictionFromBundle,
  publicTraceFromBundle,
  readJson,
  repoRoot,
  runCommand,
  terminalStatus,
  usageError,
  writeJson,
  writeJsonLines,
} from "./lib.js";

function usage() {
  return `Usage: node scripts/swebench-lite/collect.js --run-dir <dir> [options]

Collect completed CPB review bundles and generate SWE-bench prediction/traj files.

Options:
  --run-dir <dir>         Run directory containing manifest.json (required)
  --cpb-bin <path>        CPB CLI path (default: ./cpb)
  --model-name <name>     model_name_or_path in predictions (default: manifest run id)
  --wait                  Poll until all jobs reach a terminal state
  --poll-ms <n>           Poll interval for --wait (default: 30000)
  --timeout-ms <n>        Overall wait timeout; 0 disables timeout (default: 0)
  --allow-partial         Write predictions for collected jobs even if some are still pending
  --help                  Show this help`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    defaults: {
      cpbBin: path.join(repoRoot, "cpb"),
      wait: false,
      pollMs: 30_000,
      timeoutMs: 0,
      allowPartial: false,
    },
    types: {
      wait: "boolean",
      allowPartial: "boolean",
      pollMs: "number",
      timeoutMs: "number",
    },
  });

  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.runDir) throw usageError("--run-dir is required");

  const runDir = path.resolve(options.runDir);
  const manifestPath = path.join(runDir, "manifest.json");
  const deadline = options.timeoutMs > 0 ? Date.now() + options.timeoutMs : 0;
  let manifest = await readJson(manifestPath);

  while (true) {
    manifest = await collectOnce(manifest, runDir, options);
    await writeJson(manifestPath, manifest);
    const pending = manifest.instances.filter((entry) => !terminalStatus(entry.status));
    if (pending.length === 0 || !options.wait) break;
    if (deadline && Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pending.length} job(s)`);
    }
    console.log(`Waiting for ${pending.length} job(s): ${pending.map((entry) => entry.instanceId).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }

  const pending = manifest.instances.filter((entry) => !terminalStatus(entry.status));
  if (pending.length > 0 && !options.allowPartial) {
    throw new Error(`${pending.length} job(s) are not terminal; rerun with --wait or --allow-partial`);
  }

  const predictions = await buildPredictions(manifest, options.modelName || manifest.runId);
  await writeJsonLines(path.join(runDir, "all_preds.jsonl"), predictions);
  await writeJson(path.join(runDir, "collection-summary.json"), summarizeCollection(manifest, predictions));
  console.log(`Wrote ${path.join(runDir, "all_preds.jsonl")}`);
  console.log(`Collected ${predictions.length} prediction(s).`);
  return 0;
}

export async function collectOnce(manifest, runDir, options) {
  const next = {
    ...manifest,
    collectedAt: new Date().toISOString(),
    instances: [],
  };
  for (const entry of manifest.instances || []) {
    const updated = { ...entry };
    if (!updated.jobId) {
      updated.status = updated.status || "missing-job-id";
      next.instances.push(updated);
      continue;
    }
    if (updated.patchPath && terminalStatus(updated.status) && await pathExists(updated.patchPath)) {
      next.instances.push(updated);
      continue;
    }
    try {
      const assignmentState = await readAssignmentState(updated.queueId);
      if (assignmentState?.status && !terminalStatus(assignmentState.status)) {
        updated.status = assignmentState.status;
        delete updated.collectError;
        next.instances.push(updated);
        continue;
      }

      const jobIds = await reviewBundleJobIds(updated);
      const { bundle, jobId: bundleJobId } = await readReviewBundle(options.cpbBin, updated.projectId, jobIds);
      const jobStatus = bundle?.status?.jobStatus || "unknown";
      const prediction = predictionFromBundle(bundle, {
        instanceId: updated.instanceId,
        modelName: options.modelName || manifest.runId,
      });
      updated.status = jobStatus;
      updated.bundleJobId = bundleJobId;
      updated.bundlePath = path.join(runDir, "bundles", `${updated.instanceId}.json`);
      updated.patchPath = path.join(runDir, "patches", `${updated.instanceId}.patch`);
      updated.tracePath = path.join(runDir, "trajs", `${updated.instanceId}.md`);
      updated.patchBytes = Buffer.byteLength(prediction.model_patch || "", "utf8");
      await writeJson(updated.bundlePath, bundle);
      await mkdir(path.dirname(updated.patchPath), { recursive: true });
      await writeFile(updated.patchPath, prediction.model_patch || "", "utf8");
      await mkdir(path.dirname(updated.tracePath), { recursive: true });
      await writeFile(updated.tracePath, publicTraceFromBundle(bundle, updated), "utf8");
    } catch (err: any) {
      updated.status = updated.status || "pending";
      updated.collectError = err?.message || String(err);
    }
    next.instances.push(updated);
  }
  return next;
}

export async function buildPredictions(manifest, modelName) {
  const rows = [];
  for (const entry of manifest.instances || []) {
    if (entry.patchPath) {
      rows.push({
        instance_id: entry.instanceId,
        model_name_or_path: modelName,
        model_patch: await readFile(entry.patchPath, "utf8"),
      });
      continue;
    }
    rows.push({
      instance_id: entry.instanceId,
      model_name_or_path: modelName,
      model_patch: "",
    });
  }
  return rows;
}

async function readReviewBundle(cpbBin, projectId, jobIds) {
  let lastError;
  for (const jobId of jobIds) {
    try {
      return {
        bundle: await readReviewBundleForJobId(cpbBin, projectId, jobId),
        jobId,
      };
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error(`no job id available for ${projectId}`);
}

async function readReviewBundleForJobId(cpbBin, projectId, jobId) {
  const result = await runCommand(cpbBin, ["review-bundle", projectId, jobId, "--json"], {
    cwd: repoRoot,
    quiet: true,
  });
  const bundle = JSON.parse(result.stdout);
  if (bundle?.status?.jobStatus || bundle?.evidence?.diff) return bundle;

  const persisted = persistedReviewBundlePath(projectId, jobId);
  if (await pathExists(persisted)) return readJson(persisted);
  return bundle;
}

async function reviewBundleJobIds(entry) {
  const ids = [];
  const root = assignmentRoot(entry.queueId);
  if (root) {
    let attempts = [];
    try {
      attempts = await readdir(path.join(root, "attempts"));
    } catch {
      attempts = [];
    }

    for (const attempt of attempts.sort().reverse()) {
      const attemptRoot = path.join(root, "attempts", attempt);
      for (const file of ["heartbeat.json", "result.json", "attempt.json"]) {
        try {
          addJobIds(await readJson(path.join(attemptRoot, file)), ids);
        } catch {
          // Attempt metadata is best-effort; the original manifest job id remains a fallback.
        }
      }
    }
  }
  addJobId(entry.jobId, ids);
  return ids;
}

async function readAssignmentState(queueId) {
  const root = assignmentRoot(queueId);
  if (!root) return null;
  try {
    return await readJson(path.join(root, "state.json"));
  } catch {
    return null;
  }
}

function assignmentRoot(queueId) {
  if (!queueId) return null;
  return path.join(hubRoot(), "assignments", `a-${queueId}`);
}

function addJobIds(value, ids) {
  if (!value || typeof value !== "object") return;
  addJobId(value.activeJobId, ids);
  addJobId(value.jobId, ids);
  addJobId(value.jobResult?.activeJobId, ids);
  addJobId(value.jobResult?.jobId, ids);
  addJobId(value.failure?.cause?.activeJobId, ids);
  addJobId(value.jobResult?.failure?.cause?.activeJobId, ids);
}

function addJobId(jobId, ids) {
  if (typeof jobId === "string" && jobId && !ids.includes(jobId)) ids.push(jobId);
}

function persistedReviewBundlePath(projectId, jobId) {
  return path.join(hubRoot(), "review-bundles", projectId, `${projectId}-${jobId}-review-bundle.json`);
}

function hubRoot() {
  const home = process.env.HOME || ".";
  return process.env.CPB_HUB_ROOT || path.join(home, ".cpb");
}

function summarizeCollection(manifest, predictions) {
  const counts = {};
  for (const entry of manifest.instances || []) {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  }
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    generatedAt: new Date().toISOString(),
    totalInstances: manifest.instances?.length || 0,
    predictionCount: predictions.length,
    statusCounts: counts,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((err: any) => {
    console.error(err?.usage ? `${err.message}\n\n${usage()}` : err.stack || err.message || String(err));
    process.exitCode = 1;
  });
}
