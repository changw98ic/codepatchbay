#!/usr/bin/env node
// run-phase.js - Unified Node phase entrypoint (plan/execute/verify/review/repair)
// Replaces shell bridge business logic. Shell wrappers exec this for CLI compatibility.
//
// Usage:
//   node bridges/run-phase.js plan --executor-root <r> --cpb-root <r> --project <p> --task "<t>"
//   node bridges/run-phase.js execute --executor-root <r> --cpb-root <r> --project <p> --plan-id <id> [--verdict-file <path>]
//   node bridges/run-phase.js verify --executor-root <r> --cpb-root <r> --project <p> --deliverable-id <id>
//   node bridges/run-phase.js verify --executor-root <r> --cpb-root <r> --project <p> --job-id <id>
//   node bridges/run-phase.js review --executor-root <r> --cpb-root <r> --project <p> --deliverable-id <id>
//   node bridges/run-phase.js repair --executor-root <r> --cpb-root <r> --project <p> --job-id <id>

import { readFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AnyRecord } from "../shared/types.js";
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildExecutorJobPrompt,
  buildVerifierPrompt,
  buildVerifierJobPrompt,
  buildRepairerPrompt,
  buildReviewerReviewPrompt,
} from "../server/services/prompt/prompt-builder.js";
import { resolveProjectDataRoot } from "../server/services/runtime.js";
import {
  allocateArtifactId,
  wikiLogPath,
  dashboardPath,
} from "../server/services/artifact-locator.js";
import { parseVerdictEnvelope } from "../core/workflow/verdict.js";
import { applyVariant } from "../server/services/setup.js";
import { runRepair, completeRepair } from "../server/services/review/review-dispatch.js";

// --- CLI arg parsing ---

function parseArgs(argv) {
  const phase = argv[0];
  if (!phase || !["plan", "execute", "verify", "review", "repair"].includes(phase)) {
    throw new Error(`first argument must be a phase name (plan|execute|verify|review|repair), got: ${phase}`);
  }

  const positional = [];
  const options = new Map();
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`missing value for ${token}`);
      }
      options.set(token, value);
      i++;
    } else {
      positional.push(token);
    }
  }

  // When positional args are present, map them to --flags by phase.
  // This lets job-runner.js call: node run-phase.js <phase> <project> <id> [args...]
  if (positional.length > 0 && !options.has("--project")) {
    const POSITIONAL_MAP = {
      plan:   ["--project", "--task"],
      execute: ["--project", "--plan-id"],
      verify: ["--project", "--deliverable-id"],
      review: ["--project", "--deliverable-id"],
      repair: ["--project"],
    };
    const flags = POSITIONAL_MAP[phase];
    if (flags) {
      for (let i = 0; i < positional.length && i < flags.length; i++) {
        if (!options.has(flags[i])) {
          options.set(flags[i], positional[i]);
        }
      }
    }
  }

  const executorRoot = options.get("--executor-root") || process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");
  const cpbRoot = options.get("--cpb-root") || process.env.CPB_ROOT || executorRoot;
  const project = options.get("--project") || "";

  if (!project || project.length > 64 || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(project)) {
    throw new Error(`invalid project name: ${project}`);
  }

  return { phase, executorRoot: path.resolve(executorRoot), cpbRoot: path.resolve(cpbRoot), project, options };
}

async function phaseRuntime(cpbRoot: string, project: string) {
  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: process.env.CPB_HUB_ROOT,
    dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
  process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
  const wikiDir = path.join(dataRoot, "wiki");
  return {
    dataRoot,
    wikiDir,
    inboxDir: path.join(wikiDir, "inbox"),
    outputsDir: path.join(wikiDir, "outputs"),
  };
}

// --- Logging helpers ---

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

