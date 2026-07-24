#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createAgentHome } from "../core/agents/isolation.js";
import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import { createCandidateReplayBundle } from "../core/engine/candidate-replay.js";
import { resolveTaskRoute } from "../core/workflow/auto-route.js";
import {
  CODING_COMPARISON_LANES,
  buildCodingComparisonSummary,
  codingComparisonEvaluationFingerprint,
  codingComparisonInputFingerprint,
  codingComparisonPermissionFingerprint,
  extractCodingComparisonTelemetry,
  parseNativeCodexJsonl,
  validateCodingComparisonManifest,
  type CodingComparisonLane,
  type CodingComparisonLaneResult,
  type CodingComparisonTask,
} from "../core/evaluation/coding-comparison.js";
import { captureProcessIdentity, killTree, runCommandTree, type ProcessIdentity } from "../core/runtime/process-tree.js";
import {
  createTemporaryGitWorktree,
  createTemporaryWorkspace,
  temporaryWorkspaceErrorDetails,
  type TemporaryGitWorktree,
  type TemporaryWorkspace,
  type TemporaryWorkspaceCleanupProof,
} from "../core/runtime/temporary-workspace.js";
import { runJobWithServices } from "../server/services/engine-runner.js";
import { terminateProcessesMatchingPath } from "../server/services/acp/acp-client.js";
import { stopManagedAcpPool } from "../server/services/acp/acp-pool.js";
import { readEvents } from "../server/services/event/event-store.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { isDelegateAlive } from "../server/services/quota-delegate-client.js";
import { buildJobReplay, recordExternalEvaluation } from "../server/services/trace/trace-replay.js";
import { isRecord, recordValue, type LooseRecord } from "../shared/types.js";

type CliOptions = {
  manifestPath: string;
  outputPath: string;
  keepWorktrees: boolean;
};

type SolverLaneInput = {
  schemaVersion: 1;
  lane: "cpb_codex" | "cpb_smart";
  taskId: string;
  task: string;
  model: string;
  reasoningEffort: CodingComparisonTask["reasoningEffort"];
  timeoutMs: number;
  workflow: string;
  planMode: string;
  baseSha: string;
  worktree: string;
  cpbRoot: string;
  hubRoot: string;
  project: string;
  projectRuntimeRoot: string;
  jobId: string;
};

type CandidateSnapshot = {
  baseSha: string;
  treeHash: string;
  patchSha256: string;
  patchBytes: number;
  candidateIdentityHash: string;
};

