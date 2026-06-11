#!/usr/bin/env node
// run-pipeline.js — CLI shim for the pipeline orchestrator
// Delegates to engine-runner.runJobWithServices() for the actual state machine.
//
// Usage: node bridges/run-pipeline.js --project <name> --task "<desc>" [--source-path <repo>] [--max-retries N] [--timeout-min M]

import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { getProject, resolveHubRoot } from "../server/services/hub/hub-registry.js";
import { parseVerdictEnvelope } from "../core/workflow/verdict.js";
import {
  dispatchEnabled,
  guardSourcePath as guardDispatchSourcePath,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/dispatch/dispatch.js";
import { buildMeta, executionBoundaryEvent } from "../core/job/meta.js";
import { executorEnv, executorMetadata, resolveExecutorRoot } from "../server/services/setup.js";
import { runJobWithServices } from "../server/services/setup.js";

// ─── CLI arg parsing ───

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = new Map();

  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    options.set(name, value);
    i++;
  }

  const project = options.get("--project");
  const task = options.get("--task");

  if (!project || !task) {
    throw new Error("Usage: node bridges/run-pipeline.js --project <name> --task \"<desc>\" [--source-path <repo>] [--max-retries N] [--timeout-min M] [--workflow standard|blocked]");
  }

  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`Invalid project name: '${project}' (alphanumeric + hyphens only)`);
  }

  const maxRetries = Math.max(1, parseInt(options.get("--max-retries") || "3", 10) || 3);
  const timeoutMin = Math.max(0, parseInt(options.get("--timeout-min") || "0", 10) || 0);
  const workflow = options.get("--workflow") || "standard";

  const jobIdOverride = options.get("--job-id") || null;
  const dispatchId = options.get("--dispatch-id") || null;
  const sourcePath = options.get("--source-path") ? path.resolve(options.get("--source-path")) : null;

  return { project, task, maxRetries, timeoutMin, workflow, jobIdOverride, dispatchId, sourcePath };
}

// ─── Logging helpers ───

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

function tag(project) {
  return `${CYAN}[pipeline:${project}]${NC}`;
}

function log(project: string, msg: string) {
  console.log(`${tag(project)} ${msg}`);
}

function ok(msg: string) {
  console.log(`${GREEN}[PASS]${NC} ${msg}`);
}

function fail(msg: string) {
  console.log(`${RED}[FAIL]${NC} ${msg}`);
}

// ─── Exported utilities (used by tests) ───

export async function canonicalSourcePath(sourcePath: string) {
  const canonical = await realpath(path.resolve(sourcePath));
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`--source-path is not a directory: ${sourcePath}`);
  }
  return canonical;
}

export async function parseVerdict(verdictPath) {
  try {
    const content = await readFile(verdictPath, "utf8");
    const envelope = parseVerdictEnvelope(content);
    const mapped = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };
    return mapped[envelope.status] || "UNKNOWN";
  } catch {
    return null;
  }
}

export async function ensureWikiProjectBoundary(cpbRoot, project, sourcePath) {
  if (!sourcePath) return;
  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  const projectJsonPath = path.join(wikiDir, "project.json");
  const existing = await readJsonObject(projectJsonPath);
  if (existing.sourcePath) {
    let existingSourcePath = null;
    try {
      existingSourcePath = await canonicalSourcePath(existing.sourcePath);
    } catch (err) {
      if (!sourcePathRebindAllowed()) {
        throw new Error(
          `project/sourcePath mismatch: existing project '${project}' sourcePath is invalid (${err.message}); set CPB_ALLOW_SOURCEPATH_REBIND=1 to rebind explicitly`
        );
      }
    }
    if (existingSourcePath && existingSourcePath !== sourcePath && !sourcePathRebindAllowed()) {
      throw new Error(
        `project/sourcePath mismatch: existing project '${project}' is bound to ${existingSourcePath}, not ${sourcePath}`
      );
    }
  }
  await assertHubProjectBoundary(cpbRoot, project, sourcePath);
  await writeFile(
    projectJsonPath,
    `${JSON.stringify({ ...existing, name: existing.name || project, sourcePath }, null, 2)}\n`,
    "utf8",
  );
  await writeIfMissing(
    path.join(wikiDir, "context.md"),
    `# ${project}\n\nSource path: ${sourcePath}\n\nThis project was attached through CPB Hub. Expand this context as the project is onboarded.\n`,
  );
  await writeIfMissing(path.join(wikiDir, "tasks.md"), `# ${project} Tasks\n`);
  await writeIfMissing(path.join(wikiDir, "decisions.md"), `# ${project} Decisions\n`);
  await writeIfMissing(path.join(wikiDir, "log.md"), `# ${project} Log\n`);
}

