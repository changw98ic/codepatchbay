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

import { constants } from "node:fs";
import { lstat, open, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LooseRecord } from "../core/contracts/types.js";
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
import { applyVariant } from "../server/services/apply-variant.js";
import { runRepair, completeRepair } from "../server/services/review/review-dispatch.js";
import { runCommandTree } from "../core/runtime/process-tree.js";
import {
  withDurableDirectoryLock,
  type DurableDirectoryLockOptions,
} from "../core/runtime/durable-directory-lock.js";
import { subprocessOutputMaxBytes } from "../shared/bounded-output.js";

// --- CLI arg parsing ---

type PhaseName = "plan" | "execute" | "verify" | "review" | "repair";

type ParsedArgs = {
  phase: PhaseName;
  executorRoot: string;
  cpbRoot: string;
  project: string;
  options: Map<string, string>;
};

export type PhaseRuntime = {
  dataRoot: string;
  wikiDir: string;
  inboxDir: string;
  outputsDir: string;
};

type AcpResult = LooseRecord & {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
  signal?: NodeJS.Signals | null;
  aborted?: boolean;
};

function phaseContractError(message: string) {
  return Object.assign(new Error(message), { code: "PHASE_PROJECT_META_CONTRACT_INVALID" });
}

export function parsePhaseProjectMetaContract(
  raw: string,
  filePath: string,
  project: string,
): { sourcePath?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw phaseContractError(`project '${project}' project.json is invalid at ${filePath}: ${reason}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw phaseContractError(`project '${project}' project.json at ${filePath} must contain an object`);
  }
  const record = parsed as LooseRecord;
  if (record.sourcePath !== undefined && record.sourcePath !== null && typeof record.sourcePath !== "string") {
    throw phaseContractError(
      `project '${project}' project.json at ${filePath} has invalid sourcePath; expected string`,
    );
  }
  return typeof record.sourcePath === "string" ? { sourcePath: record.sourcePath } : {};
}

function parseArgs(argv: string[]): ParsedArgs {
  const phase = argv[0];
  if (!phase || !["plan", "execute", "verify", "review", "repair"].includes(phase)) {
    throw new Error(`first argument must be a phase name (plan|execute|verify|review|repair), got: ${phase}`);
  }

  const positional: string[] = [];
  const options = new Map<string, string>();
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
    const POSITIONAL_MAP: Record<string, string[]> = {
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

  return { phase: phase as PhaseName, executorRoot: path.resolve(executorRoot), cpbRoot: path.resolve(cpbRoot), project, options };
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

async function syncPhaseLogDirectory(directory: string) {
  const handle = await open(directory, "r");
  let primaryError: unknown = null;
  try {
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `phase log directory sync and close failed: ${directory}`,
      { cause: primaryError },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

async function appendPhaseLogDurable(logFile: string, entry: string) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw Object.assign(new Error(`phase log no-follow append is unavailable: ${logFile}`), {
      code: "PHASE_LOG_UNSAFE",
      recoveryPaths: [logFile],
    });
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      logFile,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "")
      : "";
    if (code === "ELOOP" || code === "EMLINK") {
      throw Object.assign(new Error(`phase log symbolic-link target rejected: ${logFile}`, { cause: error }), {
        code: "PHASE_LOG_UNSAFE",
        recoveryPaths: [logFile],
      });
    }
    throw error;
  }
  let primaryError: unknown = null;
  let appendAttempted = false;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      throw Object.assign(new Error(`phase log target is not a private regular file: ${logFile}`), {
        code: "PHASE_LOG_UNSAFE",
      });
    }
    appendAttempted = true;
    await handle.writeFile(entry, "utf8");
    await handle.sync();
    const finalDescriptor = await handle.stat();
    const finalPath = await lstat(logFile);
    if (
      !finalPath.isFile()
      || finalPath.isSymbolicLink()
      || finalDescriptor.nlink !== 1
      || finalPath.nlink !== 1
      || finalPath.dev !== finalDescriptor.dev
      || finalPath.ino !== finalDescriptor.ino
    ) {
      throw Object.assign(new Error(`phase log path changed during append: ${logFile}`), {
        code: "PHASE_LOG_PATH_CHANGED",
      });
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (!primaryError && !closeError) {
    try {
      await syncPhaseLogDirectory(path.dirname(logFile));
      return;
    } catch (error) {
      primaryError = error;
    }
  }
  const errors = [primaryError, closeError].filter((error) => error !== null);
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `phase log append and close failed: ${logFile}`, {
      cause: primaryError ?? errors[0],
    });
  if (appendAttempted) {
    throw Object.assign(
      new Error(`phase log append may have committed: ${logFile}`, { cause }),
      {
        code: "PHASE_LOG_APPEND_COMMITTED_AMBIGUOUS",
        committed: true,
        recoveryPaths: [logFile],
      },
    );
  }
  throw cause;
}

export async function appendPhaseLog(
  cpbRoot: string,
  project: string,
  msg: string,
  runtime: PhaseRuntime | null = null,
  lockOptions: DurableDirectoryLockOptions = {},
) {
  const logFile = runtime?.wikiDir
    ? path.join(runtime.wikiDir, "log.md")
    : wikiLogPath(cpbRoot, project);
  await mkdir(path.dirname(logFile), { recursive: true });
  const lockDir = path.join(path.dirname(logFile), ".cpb-log.lock");
  return withDurableDirectoryLock(lockDir, async () => {
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await appendPhaseLogDurable(logFile, `- **${ts}** | ${msg}\n`);
  }, {
    ttlMs: 30_000,
    waitMs: 3_000,
    retryMs: 50,
    ...lockOptions,
  });
}

const logAppend = appendPhaseLog;

async function dashboardUpdate(cpbRoot: string, project: string, phase: string, status: string, next: string) {
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

function boundedStreamWriter(maxBytes: number, write: (chunk: Buffer) => void) {
  let written = 0;
  return (chunk: string) => {
    if (maxBytes <= 0) {
      write(Buffer.from(chunk, "utf8"));
      return;
    }
    const remaining = maxBytes - written;
    if (remaining <= 0) return;
    const data = Buffer.from(chunk, "utf8");
    const slice = data.byteLength > remaining ? data.subarray(0, remaining) : data;
    written += slice.byteLength;
    if (slice.byteLength > 0) write(slice);
  };
}

export async function runAcp(agent: string, prompt: string, cwd: string, executorRoot: string): Promise<AcpResult> {
  const clientPath = process.env.CPB_ACP_CLIENT
    || path.join(executorRoot, "server", "services", "acp", "acp-client.js");

  if (agent === "claude") {
    applyVariant();
  }

  const abort = new AbortController();
  let abortSignal: NodeJS.Signals | null = null;
  const abortForSignal = (signal: NodeJS.Signals) => {
    if (!abortSignal) abortSignal = signal;
    if (!abort.signal.aborted) {
      abort.abort(Object.assign(new Error(`received ${signal}`), { code: "ACP_SIGNAL_ABORT", signal }));
    }
  };
  const onSigint = () => abortForSignal("SIGINT");
  const onSigterm = () => abortForSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const command = process.execPath;
  const args = [clientPath, "--agent", agent, "--cwd", cwd];
  const env = { ...process.env };

  if (!process.env.CPB_TEST_ENV_LOG && !env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_API_KEY = env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }

  try {
    const maxOutputBytes = subprocessOutputMaxBytes(process.env.CPB_SUBPROCESS_OUTPUT_MAX_BYTES);
    const writeStdout = boundedStreamWriter(maxOutputBytes, (chunk) => process.stdout.write(chunk));
    const writeStderr = boundedStreamWriter(maxOutputBytes, (chunk) => process.stderr.write(chunk));
    const result = await runCommandTree(command, args, {
      cwd,
      env,
      input: prompt,
      signal: abort.signal,
      graceMs: 2_000,
      maxBufferBytes: maxOutputBytes,
      onStdout: writeStdout,
      onStderr: writeStderr,
    });
    const signalExitCode = abortSignal === "SIGINT" ? 130 : abortSignal === "SIGTERM" ? 143 : null;
    const exitCode = result.error
      ? signalExitCode ?? (result.exitCode === 0 ? 1 : result.exitCode)
      : signalExitCode ?? result.exitCode;
    return {
      exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      signal: result.signal,
      aborted: result.aborted,
      error: result.error,
    };
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

// --- Verdict parsing ---

function parseVerdictFromContent(content: string) {
  const envelope = parseVerdictEnvelope(content);
  const mapped: Record<string, string> = { pass: "PASS", fail: "FAIL", inconclusive: "UNKNOWN", infra_error: "INFRA_FAILURE" };
  return mapped[envelope.status] || "UNKNOWN";
}

function parseReviewVerdict(content: string) {
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

async function handlePlan(args: ParsedArgs) {
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

async function handleExecute(args: ParsedArgs) {
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

async function handleVerify(args: ParsedArgs) {
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

async function handleReview(args: ParsedArgs) {
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

async function handleRepair(args: ParsedArgs) {
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

  async function recordEvent(event: LooseRecord) {
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
  const roleMap: Record<string, string> = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };
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
    const metaFile = path.join(parsed.cpbRoot, "wiki", "projects", parsed.project, "project.json");
    try {
      const meta = parsePhaseProjectMetaContract(await readFile(metaFile, "utf8"), metaFile, parsed.project);
      if (meta.sourcePath) process.env.CPB_ACP_CWD = meta.sourcePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
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

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  process.exitCode = await main();
}