async function logAppend(cpbRoot, project, msg, runtime: AnyRecord | null = null) {
  const logFile = runtime?.wikiDir
    ? path.join(runtime.wikiDir, "log.md")
    : wikiLogPath(cpbRoot, project);
  await mkdir(path.dirname(logFile), { recursive: true });
  const lockDir = path.join(path.dirname(logFile), ".cpb-log.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendFile(logFile, `- **${ts}** | ${msg}\n`, "utf8");
  } finally {
    if (acquired) {
      try {
        const { rmdir } = await import("node:fs/promises");
        await rmdir(lockDir);
      } catch {}
    }
  }
}

async function dashboardUpdate(cpbRoot, project, phase, status, next) {
  const dashFile = dashboardPath(cpbRoot);
  try {
    let content = await readFile(dashFile, "utf8");
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const entry = `\n### ${project}\n- **status**: ${status}\n- **phase**: ${phase}\n- **updated**: ${ts}\n- **next**: ${next}\n`;
    const marker = "## 活跃项目";
    const idx = content.indexOf(marker);
    if (idx >= 0) {
      const rest = content.substring(idx + marker.length);
      const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const cleaned = rest.replace(new RegExp(`\\n### ${escaped}\\n(- .+\\n)*`), "");
      content = content.substring(0, idx) + marker + entry + cleaned;
    }
    const { writeFile: writeDash } = await import("node:fs/promises");
    await writeDash(dashFile, content, "utf8");
  } catch {}
}

// --- ACP runner ---


async function runAcp(agent, prompt, cwd, executorRoot): Promise<AnyRecord> {
  const { spawn } = await import("node:child_process");
  const clientPath = process.env.CPB_ACP_CLIENT || path.join(executorRoot, "bridges", "acp-client.js");
  const useDirect = !!process.env.CPB_ACP_CLIENT;

  if (agent === "claude") {
    applyVariant();
  }

  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks = [];
    const stderrChunks = [];

    function finish(result: AnyRecord) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let child;
    try {
      const command = useDirect ? clientPath : process.execPath;
      const args = useDirect ? ["--agent", agent, "--cwd", cwd] : [clientPath, "--agent", agent, "--cwd", cwd];
      const env = { ...process.env };

      if (!process.env.CPB_TEST_ENV_LOG && !env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
        env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_AUTH_TOKEN;
      }

      child = spawn(command, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, stdout: "", stderr: err.message, error: err });
      return;
    }

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (err) => finish({ exitCode: 1, stdout: "", stderr: "", error: err }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      finish({ exitCode: code ?? 1, stdout, stderr });
    });

    // Forward signals to child process group when possible
    const forwardSignal = (sig) => {
      try {
        if (child.pid && !child.killed) {
          process.kill(-child.pid, sig);
        }
      } catch {}
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    child.on("close", () => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
    });
  });
}

// --- Verdict parsing ---

function parseVerdictFromContent(content) {
  const envelope = parseVerdictEnvelope(content);
  const mapped = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };
  return mapped[envelope.status] || "UNKNOWN";
}

function parseReviewVerdict(content) {
  const lines = content.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const match = line.match(/^REVIEW:\s*(PASS|FAIL)\b/i);
    if (match) return match[1].toUpperCase();
  }
  for (const line of lines) {
    const inline = line.match(/\bREVIEW:\s*(PASS|FAIL)\b/i);
    if (inline) return inline[1].toUpperCase();
  }
  return "UNKNOWN";
}

// --- Phase handlers ---