// ─── Internal helpers ───

function sourcePathRebindAllowed() {
  return process.env.CPB_ALLOW_SOURCEPATH_REBIND === "1";
}

async function canonicalSourcePathOrThrow(sourcePath, label) {
  try {
    return await canonicalSourcePath(sourcePath);
  } catch (err) {
    throw new Error(`${label} sourcePath is invalid: ${err.message}`);
  }
}

async function assertHubProjectBoundary(cpbRoot, project, sourcePath) {
  if (!process.env.CPB_HUB_ROOT) return;

  const hubRoot = resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, project);
  if (!registered?.sourcePath) return;

  const registeredSourcePath = await canonicalSourcePathOrThrow(registered.sourcePath, "registered project");
  if (registeredSourcePath !== sourcePath) {
    throw new Error(
      `project/sourcePath mismatch: project '${project}' is registered to ${registeredSourcePath}, not ${sourcePath}`
    );
  }
}

async function writeIfMissing(filePath, content) {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content, "utf8");
  }
}

async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// ─── Worktree creation ───

async function maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePathOverride = null) {
  if (process.env.CPB_USE_WORKTREE !== "1") {
    return null;
  }

  const projectJsonPath = path.join(wikiDir, "project.json");
  let sourcePath = sourcePathOverride || process.env.CPB_PROJECT_PATH_OVERRIDE || null;
  if (!sourcePath) {
    try {
      const raw = await readFile(projectJsonPath, "utf8");
      sourcePath = JSON.parse(raw).sourcePath;
    } catch {
      return null;
    }
  }
  if (!sourcePath) return null;

  const { spawn } = await import("node:child_process");
  const worktreesRoot = runtimeDataPath(cpbRoot, "worktrees");
  const result = await runCommand(
    process.execPath,
    [
      path.join(executorRoot, "bridges", "worktree-manager.js"),
      "create",
      "--project",
      sourcePath,
      "--job-id",
      jobId,
      "--slug",
      "pipeline",
      "--worktrees-root",
      worktreesRoot,
    ],
    cpbRoot,
    { env: executorEnv(process.env, { cpbRoot, executorRoot }) }
  );
  if (result.exitCode !== 0) {
    throw result.error || new Error("worktree creation failed");
  }

  const created = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  process.env.CPB_PROJECT_PATH_OVERRIDE = created.path;
  process.env.CPB_ACP_CWD = created.path;
  await appendEvent(cpbRoot, project, jobId, {
    type: "worktree_created",
    jobId,
    project,
    worktree: created.path,
    branch: created.branch,
    ts: new Date().toISOString(),
  });
  return created;
}

function runCommand(command, commandArgs, cwd, options: Record<string, any> = {}): Promise<any> {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: any[] = [];

    function finish(result: any) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let proc: any;
    try {
      proc = spawn(command, commandArgs, {
        cwd,
        env: options.env || process.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", childPid: null, error: err });
      return;
    }

    proc.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });
    proc.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
    proc.on("error", (err) => {
      finish({ exitCode: 1, stdout: Buffer.concat(stdoutChunks).toString("utf8"), childPid: proc.pid, error: err });
    });
    proc.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        childPid: proc.pid,
      });
    });
  });
}

// ─── Failure summary ───