type CheckResult = {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  status: "passed" | "failed";
  exitCode: number;
  timedOut: boolean;
  elapsedMs: number;
  stdoutTail: string;
  stderrTail: string;
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CPB_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const QUOTA_DELEGATE_PATH = fileURLToPath(new URL("../server/services/quota-delegate.js", import.meta.url));
const TOOL_TAIL_CHARS = 8_000;
const REPAIR_EVENTS = new Set([
  "phase_retry",
  "phase_feedback_retry",
  "phase_quality_retry",
  "phase_agent_fallback",
  "dag_node_retrying",
  "solver_repair_started",
  "solver_completion_gate_repair_started",
]);

function tail(value: unknown, maxChars = TOOL_TAIL_CHARS) {
  return String(value ?? "").slice(-maxChars);
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(target: string, value: unknown) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readJson(target: string): Promise<unknown> {
  return JSON.parse(await readFile(target, "utf8"));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function checkedCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
) {
  const result = await runCommandTree(command, args, {
    cwd,
    env: options.env,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut || result.error) {
    throw new Error([
      `${command} ${args.join(" ")} failed in ${cwd}`,
      result.timedOut ? "timed out" : "",
      errorMessage(result.error || ""),
      tail(result.stderr || result.stdout),
    ].filter(Boolean).join(": "));
  }
  return result;
}

function parseCli(argv: string[]): CliOptions | { workerInput: string; workerOutput: string } {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || "" : "";
  };
  const workerInput = value("--cpb-lane-input");
  if (workerInput) {
    const workerOutput = value("--cpb-lane-output");
    if (!workerOutput) throw new Error("--cpb-lane-output is required with --cpb-lane-input");
    return { workerInput: path.resolve(workerInput), workerOutput: path.resolve(workerOutput) };
  }
  const manifestPath = value("--manifest");
  const outputPath = value("--output");
  if (!manifestPath || !outputPath) {
    throw new Error("usage: run-coding-comparison --manifest <file> --output <file> [--keep-worktrees]");
  }
  return {
    manifestPath: path.resolve(manifestPath),
    outputPath: path.resolve(outputPath),
    keepWorktrees: argv.includes("--keep-worktrees"),
  };
}

export function laneOrderForTask(taskIndex: number): CodingComparisonLane[] {
  const offset = taskIndex % CODING_COMPARISON_LANES.length;
  return [...CODING_COMPARISON_LANES.slice(offset), ...CODING_COMPARISON_LANES.slice(0, offset)];
}

export function buildSolverLaneInput({
  lane,
  task,
  baseSha,
  worktree,
  cpbRoot,
  hubRoot,
  project,
  projectRuntimeRoot,
  jobId,
}: {
  lane: "cpb_codex" | "cpb_smart";
  task: CodingComparisonTask;
  baseSha: string;
  worktree: string;
  cpbRoot: string;
  hubRoot: string;
  project: string;
  projectRuntimeRoot: string;
  jobId: string;
}): SolverLaneInput {
  const route = resolveTaskRoute({
    task: task.task,
    workflow: "standard",
    planMode: "auto",
    triageMode: "auto",
    actor: "api",
  });
  return {
    schemaVersion: 1,
    lane,
    taskId: task.id,
    task: task.task,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    timeoutMs: task.timeoutMs,
    workflow: route.workflow,
    planMode: route.planMode,
    baseSha,
    worktree,
    cpbRoot,
    hubRoot,
    project,
    projectRuntimeRoot,
    jobId,
  };
}

export function nativeCodexArgs(task: CodingComparisonTask, worktree: string) {
  const codegraphArgs = ["serve", "--mcp", "--no-watch", "-p", worktree];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--color", "never",
    "--model", task.model,
    "--sandbox", "workspace-write",
    "-c", 'approval_policy="never"',
    "-c", "features.apps=false",
    "-c", "features.plugins=false",
    "-c", "features.remote_plugin=false",
    "-c", `model_reasoning_effort=${JSON.stringify(task.reasoningEffort)}`,
    "-c", 'plugins."computer-use@openai-bundled".enabled=false',
    "-c", 'plugins."browser@openai-bundled".enabled=false',
    "-c", 'plugins."chrome@openai-bundled".enabled=false',
    "-c", "notify=[]",
    "-c", 'mcp_servers.codegraph.command="codegraph"',
    "-c", `mcp_servers.codegraph.args=${JSON.stringify(codegraphArgs)}`,
    "--cd", worktree,
    task.task,
  ];
}

type ComparisonQuotaDelegate = {
  child: ChildProcess;
  identity: ProcessIdentity;
  stderr: () => string;
};

export async function cleanupUnidentifiedComparisonDelegate(child: ChildProcess) {
  child.stderr?.destroy();
  if (child.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.end();
    } catch {}
  }
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = await Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<false>((resolve) => {
      const timer = setTimeout(() => resolve(false), 1_000);
      timer.unref();
    }),
  ]);
  if (!exited) {
    throw Object.assign(
      new Error(`unidentified comparison quota delegate ${child.pid} did not exit before cleanup deadline`),
      { code: "PROCESS_CLEANUP_UNVERIFIED" },
    );
  }
}

async function waitForQuotaDelegate(child: ChildProcess, hubRoot: string, stderr: () => string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`comparison quota delegate exited with ${child.exitCode}: ${tail(stderr(), 2_000)}`);
    }
    if (await isDelegateAlive(hubRoot)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`comparison quota delegate did not become ready: ${tail(stderr(), 2_000)}`);
}