async function handlePlan(args) {
  const { executorRoot, cpbRoot, project, options } = args;
  const task = options.get("--task") || "";
  if (!task) throw new Error("--task is required for plan phase");

  const runtime = await phaseRuntime(cpbRoot, project);
  const planId = await allocateArtifactId(runtime.inboxDir, "plan");
  const planFile = path.join(runtime.inboxDir, `plan-${planId}.md`);

  console.log(`Planning [${project}]: ${task}`);
  console.log(`Output: ${planFile}`);

  const prompt = await buildPlannerPrompt(executorRoot, cpbRoot, project, task, planFile, { dataRoot: runtime.dataRoot });
  const result = await runAcp("codex", prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Plan spawn failed: ${result.error.message}`);
    return 1;
  }

  // Check if plan file was created
  try {
    await readFile(planFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `planner | plan | Failed to create plan for: ${task} | FAIL`, runtime);
    console.error("Warning: Plan file not created.");
    return 1;
  }

  await logAppend(cpbRoot, project, `planner | plan | Created plan-${planId} for: ${task} | SUCCESS`, runtime);
  await dashboardUpdate(cpbRoot, project, "plan", "EXECUTING", `cpb execute ${project} ${planId}`);
  console.log("");
  console.log(`Plan: ${planFile}`);
  console.log(`Next: cpb execute ${project} ${planId}`);
  return 0;
}

async function handleExecute(args) {
  const { executorRoot, cpbRoot, project, options } = args;
  const planId = options.get("--plan-id") || "";
  const jobId = options.get("--job-id") || "";
  if (!planId && !jobId) throw new Error("--plan-id or --job-id is required for execute phase");

  const verdictFile = options.get("--verdict-file") || "";
  const runtime = await phaseRuntime(cpbRoot, project);

  const deliverableId = await allocateArtifactId(runtime.outputsDir, "deliverable");
  const deliverableFile = path.join(runtime.outputsDir, `deliverable-${deliverableId}.md`);

  let prompt;
  if (jobId && !planId) {
    // Locator-first path: build prompt from job/event state, not artifact content
    console.log(`Executing [${project}] job-${jobId} (locator-first)...`);
    prompt = await buildExecutorJobPrompt(executorRoot, cpbRoot, project, jobId, deliverableFile, { dataRoot: runtime.dataRoot });
  } else {
    // Backward-compatible artifact-based path
    const planFile = path.join(runtime.inboxDir, `plan-${planId}.md`);
    try { await readFile(planFile, "utf8"); } catch {
      console.error(`Plan file not found: ${planFile}`);
      return 1;
    }
    console.log(`Executing [${project}] plan-${planId}...`);
    prompt = await buildExecutorPrompt(executorRoot, cpbRoot, project, planId, deliverableFile, verdictFile || null, { dataRoot: runtime.dataRoot });
  }
  console.log(`Output: ${deliverableFile}`);

  const result = await runAcp("claude", prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Execute spawn failed: ${result.error.message}`);
    return 1;
  }

  try {
    await readFile(deliverableFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `executor | execute | deliverable not created from plan-${planId} | WARN`, runtime);
    console.error("Warning: Deliverable not created.");
    return 0;
  }

  await logAppend(cpbRoot, project, `executor | execute | deliverable-${deliverableId} from plan-${planId} | SUCCESS`, runtime);
  await dashboardUpdate(cpbRoot, project, "execute", "VERIFYING", `cpb verify ${project} ${deliverableId}`);
  console.log("");
  console.log(`Deliverable: ${deliverableFile}`);
  console.log(`Next: cpb verify ${project} ${deliverableId}`);
  return 0;
}

