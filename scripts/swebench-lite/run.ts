#!/usr/bin/env node
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";

import {
  buildManifest,
  loadDatasetInstances,
  parseArgs,
  parseEnqueueOutput,
  pathExists,
  projectIdForInstance,
  repoRoot,
  runCommand,
  readJson,
  slug,
  usageError,
  writeJson,
} from "./lib.js";

type AnyRecord = Record<string, any>;

function usage() {
  return `Usage: node scripts/swebench-lite/run.js --run-dir <dir> [options]

Prepare SWE-bench Lite repositories and enqueue CPB jobs through the public CLI.

Options:
  --run-dir <dir>           Output run directory (required)
  --dataset-name <name>     Hugging Face dataset (default: SWE-bench/SWE-bench_Lite)
  --dataset-path <file>     Local JSON/JSONL dataset rows instead of Hugging Face
  --split <name>            Dataset split (default: test)
  --instance-ids <ids>      Comma-separated instance ids; may be repeated
  --limit <n>               Limit loaded instances, useful for smoke runs
  --run-id <id>             Stable run id (default: directory basename)
  --project-prefix <name>   CPB project id prefix (default: swelite)
  --cpb-bin <path>          CPB CLI path (default: ./cpb)
  --agent <name>            Agent passed to cpb run, for example codex
  --workflow <name>         Workflow passed to cpb run (default: standard)
  --plan-mode <mode>        Plan mode passed to cpb run (default: light)
  --repo-cache-dir <dir>    Directory for cloned repos (default: <run-dir>/repos)
  --start-hub               Run "cpb hub start" before enqueueing
  --dry-run                 Prepare manifest without cloning or enqueueing
  --force                   Remove and reclone per-instance repo directories
  --help                    Show this help`;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, {
    defaults: {
      datasetName: "SWE-bench/SWE-bench_Lite",
      split: "test",
      projectPrefix: "swelite",
      cpbBin: path.join(repoRoot, "cpb"),
      workflow: "standard",
      planMode: "light",
      agent: "",
      limit: 0,
      dryRun: false,
      force: false,
      startHub: false,
    },
    types: {
      instanceIds: "list",
      limit: "number",
      dryRun: "boolean",
      force: "boolean",
      startHub: "boolean",
    },
  });

  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.runDir) throw usageError("--run-dir is required");

  const runDir = path.resolve(options.runDir);
  const runId = slug(options.runId || path.basename(runDir), 40);
  const repoCacheDir = path.resolve(options.repoCacheDir || path.join(runDir, "repos"));
  const manifestPath = path.join(runDir, "manifest.json");
  const existingManifest = await loadExistingManifest(manifestPath);
  const existingByInstance = new Map<string, AnyRecord>((existingManifest?.instances || []).map((entry: AnyRecord) => [entry.instanceId, entry]));
  const instances = await loadDatasetInstances({
    datasetName: options.datasetName,
    datasetPath: options.datasetPath,
    split: options.split,
    instanceIds: options.instanceIds || [],
    limit: options.limit,
  });

  if (instances.length === 0) {
    throw new Error("no SWE-bench instances selected");
  }

  if (options.startHub && !options.dryRun) {
    await runCommand(options.cpbBin, ["hub", "start"], { cwd: repoRoot });
  }

  const manifestInstances = [];
  for (const instance of instances) {
    const existing = existingByInstance.get(instance.instanceId);
    if (existing?.jobId && !options.force) {
      manifestInstances.push(existing);
      await writeJson(manifestPath, buildManifest({
        runId,
        datasetName: options.datasetName,
        split: options.split,
        runDir,
        instances: manifestInstances,
      }));
      console.log(`Reusing ${instance.instanceId}: ${existing.jobId}`);
      continue;
    }

    const projectId = projectIdForInstance(instance.instanceId, {
      prefix: options.projectPrefix,
      runId,
    });
    const repoDir = path.join(repoCacheDir, instance.instanceId);
    const manifestEntry = {
      ...instance,
      projectId,
      repoDir,
      queueId: null,
      jobId: null,
      status: options.dryRun ? "planned" : "pending",
      enqueuedAt: null,
    };

    if (!options.dryRun) {
      await prepareRepo(instance, repoDir, { force: options.force });
      await initProject(options.cpbBin, repoDir, projectId);
      const enqueue = await enqueueTask(options.cpbBin, projectId, instance.problemStatement, options);
      Object.assign(manifestEntry, {
        queueId: enqueue.queueId,
        jobId: enqueue.jobId,
        status: "enqueued",
        enqueuedAt: new Date().toISOString(),
      });
    }

    manifestInstances.push(manifestEntry);
    const manifest = buildManifest({
      runId,
      datasetName: options.datasetName,
      split: options.split,
      runDir,
      instances: manifestInstances,
    });
    await writeJson(manifestPath, manifest);
  }

  console.log(`Wrote ${manifestPath}`);
  console.log(`Selected ${manifestInstances.length} SWE-bench instance(s).`);
  if (options.dryRun) {
    console.log("Dry run only; no repos cloned and no CPB jobs enqueued.");
  }
  return 0;
}

async function prepareRepo(instance, repoDir, { force }) {
  if (force) {
    await rm(repoDir, { recursive: true, force: true });
  }
  await mkdir(path.dirname(repoDir), { recursive: true });
  if (!(await pathExists(path.join(repoDir, ".git")))) {
    await runCommand("git", ["clone", "--filter=blob:none", "--no-checkout", `https://github.com/${instance.repo}.git`, repoDir], {
      quiet: false,
    });
  }
  await runCommand("git", ["checkout", instance.baseCommit], { cwd: repoDir });
}

async function initProject(cpbBin, repoDir, projectId) {
  try {
    await runCommand(cpbBin, ["init", repoDir, projectId], { cwd: repoRoot });
  } catch (err: any) {
    const output = `${err.result?.stdout || ""}\n${err.result?.stderr || ""}`;
    if (output.includes(`'${projectId}' already exists`) || output.includes(`${projectId} already exists`)) {
      console.log(`Reusing existing CPB project ${projectId}`);
      return;
    }
    throw err;
  }
}

async function enqueueTask(cpbBin, projectId, problemStatement, options) {
  const args = ["run", "--project", projectId, "--workflow", options.workflow, "--plan-mode", options.planMode];
  if (options.agent) args.push("--agent", options.agent);
  args.push(problemStatement);
  const result = await runCommand(cpbBin, args, { cwd: repoRoot });
  const parsed = parseEnqueueOutput(result.stdout);
  if (!parsed) {
    throw new Error(`could not parse cpb run output: ${result.stdout.trim()}`);
  }
  if (parsed.projectId !== projectId) {
    throw new Error(`cpb enqueued project ${parsed.projectId}, expected ${projectId}`);
  }
  return parsed;
}

async function loadExistingManifest(manifestPath) {
  if (!(await pathExists(manifestPath))) return null;
  return readJson(manifestPath);
}

main().then((code) => {
  process.exitCode = code;
}).catch((err: any) => {
  console.error(err?.usage ? `${err.message}\n\n${usage()}` : err.stack || err.message || String(err));
  process.exitCode = 1;
});