async function startComparisonQuotaDelegate(hubRoot: string, env: NodeJS.ProcessEnv): Promise<ComparisonQuotaDelegate> {
  let stderrText = "";
  const child = spawn(process.execPath, [QUOTA_DELEGATE_PATH, "--hub-root", hubRoot], {
    cwd: CPB_ROOT,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let identity: ProcessIdentity;
  try {
    const captured = child.pid ? captureProcessIdentity(child.pid, { strict: true }) : null;
    if (!captured) throw Object.assign(new Error("comparison quota delegate identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
    identity = captured;
  } catch (error) {
    try {
      await cleanupUnidentifiedComparisonDelegate(child);
    } catch (cleanupError) {
      const primary = error instanceof Error ? error : new Error(String(error));
      const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
      throw Object.assign(
        new AggregateError([primary, cleanup], primary.message, { cause: primary }),
        {
          code: (cleanup as NodeJS.ErrnoException).code || "PROCESS_CLEANUP_UNVERIFIED",
          primaryError: primary,
          cleanupError: cleanup,
        },
      );
    }
    throw error;
  }
  child.stderr?.on("data", (chunk) => {
    stderrText = tail(`${stderrText}${String(chunk)}`, 8_000);
  });
  const stderr = () => stderrText;
  try {
    await waitForQuotaDelegate(child, hubRoot, stderr);
    return { child, identity, stderr };
  } catch (error) {
    await killTree(identity.pid, 0, {
      expectedRootIdentity: identity,
      requireDescendantScan: true,
      forceVerifyMs: 1_000,
    });
    throw error;
  }
}

async function stopComparisonQuotaDelegate(delegate: ComparisonQuotaDelegate | null) {
  if (!delegate || delegate.child.exitCode !== null) return;
  await killTree(delegate.identity.pid, 2_000, {
    expectedRootIdentity: delegate.identity,
    requireDescendantScan: true,
    forceVerifyMs: 1_000,
  });
}

function validateSolverLaneInput(value: unknown): SolverLaneInput {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid CPB comparison lane input");
  const allowed = new Set([
    "schemaVersion", "lane", "taskId", "task", "model", "reasoningEffort", "timeoutMs", "workflow", "planMode",
    "baseSha", "worktree", "cpbRoot", "hubRoot", "project", "projectRuntimeRoot", "jobId",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown CPB comparison lane input field ${key}`);
  }
  if (value.lane !== "cpb_codex" && value.lane !== "cpb_smart") throw new Error("invalid CPB comparison lane");
  const required = ["taskId", "task", "model", "reasoningEffort", "workflow", "planMode", "baseSha", "worktree", "cpbRoot", "hubRoot", "project", "projectRuntimeRoot", "jobId"];
  for (const field of required) {
    if (typeof value[field] !== "string" || !String(value[field]).trim()) throw new Error(`invalid CPB lane field ${field}`);
  }
  if (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) <= 0) throw new Error("invalid CPB lane timeoutMs");
  return value as SolverLaneInput;
}

function fixedCodexAgents() {
  return {
    planner: "codex",
    executor: "codex",
    verifier: "codex",
    reviewer: "codex",
    remediator: "codex",
    security_reviewer: "codex",
    adversarial_verifier: "codex",
  };
}

function cpbLaneEnv(input: SolverLaneInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CPB_ROOT: input.cpbRoot,
    CPB_HUB_ROOT: input.hubRoot,
    CPB_EXECUTOR_ROOT: CPB_ROOT,
    CPB_AGENT_ISOLATE_HOME: "1",
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
    CPB_ACP_DISABLE_WEB_TOOLS: "1",
    CPB_ACP_PERSISTENT_PROCESS: "1",
    CPB_ACP_TIMEOUT_MS: String(input.timeoutMs),
    CPB_ACP_PHASE_TIMEOUT_MS: String(input.timeoutMs),
    CPB_ACP_POOL_TIMEOUT_MS: String(input.timeoutMs),
    CPB_ACP_CODEX_COMMAND: process.env.CPB_ACP_CODEX_COMMAND || "codex-acp",
    CPB_ACP_CODEX_ARGS: JSON.stringify([
      "-c", `model=${JSON.stringify(input.model)}`,
      "-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`,
    ]),
  };
}

async function runCpbLaneWorker(inputPath: string, outputPath: string) {
  const input = validateSolverLaneInput(await readJson(inputPath));
  const env = cpbLaneEnv(input);
  const startedAt = Date.now();
  let result: unknown = null;
  let failure: string | null = null;
  let quotaDelegate: ComparisonQuotaDelegate | null = null;
  let quotaDelegateStarted = false;
  try {
    quotaDelegate = await startComparisonQuotaDelegate(input.hubRoot, env);
    quotaDelegateStarted = true;
    result = await runJobWithServices({
      cpbRoot: input.cpbRoot,
      hubRoot: input.hubRoot,
      project: input.project,
      task: input.task,
      jobId: input.jobId,
      workflow: input.workflow,
      planMode: input.planMode,
      sourcePath: input.worktree,
      sourceContext: {},
      maxRetries: 3,
      agents: input.lane === "cpb_codex" ? fixedCodexAgents() : null,
      env,
    });
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    await stopManagedAcpPool({ cpbRoot: input.cpbRoot, hubRoot: input.hubRoot, env }).catch(() => undefined);
    await stopComparisonQuotaDelegate(quotaDelegate).catch(() => undefined);
  }
  const events = await readEvents(input.cpbRoot, input.project, input.jobId, {
    dataRoot: input.projectRuntimeRoot,
    includeLegacyFallback: false,
  }).catch(() => []);
  await writeJson(outputPath, {
    schemaVersion: 1,
    lane: input.lane,
    solverStartedAt: new Date(startedAt).toISOString(),
    solverEndedAt: new Date().toISOString(),
    solverElapsedMs: Date.now() - startedAt,
    result,
    failure,
    route: { workflow: input.workflow, planMode: input.planMode },
    controlPlane: {
      quotaDelegateStarted,
      quotaDelegateExitCode: quotaDelegate?.child.exitCode ?? null,
      quotaDelegateStderrTail: quotaDelegate ? tail(quotaDelegate.stderr(), 2_000) : null,
    },
    events,
    projectRuntimeRoot: input.projectRuntimeRoot,
  });
  if (failure) process.exitCode = 1;
}

async function resolveRepository(repository: string, manifestDir: string, root: string, taskId: string) {
  const candidate = path.resolve(manifestDir, repository);
  const source = await pathExists(candidate) ? await realpath(candidate) : repository;
  const clonePath = path.join(root, "repositories", `${taskId}.git`);
  await mkdir(path.dirname(clonePath), { recursive: true });
  await checkedCommand("git", ["clone", "--mirror", source, clonePath], root, { timeoutMs: 10 * 60_000 });
  const excludePath = path.join(clonePath, "info", "exclude");
  const existing = await readFile(excludePath, "utf8").catch(() => "");
  if (!existing.split("\n").includes(".codegraph/")) {
    await writeFile(excludePath, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}.codegraph/\n`, "utf8");
  }
  return clonePath;
}

async function resolveBaseSha(repository: string, base: string) {
  const result = await checkedCommand("git", ["rev-parse", "--verify", `${base}^{commit}`], repository);
  return result.stdout.trim();
}

async function createComparisonWorktree(repository: string, baseSha: string) {
  const workspace = await createTemporaryGitWorktree({
    sourcePath: repository,
    revision: baseSha,
    prefix: "cpb-coding-comparison-worktree-",
  });
  try {
    await checkedCommand("codegraph", ["init", workspace.worktreePath], workspace.worktreePath, { timeoutMs: 5 * 60_000 });
    await checkedCommand("codegraph", ["sync", workspace.worktreePath], workspace.worktreePath, { timeoutMs: 5 * 60_000 });
    return workspace;
  } catch (primaryError) {
    try {
      await workspace.cleanup();
    } catch (cleanupError) {
      throw Object.assign(new AggregateError(
        [primaryError, cleanupError],
        "comparison worktree preparation and cleanup both failed",
        { cause: primaryError },
      ), {
        code: "CODING_COMPARISON_WORKTREE_PREPARE_CLEANUP_FAILED",
        primaryError,
        cleanupError,
      });
    }
    throw primaryError;
  }
}

type ComparisonWorkspaceCleanup = {
  root: TemporaryWorkspaceCleanupProof | null;
  rootPreservedForWorktreeRecovery: boolean;
  worktrees: TemporaryWorkspaceCleanupProof[];
  errors: unknown[];
};

export async function cleanupCodingComparisonWorkspaces(
  root: TemporaryWorkspace,
  worktrees: TemporaryGitWorktree[],
): Promise<ComparisonWorkspaceCleanup> {
  const cleanup: ComparisonWorkspaceCleanup = {
    root: null,
    rootPreservedForWorktreeRecovery: false,
    worktrees: [],
    errors: [],
  };
  for (const workspace of [...worktrees].reverse()) {
    try {
      cleanup.worktrees.push(await workspace.cleanup());
    } catch (error) {
      cleanup.errors.push(error);
    }
  }
  if (cleanup.errors.length > 0) {
    cleanup.rootPreservedForWorktreeRecovery = true;
    return cleanup;
  }
  try {
    cleanup.root = await root.cleanup();
  } catch (error) {
    cleanup.errors.push(error);
  }
  return cleanup;
}

function cleanupErrorEvidence(error: unknown) {
  return {
    code: error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code || "CODING_COMPARISON_CLEANUP_FAILED")
      : "CODING_COMPARISON_CLEANUP_FAILED",
    message: errorMessage(error),
    recovery: temporaryWorkspaceErrorDetails(error),
  };
}

async function captureCandidate(worktree: string, baseSha: string): Promise<CandidateSnapshot> {
  const candidate = await captureCandidateArtifact({ cwd: worktree, base: baseSha });
  const replay = await createCandidateReplayBundle({ cwd: worktree, candidate });
  return {
    baseSha: candidate.baseSha,
    treeHash: candidate.treeHash,
    patchSha256: replay.patchSha256,
    patchBytes: replay.patchBytes,
    candidateIdentityHash: candidate.identityHash,
  };
}

async function runChecks(task: CodingComparisonTask, worktree: string) {
  const checks: CheckResult[] = [];
  const evaluationStarted = Date.now();
  for (const check of task.checks) {
    const cwd = path.resolve(worktree, check.cwd || ".");
    const started = Date.now();
    const result = await runCommandTree(check.command, check.args, {
      cwd,
      env: process.env,
      timeoutMs: check.timeoutMs || Math.min(task.timeoutMs, 10 * 60_000),
    });
    checks.push({
      id: check.id,
      command: check.command,
      args: check.args,
      cwd: check.cwd || ".",
      status: result.exitCode === 0 && !result.timedOut && !result.error ? "passed" : "failed",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      elapsedMs: Date.now() - started,
      stdoutTail: tail(result.stdout),
      stderrTail: tail(result.stderr || result.error?.message),
    });
  }
  return { checks, evaluationElapsedMs: Date.now() - evaluationStarted };
}

function cpbTraceMetrics(replay: LooseRecord) {
  const timeline = Array.isArray(replay.timeline) ? replay.timeline.map(recordValue) : [];
  const tools = new Map<string, boolean>();
  let repairCount = 0;
  for (const entry of timeline) {
    const type = String(entry.type || "");
    if (REPAIR_EVENTS.has(type)) repairCount += 1;
    if (entry.kind !== "tool") continue;
    const identity = String(entry.spanId || entry.sequence || randomUUID());
    const status = String(entry.status || recordValue(entry.event).status || "").toLowerCase();
    tools.set(identity, Boolean(tools.get(identity)) || status === "failed" || status === "error");
  }
  return {
    repairCount,
    toolCalls: tools.size || null,
    failedToolCalls: tools.size ? [...tools.values()].filter(Boolean).length : null,
  };
}

async function runNativeSolver(task: CodingComparisonTask, worktree: string, runtimeRoot: string) {
  const home = await createAgentHome(CPB_ROOT, "codex", `comparison-${task.id}-${randomUUID()}`, {
    parentEnv: process.env,
    dataRoot: runtimeRoot,
  });
  const started = Date.now();
  const processResult = await runCommandTree("codex", nativeCodexArgs(task, worktree), {
    cwd: worktree,
    env: { ...process.env, ...home },
    timeoutMs: task.timeoutMs,
  });
  return {
    solverElapsedMs: Date.now() - started,
    processResult,
    parsed: parseNativeCodexJsonl(processResult.stdout),
  };
}

async function runCpbSolver(input: SolverLaneInput, runtimeRoot: string) {
  const inputPath = path.join(runtimeRoot, "solver-input.json");
  const outputPath = path.join(runtimeRoot, "solver-output.json");
  await writeJson(inputPath, input);
  const started = Date.now();
  const processResult = await runCommandTree(process.execPath, [
    SCRIPT_PATH,
    "--cpb-lane-input", inputPath,
    "--cpb-lane-output", outputPath,
  ], {
    cwd: CPB_ROOT,
    // Several production policies (including CodeGraph readiness and retry
    // defaults) are resolved from process.env during module initialization.
    // The isolated worker must therefore start with the same lane environment
    // that runJobWithServices receives, not install it only after imports.
    env: cpbLaneEnv(input),
    timeoutMs: input.timeoutMs,
  });
  const workerOutput = await readJson(outputPath).catch(() => null);
  return {
    solverElapsedMs: Date.now() - started,
    processResult,
    workerOutput: recordValue(workerOutput),
  };
}

async function cleanupLaneResidualProcesses(worktree: string) {
  const termSignaled = await terminateProcessesMatchingPath(worktree, "SIGTERM");
  if (termSignaled > 0) await new Promise((resolve) => setTimeout(resolve, 250));
  const killSignaled = await terminateProcessesMatchingPath(worktree, "SIGKILL");
  return { termSignaled, killSignaled };
}

async function registerComparisonProject(hubRoot: string, input: {
  id: string;
  sourcePath: string;
  cpbRoot: string;
}) {
  const previous = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    return await registerProject(hubRoot, input);
  } finally {
    if (previous === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previous;
  }
}

async function versionEvidence(command: string, args: string[]) {
  const result = await runCommandTree(command, args, { cwd: CPB_ROOT, timeoutMs: 15_000 });
  return {
    command,
    args,
    exitCode: result.exitCode,
    version: tail(result.stdout || result.stderr, 2_000).trim() || null,
  };
}

function externalEvaluationInput(checks: CheckResult[], candidateIdentityHash: string, evaluatorMutatedCandidate: boolean) {
  const failed = checks.some((check) => check.status === "failed");
  const status = failed ? "failed" : evaluatorMutatedCandidate ? "inconclusive" : "passed";
  return {
    evaluator: "coding-comparison-post-terminal-checks",
    status: status as "passed" | "failed" | "inconclusive",
    candidateIdentityHash,
    summary: evaluatorMutatedCandidate
      ? "post-terminal evaluator changed the candidate tree; result is not accepted as a clean pass"
      : `${checks.filter((check) => check.status === "passed").length}/${checks.length} checks passed`,
    checks: checks.map((check) => ({
      name: check.id,
      command: [check.command, ...check.args].join(" "),
      status: check.status,
      reason: check.status === "failed" ? check.stderrTail || check.stdoutTail : null,
    })),
  };
}

async function runTaskLane({
  lane,
  task,
  baseSha,
  worktree,
  laneRoot,
  inputFingerprint,
  evaluationFingerprint,
}: {
  lane: CodingComparisonLane;
  task: CodingComparisonTask;
  baseSha: string;
  worktree: string;
  laneRoot: string;
  inputFingerprint: string;
  evaluationFingerprint: string;
}): Promise<CodingComparisonLaneResult> {
  const before = await captureCandidate(worktree, baseSha);
  const baseTree = (await checkedCommand("git", ["rev-parse", `${baseSha}^{tree}`], worktree)).stdout.trim();
  if (before.treeHash !== baseTree) throw new Error(`${lane} worktree differs from base before solver execution`);

  let solverElapsedMs = 0;
  let status = "failed";
  let rawSolver: LooseRecord = {};
  let repairCount = 0;
  let toolCalls: number | null = null;
  let failedToolCalls: number | null = null;
  let telemetry = extractCodingComparisonTelemetry();
  let cpbContext: { cpbRoot: string; project: string; jobId: string; dataRoot: string } | null = null;

  if (lane === "native_codex") {
    const native = await runNativeSolver(task, worktree, laneRoot);
    solverElapsedMs = native.solverElapsedMs;
    status = native.processResult.timedOut ? "timed_out" : native.processResult.exitCode === 0 ? "completed" : "failed";
    toolCalls = native.parsed.toolCalls;
    failedToolCalls = native.parsed.failedToolCalls;
    telemetry = native.parsed;
    rawSolver = {
      exitCode: native.processResult.exitCode,
      timedOut: native.processResult.timedOut,
      aborted: native.processResult.aborted,
      stderrTail: tail(native.processResult.stderr),
      finalOutput: native.parsed.finalOutput,
      malformedJsonlLines: native.parsed.malformedLines,
    };
  } else {
    const cpbRoot = path.join(laneRoot, "cpb");
    const hubRoot = path.join(laneRoot, "hub");
    const requestedProject = `${task.id}-${lane}`;
    await mkdir(cpbRoot, { recursive: true });
    const registered = await registerComparisonProject(hubRoot, {
      id: requestedProject,
      sourcePath: worktree,
      cpbRoot: CPB_ROOT,
    });
    // registerProject canonicalizes identifiers (for example `_` to `-`). All
    // runtime/event keys must use the returned identity, never the request.
    const project = registered.id;
    const jobId = `job-${project}`;
    const input = buildSolverLaneInput({
      lane,
      task,
      baseSha,
      worktree,
      cpbRoot,
      hubRoot,
      project,
      projectRuntimeRoot: registered.projectRuntimeRoot,
      jobId,
    });
    const cpb = await runCpbSolver(input, laneRoot);
    solverElapsedMs = cpb.solverElapsedMs;
    const jobResult = recordValue(cpb.workerOutput.result);
    status = cpb.processResult.timedOut ? "timed_out" : String(jobResult.status || (cpb.processResult.exitCode === 0 ? "failed" : "worker_failed"));
    telemetry = extractCodingComparisonTelemetry(cpb.workerOutput, jobResult);
    rawSolver = {
      processExitCode: cpb.processResult.exitCode,
      processTimedOut: cpb.processResult.timedOut,
      processStderrTail: tail(cpb.processResult.stderr),
      workerFailure: cpb.workerOutput.failure || null,
      controlPlane: cpb.workerOutput.controlPlane || null,
      result: jobResult,
    };
    cpbContext = { cpbRoot, project, jobId, dataRoot: registered.projectRuntimeRoot };
  }

  const residualProcessCleanup = await cleanupLaneResidualProcesses(worktree);
  rawSolver.residualProcessCleanup = residualProcessCleanup;

  // This snapshot is taken only after the solver process has terminated. The
  // evaluator command and arguments were never present in either solver input.
  const candidate = await captureCandidate(worktree, baseSha);
  const evaluation = await runChecks(task, worktree);
  const afterEvaluation = await captureCandidate(worktree, baseSha);
  const evaluatorMutatedCandidate = afterEvaluation.treeHash !== candidate.treeHash;
  const external = externalEvaluationInput(evaluation.checks, candidate.candidateIdentityHash, evaluatorMutatedCandidate);
  let replay: LooseRecord | null = null;
  if (cpbContext) {
    await recordExternalEvaluation({ ...cpbContext, evaluation: external });
    replay = recordValue(await buildJobReplay({ ...cpbContext, includePatch: false }));
    const traceMetrics = cpbTraceMetrics(replay);
    repairCount = traceMetrics.repairCount;
    toolCalls = traceMetrics.toolCalls;
    failedToolCalls = traceMetrics.failedToolCalls;
    telemetry = extractCodingComparisonTelemetry(rawSolver, replay);
  }
  const correct = external.status === "passed";
  return {
    lane,
    taskId: task.id,
    inputFingerprint,
    evaluationFingerprint,
    permissionFingerprint: codingComparisonPermissionFingerprint(),
    baseSha,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    timeoutMs: task.timeoutMs,
    status,
    metrics: {
      correct,
      firstPass: correct && status === "completed" && repairCount === 0,
      repairCount,
      toolCalls,
      failedToolCalls,
      solverElapsedMs,
      evaluationElapsedMs: evaluation.evaluationElapsedMs,
      inputTokens: telemetry.inputTokens,
      cachedInputTokens: telemetry.cachedInputTokens,
      outputTokens: telemetry.outputTokens,
      reasoningOutputTokens: telemetry.reasoningOutputTokens,
      totalTokens: telemetry.totalTokens,
      tokenCoverage: telemetry.tokenCoverage,
    },
    candidate,
    evaluatorMutatedCandidate,
    externalEvaluation: external,
    checks: evaluation.checks,
    solver: rawSolver,
    replay,
  };
}

export async function runCodingComparison(options: CliOptions) {
  const rawManifest = await readJson(options.manifestPath);
  const manifest = validateCodingComparisonManifest(rawManifest);
  const runId = `coding-comparison-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const rootWorkspace = await createTemporaryWorkspace({ prefix: "cpb-coding-comparison-" });
  const root = rootWorkspace.rootPath;
  const results: CodingComparisonLaneResult[] = [];
  const worktrees: TemporaryGitWorktree[] = [];
  let versions: LooseRecord = { node: process.version };
  let completedReport: LooseRecord | null = null;
  let primaryError: unknown = null;
  try {
    versions = {
      codex: await versionEvidence("codex", ["--version"]),
      codexAcp: await versionEvidence(process.env.CPB_ACP_CODEX_COMMAND || "codex-acp", ["--version"]),
      codexAcpPackage: await versionEvidence("npm", ["list", "-g", "@zed-industries/codex-acp", "--depth=0", "--json"]),
      codegraph: await versionEvidence("codegraph", ["--version"]),
      node: process.version,
    };
    for (const [taskIndex, task] of manifest.tasks.entries()) {
      const repository = await resolveRepository(task.repository, path.dirname(options.manifestPath), root, task.id);
      const baseSha = await resolveBaseSha(repository, task.base);
      const inputFingerprint = codingComparisonInputFingerprint(task, baseSha);
      const evaluationFingerprint = codingComparisonEvaluationFingerprint(task);
      const lanes = new Map<CodingComparisonLane, { worktree: string; laneRoot: string }>();
      for (const lane of CODING_COMPARISON_LANES) {
        const laneRoot = path.join(root, "tasks", task.id, lane);
        await mkdir(laneRoot, { recursive: true });
        const worktree = await createComparisonWorktree(repository, baseSha);
        worktrees.push(worktree);
        lanes.set(lane, { worktree: worktree.worktreePath, laneRoot });
      }
      const order = laneOrderForTask(taskIndex);
      for (const lane of order) {
        const prepared = lanes.get(lane);
        if (!prepared) throw new Error(`missing prepared lane ${lane}`);
        const result = await runTaskLane({
          lane,
          task,
          baseSha,
          worktree: prepared.worktree,
          laneRoot: prepared.laneRoot,
          inputFingerprint,
          evaluationFingerprint,
        });
        result.laneOrder = order;
        results.push(result);
        await writeJson(options.outputPath, {
          schemaVersion: 1,
          runId,
          status: "running",
          root: options.keepWorktrees ? root : null,
          retainedWorktreeRoots: options.keepWorktrees ? worktrees.map((entry) => entry.rootPath) : null,
          versions,
          results,
          summary: buildCodingComparisonSummary(results),
        });
      }
    }
    completedReport = {
      schemaVersion: 1,
      runId,
      status: "completed",
      root: options.keepWorktrees ? root : null,
      retainedWorktreeRoots: options.keepWorktrees ? worktrees.map((entry) => entry.rootPath) : null,
      generatedAt: new Date().toISOString(),
      versions,
      results,
      summary: buildCodingComparisonSummary(results),
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanup = options.keepWorktrees
    ? null
    : await cleanupCodingComparisonWorkspaces(rootWorkspace, worktrees);
  const cleanupErrors = cleanup?.errors || [];
  if (primaryError || cleanupErrors.length > 0) {
    const operationError = primaryError && cleanupErrors.length > 0
      ? Object.assign(new AggregateError(
          [primaryError, ...cleanupErrors],
          "coding comparison and temporary workspace cleanup failed",
          { cause: primaryError },
        ), {
          code: "CODING_COMPARISON_OPERATION_CLEANUP_FAILED",
          primaryError,
          cleanupErrors,
        })
      : primaryError || Object.assign(new AggregateError(
          cleanupErrors,
          "coding comparison temporary workspace cleanup failed",
          { cause: cleanupErrors[0] },
        ), {
          code: "CODING_COMPARISON_CLEANUP_FAILED",
          cleanupErrors,
        });
    const failedReport = {
      schemaVersion: 1,
      runId,
      status: "failed",
      root: options.keepWorktrees || cleanup?.rootPreservedForWorktreeRecovery ? root : null,
      retainedWorktreeRoots: options.keepWorktrees ? worktrees.map((entry) => entry.rootPath) : null,
      failedAt: new Date().toISOString(),
      failure: {
        kind: cleanupErrors.length > 0
          ? "comparison_runner_or_cleanup_failure"
          : "comparison_runner_failure",
        message: errorMessage(operationError),
        primary: primaryError ? errorMessage(primaryError) : null,
        cleanupErrors: cleanupErrors.map(cleanupErrorEvidence),
      },
      temporaryCleanup: cleanup ? {
        root: cleanup.root,
        rootPreservedForWorktreeRecovery: cleanup.rootPreservedForWorktreeRecovery,
        worktrees: cleanup.worktrees,
      } : {
        policy: "retained",
        root,
        worktreeRoots: worktrees.map((entry) => entry.rootPath),
      },
      versions,
      results,
      summary: buildCodingComparisonSummary(results),
    };
    try {
      await writeJson(options.outputPath, failedReport);
    } catch (reportError) {
      throw Object.assign(new AggregateError(
        [operationError, reportError],
        "coding comparison failure report publication also failed",
        { cause: operationError },
      ), {
        code: "CODING_COMPARISON_FAILURE_REPORT_FAILED",
        operationError,
        reportError,
      });
    }
    throw operationError;
  }

  if (!completedReport) throw new Error("coding comparison completed without a report");
  const report = {
    ...completedReport,
    temporaryCleanup: cleanup ? {
      root: cleanup.root,
      rootPreservedForWorktreeRecovery: cleanup.rootPreservedForWorktreeRecovery,
      worktrees: cleanup.worktrees,
    } : {
      policy: "retained",
      root,
      worktreeRoots: worktrees.map((entry) => entry.rootPath),
    },
  };
  await writeJson(options.outputPath, report);
  return report;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if ("workerInput" in options) {
    await runCpbLaneWorker(options.workerInput, options.workerOutput);
    return;
  }
  const report = await runCodingComparison(options);
  const reportRecord = recordValue(report);
  process.stdout.write(`${JSON.stringify({
    runId: reportRecord.runId,
    status: reportRecord.status,
    output: options.outputPath,
    summary: reportRecord.summary,
  }, null, 2)}\n`);
}

const invokedAsScript = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