async function handleVerify(args) {
  const { executorRoot, cpbRoot, project, options } = args;
  const deliverableId = options.get("--deliverable-id") || "";
  const jobId = options.get("--job-id") || "";

  if (!deliverableId && !jobId) {
    throw new Error("--deliverable-id or --job-id is required for verify phase");
  }

  const runtime = await phaseRuntime(cpbRoot, project);

  if (deliverableId) {
    const deliverableFile = path.join(runtime.outputsDir, `deliverable-${deliverableId}.md`);
    try { await readFile(deliverableFile, "utf8"); } catch {
      console.error(`Deliverable file not found: ${deliverableFile}`);
      return 1;
    }
  }

  const artifactId = deliverableId || jobId;
  const verdictFile = path.join(runtime.outputsDir, `verdict-${artifactId}.md`);

  const label = jobId ? `job-${jobId}` : `deliverable-${deliverableId}`;
  console.log(`Verifying [${project}] ${label}...`);
  console.log(`Output: ${verdictFile}`);

  let prompt;
  if (jobId) {
    prompt = await buildVerifierJobPrompt(executorRoot, cpbRoot, project, jobId, verdictFile, { dataRoot: runtime.dataRoot });
  } else {
    prompt = await buildVerifierPrompt(executorRoot, cpbRoot, project, deliverableId, verdictFile, { dataRoot: runtime.dataRoot });
  }

  const result = await runAcp("codex", prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Verify spawn failed: ${result.error.message}`);
    return 1;
  }

  // Parse verdict
  let verdictContent;
  try {
    verdictContent = await readFile(verdictFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `verifier | verify | verdict not created for ${label} | FAIL`, runtime);
    console.error("Warning: Verdict not created.");
    return 1;
  }

  const verdict = parseVerdictFromContent(verdictContent);
  await logAppend(cpbRoot, project, `verifier | verify | ${label} | ${verdict}`, runtime);

  console.log("");
  console.log(`Verdict: ${verdict}`);
  if (verdict === "FAIL" || verdict === "PARTIAL") {
    await dashboardUpdate(cpbRoot, project, "verify", "FIXING", `cpb execute ${project} (fix)`);
    console.log(`Fix needed: ${verdictFile}`);
    console.log(`Next: cpb execute ${project} <plan-id>`);
  } else if (verdict === "PASS") {
    await dashboardUpdate(cpbRoot, project, "verify", "DONE", "completed");
    console.log("Deliverable accepted.");
  } else {
    await dashboardUpdate(cpbRoot, project, "verify", "UNCLEAR", "manual review needed");
  }
  return 0;
}

async function handleReview(args) {
  const { executorRoot, cpbRoot, project, options } = args;
  const deliverableId = options.get("--deliverable-id") || "";
  if (!deliverableId) throw new Error("--deliverable-id is required for review phase");

  const runtime = await phaseRuntime(cpbRoot, project);
  const deliverableFile = path.join(runtime.outputsDir, `deliverable-${deliverableId}.md`);
  try { await readFile(deliverableFile, "utf8"); } catch {
    console.error(`Deliverable file not found: ${deliverableFile}`);
    return 1;
  }

  const reviewFile = path.join(runtime.outputsDir, `review-${deliverableId}.md`);
  console.log(`Reviewing [${project}] deliverable-${deliverableId}...`);
  console.log(`Output: ${reviewFile}`);

  const prompt = await buildReviewerReviewPrompt(executorRoot, cpbRoot, project, deliverableId, { dataRoot: runtime.dataRoot });
  const result = await runAcp("codex", prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Review spawn failed: ${result.error.message}`);
    return 1;
  }

  let reviewContent;
  try {
    reviewContent = await readFile(reviewFile, "utf8");
  } catch {
    await logAppend(cpbRoot, project, `reviewer | review | review not created for deliverable-${deliverableId} | FAIL`, runtime);
    console.error("Warning: Review not created.");
    return 1;
  }

  const reviewVerdict = parseReviewVerdict(reviewContent);
  await logAppend(cpbRoot, project, `reviewer | review | deliverable-${deliverableId} | ${reviewVerdict}`, runtime);

  console.log("");
  console.log(`Review: ${reviewVerdict}`);
  if (reviewVerdict === "FAIL") {
    console.log(`Review failed. Must-fix items in: ${reviewFile}`);
  } else {
    console.log("Review passed.");
  }
  return 0;
}