function printFailureSummary(cpbRoot: string, project: string, jobId: string, { phase, reason }: Record<string, any>) {
  console.log("");
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log(`${RED}  PIPELINE FAILED${NC}`);
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log("");
  console.log(`  ${CYAN}Project:${NC}   ${project}`);
  console.log(`  ${CYAN}Job:${NC}       ${jobId}`);
  if (phase) console.log(`  ${CYAN}Phase:${NC}     ${phase}`);
  if (reason) console.log(`  ${CYAN}Reason:${NC}    ${reason}`);
  console.log("");
  console.log(`  ${CYAN}Next steps:${NC}`);
  console.log(`    cpb status ${project}          # check current state`);
  console.log(`    cpb doctor                     # diagnose issues`);
  console.log("");
  console.log(`${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}`);
  console.log("");
}

// ─── Main pipeline (thin shim) ───

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(`${err.message}`);
    return 1;
  }

  const { project, task, maxRetries, timeoutMin, workflow, jobIdOverride, dispatchId: providedDispatchId } = parsed;
  let { sourcePath } = parsed;
  const defaultExecutorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const executorRoot = resolveExecutorRoot({ fallbackRoot: defaultExecutorRoot });
  const cpbRoot = path.resolve(process.env.CPB_ROOT || defaultExecutorRoot);
  process.env.CPB_ROOT = cpbRoot;
  process.env.CPB_EXECUTOR_ROOT = executorRoot;
  if (sourcePath) {
    try {
      sourcePath = await canonicalSourcePath(sourcePath);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;
    process.env.CPB_ACP_CWD = sourcePath;
    await ensureWikiProjectBoundary(cpbRoot, project, sourcePath);
  }

  const hubRoot = process.env.CPB_HUB_ROOT ? resolveHubRoot(cpbRoot) : null;
  let dispatchId = providedDispatchId || null;

  if (dispatchEnabled() && hubRoot && sourcePath) {
    await guardDispatchSourcePath(hubRoot, project, sourcePath);
    if (!dispatchId) {
      const dispatch = await recordDispatch(hubRoot, { projectId: project, sourcePath, sessionId: process.env.CPB_SESSION_ID || null, workerId: process.env.CPB_WORKER_ID || null });
      dispatchId = dispatch ? dispatch.dispatchId : null;
    }
    if (dispatchId) {
      await markDispatchStarted(hubRoot, dispatchId).catch(() => {});
    }
  }

  async function markDispatchDone(ok: boolean) {
    if (!dispatchEnabled() || !hubRoot || !dispatchId) return;
    const fn = ok ? markDispatchCompleted : markDispatchFailed;
    await fn(hubRoot, dispatchId).catch(() => {});
  }

  // Worktree setup
  const wikiDir = path.resolve(cpbRoot, "wiki", "projects", project);
  const jobId = jobIdOverride || `job-${Date.now()}`;
  await maybeCreateWorktree(cpbRoot, executorRoot, project, jobId, wikiDir, sourcePath);

  log(project, `Job ${jobId} started (max ${maxRetries} retries${timeoutMin > 0 ? `, ${timeoutMin}min timeout` : ""}, workflow: ${workflow})`);

  let pipelineOk = false;
  try {
    const result = await runJobWithServices({
      cpbRoot,
      hubRoot,
      project,
      task,
      workflow,
      sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE || null,
      maxRetries,
      timeoutMin,
      jobId: jobIdOverride,
      env: process.env,
    });

    if (result.status === "completed") {
      ok(`Pipeline complete! Job ${result.jobId}`);
      pipelineOk = true;
      return 0;
    }

    if (result.status === "blocked") {
      log(project, `Job ${result.jobId} blocked.`);
      pipelineOk = true;
      return 0;
    }

    // Failed
    const phase = result.failure?.phase || "unknown";
    const reason = result.failure?.reason || "unknown";
    fail(`Pipeline failed: ${reason}`);
    printFailureSummary(cpbRoot, project, result.jobId, { phase, reason });
    return 1;
  } catch (err) {
    fail(`Unhandled error: ${err.message}`);
    printFailureSummary(cpbRoot, project, jobId, { reason: err.message });
    return 1;
  } finally {
    await markDispatchDone(pipelineOk);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