async function handleRepair(args) {
  const { executorRoot, cpbRoot, project, options } = args;
  const jobId = options.get("--job-id") || "";
  if (!jobId) throw new Error("--job-id is required for repair phase");

  const { repairId, repairFile, repairArtifact, dataRoot, lockDir } = await runRepair(cpbRoot, {
    project,
    jobId,
    executorRoot,
  });

  console.log(`Repairing [${project}] job-${jobId}...`);
  console.log(`Output: ${repairFile}`);

  const { appendEvent: appendEv, checkpointJob, readEvents: readEv, materializeJob } = await import("../server/services/event/event-store.js");
  const { updateJobsIndexEntry } = await import("../server/services/job/job-store.js");
  const eventOpts = { dataRoot, includeLegacyFallback: false };

  async function recordEvent(event) {
    await appendEv(cpbRoot, project, jobId, event, eventOpts);
    await checkpointJob(cpbRoot, project, jobId, eventOpts).catch(() => {});
    const state = materializeJob(await readEv(cpbRoot, project, jobId, eventOpts));
    await updateJobsIndexEntry(cpbRoot, project, jobId, state, eventOpts).catch(() => {});
  }

  await recordEvent({
    type: "external_repair_started",
    jobId,
    project,
    artifact: repairArtifact,
    file: repairFile,
    ts: new Date().toISOString(),
  });

  const prompt = await buildRepairerPrompt(executorRoot, cpbRoot, project, jobId, repairFile);
  const result = await runAcp("claude", prompt, process.env.CPB_ACP_CWD || process.cwd(), executorRoot);

  if (result.error) {
    console.error(`Repair spawn failed: ${result.error.message}`);
    await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "failed", error: `repairer spawn failed: ${result.error.message}`,
      executorRoot, lockDir,
    }).catch(() => {});
    return 1;
  }

  if (result.exitCode !== 0) {
    await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "failed", error: `repairer exited ${result.exitCode}`,
      executorRoot, lockDir,
    }).catch(() => {});
    return result.exitCode;
  }

  try {
    const repairStatus = await completeRepair(cpbRoot, {
      project, jobId, repairId, repairFile, repairArtifact,
      status: "completed", error: null, executorRoot, lockDir,
    });
    await logAppend(cpbRoot, project, `repairer | repair | repair-${repairId} for job-${jobId} | ${repairStatus}`);
  } catch (err) {
    await logAppend(cpbRoot, project, `repairer | repair | repair-${repairId} for job-${jobId} | FAIL: ${err.message}`);
    console.error(`Repair failed: ${err.message}`);
    return 1;
  }
  return 0;
}

// --- Main ---

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    console.error("Usage: node bridges/run-phase.js <phase> [options]");
    console.error("Phases: plan, execute, verify, review, repair");
    return 1;
  }

  let parsed;
  try {
    parsed = parseArgs(rawArgs);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  // Propagate env
  process.env.CPB_EXECUTOR_ROOT = parsed.executorRoot;
  process.env.CPB_ROOT = parsed.cpbRoot;

  // Permission matrix context for ACP enforcement
  const roleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };
  process.env.CPB_ACP_ROLE = roleMap[parsed.phase] || "";
  process.env.CPB_ACP_PROJECT = parsed.project;
  process.env.CPB_ACP_PHASE = parsed.phase;
  const jobId = process.env.CPB_ACP_JOB_ID || process.env.CPB_JOB_ID
    || parsed.options.get("--job-id")
    || parsed.options.get("--deliverable-id")
    || parsed.options.get("--plan-id")
    || "";
  if (jobId) process.env.CPB_ACP_JOB_ID = jobId;
  process.env.CPB_ACP_CPB_ROOT = parsed.cpbRoot;

  // Set ACP cwd
  if (!process.env.CPB_ACP_CWD && !process.env.CPB_PROJECT_PATH_OVERRIDE) {
    try {
      const metaFile = path.join(parsed.cpbRoot, "wiki", "projects", parsed.project, "project.json");
      const meta = JSON.parse(await readFile(metaFile, "utf8"));
      if (meta.sourcePath) process.env.CPB_ACP_CWD = meta.sourcePath;
    } catch {}
  }

  switch (parsed.phase) {
    case "plan": return await handlePlan(parsed);
    case "execute": return await handleExecute(parsed);
    case "verify": return await handleVerify(parsed);
    case "review": return await handleReview(parsed);
    case "repair": return await handleRepair(parsed);
    default:
      console.error(`Unknown phase: ${parsed.phase}`);
      return 1;
  }
}

process.exitCode = await main();
