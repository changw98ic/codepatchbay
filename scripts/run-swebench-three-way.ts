#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect as connectTcp, createServer } from "node:net";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { registerProject } from "../server/services/hub/hub-registry.js";
import {
  validateCandidateReplayBundle,
  type CandidateReplayBundle,
} from "../core/engine/candidate-replay.js";
import { envForAgent } from "../server/services/acp/acp-pool.js";
import { isDelegateAlive } from "../server/services/quota-delegate-client.js";
import { createAgentHome, isolatedAgentToolPath } from "../core/agents/isolation.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import type { LooseRecord } from "../shared/types.js";
import {
  SOURCE_BOUNDARY_PROFILE,
  claudeFilesystemBoundarySettings,
  codexFilesystemBoundaryConfigArgs,
  type AgentFilesystemBoundary,
} from "../core/policy/filesystem-boundary.js";
import { derivePhaseBudgetPolicy } from "../core/policy/phase-budget.js";
import { buildDatasetRowsUrl } from "./queue-swebench-batch.js";
import { runManagedWorker, type ProductValidationAgents } from "./run-swebench-product-validation.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ROOT = path.resolve(import.meta.dirname, "..");
const DATASET = "SWE-bench/SWE-bench_Verified";
const SPLIT = "test";
const LANES = ["native_codex", "native_claude_glm", "cpb_high_assurance"] as const;
const CPB_ALLOWED_AGENTS = ["codex", "claude-glm"] as const;
type Lane = typeof LANES[number];
type SolverLaneConcurrency = Record<Lane, number>;

const USAGE = `Usage: node dist/scripts/run-swebench-three-way.js [options]

Options:
  --run-id <id>                    Stable run identifier
  --run-root <path>                Persistent output root
  --count <n>                      Number of Verified tasks (default: 50)
  --offset <n>                     Dataset row offset (default: 0)
  --lanes <csv>                    native_codex,native_claude_glm,cpb_high_assurance
  --timeout-ms <ms>                Per-task timeout (default: 3600000)
  --solver-lane-concurrency <spec> Concurrent tasks per independent lane (default: 1)
                                      Example: native_codex=2,native_claude_glm=2,cpb_high_assurance=2
  --solver-attempts <n>            Max attempts for transient solver failures (default: 3)
  --solver-retry-backoff-ms <ms>   Base backoff between transient attempts (default: 60000)
  --codex-model <model>             Freeze the Codex model for native and CPB roles
  --codex-reasoning-effort <level> Freeze the Codex reasoning effort for native and CPB roles
  --glm-model <model>               Freeze the GLM model for native Claude and CPB roles
  --harness-timeout-seconds <sec>  Official harness per-instance timeout
  --harness-workers <n>            Official harness worker count (default: 2)
  --harness-attempts <n>           Max instance-level harness attempts (default: 6)
  --harness-retry-backoff-ms <ms>  Base backoff for harness infrastructure errors (default: 60000)
  --no-score                       Stop after candidate generation
  --score-only                     Score an already complete frozen run
  --help                           Show this help without creating a run
`;

type SolverTask = {
  opaqueId: string;
  rowIndex: number;
  repository: string;
  baseCommit: string;
  task: string;
  taskSha256: string;
};

type EvaluatorTask = {
  opaqueId: string;
  rowIndex: number;
  instanceId: string;
  failToPass: string[];
  passToPass: string[];
};

type DatasetRow = { rowIndex: number; row: LooseRecord };

type DatasetCacheEnvelope = {
  schemaVersion: 1;
  dataset: string;
  split: string;
  offset: number;
  count: number;
  source: "hf_rows_api" | "python_datasets_offline";
  acquiredAt: string;
  rowsSha256: string;
  rows: DatasetRow[];
};

type ObservedModelAttestation = {
  initModels: string[];
  assistantModels: string[];
  modelUsageModels: string[];
};

type LaneResult = {
  lane: Lane;
  opaqueId: string;
  status: "completed" | "failed" | "blocked";
  startedAt: string;
  completedAt: string;
  sourcePath: string;
  patchPath: string;
  patchSha256: string;
  patchBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: string | null;
  promptLeakage: string[];
  stdoutPath: string;
  stderrPath: string;
  metadata?: LooseRecord;
};

export function classifySolverOutcome(result: Pick<LaneResult, "status"> & Partial<Pick<LaneResult, "timedOut" | "metadata" | "error">>) {
  if (result.status === "completed") return "solver_completed";
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const jobFailure = isRecord(metadata.jobFailure) ? metadata.jobFailure : {};
  const cause = isRecord(jobFailure.cause) ? jobFailure.cause : {};
  const verificationInfrastructure = isRecord(cause.verificationInfrastructure)
    ? cause.verificationInfrastructure
    : {};
  if (verificationInfrastructure.failureClass === "verification_infrastructure") {
    return "verification_infrastructure";
  }
  if (metadata.failureStage === "source_prepare") return "source_infrastructure";
  if (result.timedOut || metadata.transientExhausted === true) return "solver_infrastructure";
  const kind = text(jobFailure.kind);
  if (kind === "verification_failed") return "semantic_verification_failure";
  if ([
    "scope_violation",
    "policy_invalid",
    "artifact_invalid",
    "verdict_invalid",
    "checklist_invalid",
    "human_approval_required",
  ].includes(kind)) return "workflow_policy_failure";
  if (/^(?:agent_|provider_|runtime_|timeout$)/.test(kind)) return "solver_infrastructure";
  return "unclassified_solver_failure";
}

export function summarizeSolverOutcomes(results: Array<Pick<LaneResult, "lane" | "status"> & Partial<Pick<LaneResult, "timedOut" | "metadata" | "error">>>) {
  const byLane: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  for (const result of results) {
    const failureClass = classifySolverOutcome(result);
    byLane[result.lane] ||= {};
    byLane[result.lane][failureClass] = (byLane[result.lane][failureClass] || 0) + 1;
    totals[failureClass] = (totals[failureClass] || 0) + 1;
  }
  return { totals, byLane };
}

export function correlateSolverAndHarnessOutcomes(
  results: Array<Pick<LaneResult, "lane" | "opaqueId" | "status"> & Partial<Pick<LaneResult, "timedOut" | "metadata" | "error">>>,
  evaluatorTasks: Array<Pick<EvaluatorTask, "opaqueId" | "instanceId">>,
  scores: LooseRecord[],
) {
  const instanceByOpaque = new Map(evaluatorTasks.map((task) => [task.opaqueId, task.instanceId]));
  const scoreByLane = new Map(scores.map((score) => [text(score.lane), score]));
  const totals: Record<string, number> = {};
  const byLane: Record<string, Record<string, number>> = {};
  const internalFalseNegatives: Array<{ lane: Lane; opaqueId: string; instanceId: string }> = [];
  for (const result of results) {
    const instanceId = instanceByOpaque.get(result.opaqueId) || "";
    const score = scoreByLane.get(result.lane) || {};
    const resolvedIds = new Set(Array.isArray(score.resolvedIds) ? score.resolvedIds.map(String) : []);
    const unresolvedIds = new Set(Array.isArray(score.unresolvedIds) ? score.unresolvedIds.map(String) : []);
    const errorIds = new Set(Array.isArray(score.errorIds) ? score.errorIds.map(String) : []);
    const harnessOutcome = resolvedIds.has(instanceId)
      ? "official_resolved"
      : unresolvedIds.has(instanceId)
        ? "official_implementation_failure"
        : errorIds.has(instanceId)
          ? "official_evaluation_infrastructure_error"
          : "official_outcome_unknown";
    const solverOutcome = classifySolverOutcome(result);
    const key = `${solverOutcome}->${harnessOutcome}`;
    totals[key] = (totals[key] || 0) + 1;
    byLane[result.lane] ||= {};
    byLane[result.lane][key] = (byLane[result.lane][key] || 0) + 1;
    if (solverOutcome === "verification_infrastructure" && harnessOutcome === "official_resolved") {
      internalFalseNegatives.push({ lane: result.lane, opaqueId: result.opaqueId, instanceId });
    }
  }
  return { totals, byLane, internalFalseNegatives };
}

export function summarizeCandidateFreeze(results: Array<Pick<LaneResult, "lane" | "opaqueId" | "status" | "patchPath" | "patchSha256" | "patchBytes" | "error"> & Partial<Pick<LaneResult, "timedOut" | "metadata">>>) {
  const blocked = results.filter((result) => result.status === "blocked");
  const solverFailures = results.filter((result) => result.status === "failed");
  const missingArtifacts = results.filter((result) => !result.patchPath || !/^[a-f0-9]{64}$/.test(result.patchSha256));
  return {
    complete: blocked.length === 0 && missingArtifacts.length === 0,
    blocked: blocked.map((result) => ({ lane: result.lane, opaqueId: result.opaqueId, error: result.error })),
    missingArtifacts: missingArtifacts.map((result) => ({ lane: result.lane, opaqueId: result.opaqueId })),
    solverFailures: solverFailures.map((result) => ({
      lane: result.lane,
      opaqueId: result.opaqueId,
      error: result.error,
      patchBytes: result.patchBytes,
      failureClass: classifySolverOutcome(result),
    })),
    solverOutcomeSummary: summarizeSolverOutcomes(results),
  };
}

export function harnessResumeDecision(summary: unknown, expected: {
  lane: Lane;
  runId: string;
  predictionsSha256: string;
  totalInstances: number;
}) {
  if (!isRecord(summary)) return { reusable: false, reason: "summary_missing_or_invalid" };
  const completedInstances = Number(summary.completedInstances);
  const emptyPatchInstances = Number(summary.emptyPatchInstances);
  const errorInstances = Number(summary.errorInstances);
  const mismatches = [
    ...(summary.lane === expected.lane ? [] : ["lane"]),
    ...(summary.runId === expected.runId ? [] : ["run_id"]),
    ...(summary.predictionsSha256 === expected.predictionsSha256 ? [] : ["predictions_sha256"]),
    ...(Number(summary.totalInstances) === expected.totalInstances ? [] : ["total_instances"]),
    ...(Number(summary.submittedInstances) === expected.totalInstances ? [] : ["submitted_instances"]),
    ...(
      errorInstances === 0
      && completedInstances + emptyPatchInstances === expected.totalInstances
        ? []
        : ["incomplete_or_error"]
    ),
    ...(typeof summary.aggregatePath === "string" && summary.aggregatePath ? [] : ["aggregate_path"]),
  ];
  return mismatches.length === 0
    ? { reusable: true, reason: null, aggregatePath: String(summary.aggregatePath) }
    : { reusable: false, reason: `summary_mismatch:${mismatches.join(",")}` };
}

export function buildHarnessEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const currentPath = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const helperPaths = process.platform === "darwin"
    ? ["/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin"]
    : ["/usr/local/bin"];
  return {
    ...env,
    PATH: [...new Set([...currentPath, ...helperPaths])].join(path.delimiter),
  };
}

type Options = {
  runRoot: string;
  runId: string;
  count: number;
  offset: number;
  timeoutMs: number;
  solverLaneConcurrency: SolverLaneConcurrency;
  solverAttempts: number;
  solverRetryBackoffMs: number;
  codexModel: string;
  codexReasoningEffort: string;
  glmModel: string;
  harnessTimeoutSeconds: number;
  maxHarnessWorkers: number;
  harnessAttempts: number;
  harnessRetryBackoffMs: number;
  execute: boolean;
  score: boolean;
  keepFailed: boolean;
  lanes: Lane[];
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
};

function now() {
  return new Date().toISOString();
}

const sourceCacheTails = new Map<string, Promise<void>>();

async function withSourceCacheLock<T>(cachePath: string, operation: () => Promise<T>) {
  const previous = sourceCacheTails.get(cachePath) || Promise.resolve();
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => hold);
  sourceCacheTails.set(cachePath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sourceCacheTails.get(cachePath) === tail) sourceCacheTails.delete(cachePath);
  }
}

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || null : null;
}

function intArg(args: string[], flag: string, fallback: number) {
  const raw = argValue(args, flag);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

export function parseSolverLaneConcurrency(raw: string | null | undefined): SolverLaneConcurrency {
  const defaults = Object.fromEntries(LANES.map((lane) => [lane, 1])) as SolverLaneConcurrency;
  if (!raw?.trim()) return defaults;
  if (/^\d+$/.test(raw.trim())) {
    const concurrency = Number.parseInt(raw.trim(), 10);
    if (concurrency < 1) throw new Error("--solver-lane-concurrency must be at least 1");
    return Object.fromEntries(LANES.map((lane) => [lane, concurrency])) as SolverLaneConcurrency;
  }

  const parsed = { ...defaults };
  const seen = new Set<Lane>();
  for (const item of raw.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    const [laneValue, concurrencyValue, ...extra] = item.split("=").map((entry) => entry.trim());
    if (extra.length > 0 || !(LANES as readonly string[]).includes(laneValue)) {
      throw new Error(`--solver-lane-concurrency contains an unknown lane: ${laneValue || item}`);
    }
    const lane = laneValue as Lane;
    if (seen.has(lane)) throw new Error(`--solver-lane-concurrency repeats lane: ${lane}`);
    const concurrency = Number.parseInt(concurrencyValue, 10);
    if (!/^\d+$/.test(concurrencyValue) || concurrency < 1) {
      throw new Error(`--solver-lane-concurrency for ${lane} must be at least 1`);
    }
    parsed[lane] = concurrency;
    seen.add(lane);
  }
  if (seen.size === 0) throw new Error("--solver-lane-concurrency must not be empty");
  return parsed;
}

export async function runIndependentLaneQueues<T>(input: {
  lanes: readonly Lane[];
  taskCount: number;
  laneConcurrency: SolverLaneConcurrency;
  run: (lane: Lane, taskIndex: number) => Promise<T>;
}) {
  const laneOrder = new Map(input.lanes.map((lane, index) => [lane, index]));
  const outputs: Array<{ lane: Lane; taskIndex: number; value: T }> = [];
  const laneErrors: Array<{ lane: Lane; error: unknown }> = [];
  const workers: Promise<void>[] = [];

  for (const lane of input.lanes) {
    let nextTaskIndex = 0;
    let laneError: unknown = null;
    const workerCount = Math.min(input.taskCount, Math.max(1, input.laneConcurrency[lane]));
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      workers.push((async () => {
        while (laneError === null) {
          const taskIndex = nextTaskIndex;
          nextTaskIndex += 1;
          if (taskIndex >= input.taskCount) return;
          try {
            outputs.push({ lane, taskIndex, value: await input.run(lane, taskIndex) });
          } catch (error) {
            if (laneError === null) {
              laneError = error;
              laneErrors.push({ lane, error });
            }
          }
        }
      })());
    }
  }

  await Promise.all(workers);
  if (laneErrors.length > 0) throw laneErrors[0].error;
  return outputs.sort((left, right) => (
    left.taskIndex - right.taskIndex
    || (laneOrder.get(left.lane) || 0) - (laneOrder.get(right.lane) || 0)
  ));
}

function parseOptions(argv: string[]): Options {
  const args = argv.slice(2);
  const runId = argValue(args, "--run-id") || `verified-50-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runRoot = path.resolve(argValue(args, "--run-root") || path.join(REPO_ROOT, ".cpb-evaluations", runId));
  const laneArg = argValue(args, "--lanes");
  const lanes = laneArg
    ? laneArg.split(",").map((entry) => entry.trim()).filter((entry): entry is Lane => (LANES as readonly string[]).includes(entry))
    : [...LANES];
  if (lanes.length === 0 || (laneArg && lanes.length !== laneArg.split(",").filter(Boolean).length)) {
    throw new Error(`--lanes must contain only: ${LANES.join(",")}`);
  }
  return {
    runRoot,
    runId,
    count: intArg(args, "--count", 50),
    offset: intArg(args, "--offset", 0),
    timeoutMs: intArg(args, "--timeout-ms", 3_600_000),
    solverLaneConcurrency: parseSolverLaneConcurrency(argValue(args, "--solver-lane-concurrency")),
    solverAttempts: Math.max(1, intArg(args, "--solver-attempts", 3)),
    solverRetryBackoffMs: intArg(args, "--solver-retry-backoff-ms", 60_000),
    codexModel: text(argValue(args, "--codex-model") || process.env.CPB_COMPARISON_CODEX_MODEL).trim(),
    codexReasoningEffort: text(argValue(args, "--codex-reasoning-effort") || process.env.CPB_COMPARISON_CODEX_REASONING_EFFORT).trim(),
    glmModel: text(argValue(args, "--glm-model") || process.env.CPB_COMPARISON_GLM_MODEL || process.env.ZHIPU_MODEL || process.env.GLM_MODEL).trim(),
    harnessTimeoutSeconds: intArg(args, "--harness-timeout-seconds", 1_800),
    maxHarnessWorkers: Math.max(1, intArg(args, "--harness-workers", 2)),
    harnessAttempts: Math.max(1, intArg(args, "--harness-attempts", 6)),
    harnessRetryBackoffMs: intArg(args, "--harness-retry-backoff-ms", 60_000),
    execute: !args.includes("--score-only"),
    score: !args.includes("--no-score"),
    keepFailed: args.includes("--keep-failed"),
    lanes,
  };
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function arrayFromJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function effectiveProviderModel(value: string) {
  return value.trim().replace(/\[[^\]]+\]$/, "");
}

export function observedModelAttestation(jsonl: string): ObservedModelAttestation {
  const initModels = new Set<string>();
  const assistantModels = new Set<string>();
  const modelUsageModels = new Set<string>();
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: LooseRecord;
    try {
      event = JSON.parse(line) as LooseRecord;
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") {
      initModels.add(event.model);
    }
    if (event.type === "assistant" && isRecord(event.message) && typeof event.message.model === "string") {
      assistantModels.add(event.message.model);
    }
    if (event.type === "result" && isRecord(event.modelUsage)) {
      for (const model of Object.keys(event.modelUsage)) modelUsageModels.add(model);
    }
  }
  return {
    initModels: [...initModels].sort(),
    assistantModels: [...assistantModels].sort(),
    modelUsageModels: [...modelUsageModels].sort(),
  };
}

export function observedModelContractViolation(
  attestation: ObservedModelAttestation,
  expectedModel: string,
) {
  // Claude CLI labels locally synthesized transport/quota errors as
  // model="<synthetic>". That is not a provider model identity and must not
  // turn a retryable 429/529 into a permanent model-drift block. The pinned
  // init event still attests which provider model the failed request targeted.
  const providerAssistantModels = attestation.assistantModels.filter((model) => model !== "<synthetic>");
  if (providerAssistantModels.length === 0) {
    return attestation.assistantModels.includes("<synthetic>")
      && attestation.initModels.includes(expectedModel)
      ? null
      : "observed_assistant_model_missing";
  }
  const unexpected = providerAssistantModels.filter((model) => model !== expectedModel);
  return unexpected.length > 0
    ? `observed_assistant_model_mismatch:${unexpected.join(",")}:expected:${expectedModel}`
    : null;
}

export function agentLaunchContractViolation(
  auditJsonl: string,
  allowedAgents: readonly string[],
) {
  const allowed = new Set(allowedAgents);
  let launchCount = 0;
  let lineNumber = 0;
  for (const line of auditJsonl.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event: LooseRecord;
    try {
      event = JSON.parse(line) as LooseRecord;
    } catch {
      return `agent_launch_audit_invalid_json:${lineNumber}`;
    }
    if (event.event !== "agent_launch") continue;
    launchCount += 1;
    const agent = text(event.agent).trim();
    if (!agent) return `agent_launch_missing_agent:${lineNumber}`;
    if (!allowed.has(agent)) return `agent_launch_outside_contract:${agent}`;
  }
  return launchCount > 0 ? null : "agent_launch_audit_missing";
}

function comparisonProviderFamily(agent: string) {
  const normalized = agent.trim().toLowerCase();
  if (normalized === "codex" || normalized.startsWith("codex-") || normalized === "openai") return "codex";
  if (normalized === "claude-glm" || normalized.startsWith("glm-")) return "glm";
  if (normalized === "claude" || normalized.startsWith("claude-")) return "claude";
  return normalized;
}

export function independentVerificationContractViolation(eventJsonl: string) {
  let finalMutator: { agent: string; index: number; phase: string } | null = null;
  let finalVerifier: { agent: string; index: number } | null = null;
  let lineNumber = 0;
  for (const line of eventJsonl.split(/\r?\n/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let event: LooseRecord;
    try {
      event = JSON.parse(line) as LooseRecord;
    } catch {
      return `independent_verification_audit_invalid_json:${lineNumber}`;
    }
    if (event.type !== "phase_result" || event.status !== "passed") continue;
    const phase = text(event.phase).trim();
    const agent = text(event.agent).trim();
    if ((phase === "execute" || phase === "remediate") && agent) {
      finalMutator = { agent, index: lineNumber, phase };
    }
    if ((phase === "verify" || phase === "adversarial_verify") && agent) {
      finalVerifier = { agent, index: lineNumber };
    }
  }
  if (!finalMutator) return "independent_verification_mutator_missing";
  if (!finalVerifier) return "independent_verification_verifier_missing";
  if (finalVerifier.index < finalMutator.index) return "independent_verification_not_after_final_mutation";
  const mutatorFamily = comparisonProviderFamily(finalMutator.agent);
  const verifierFamily = comparisonProviderFamily(finalVerifier.agent);
  return mutatorFamily === verifierFamily
    ? `independent_verification_provider_reuse:${finalMutator.agent}:${finalVerifier.agent}`
    : null;
}

export function buildNativeClaudeIsolatedEnv(
  laneRoot: string,
  providerEnv: NodeJS.ProcessEnv,
) {
  const agentHome = path.join(laneRoot, "agent-homes", "claude-glm");
  const tempRoot = path.join(laneRoot, "tmp", "claude-glm");
  const xdgConfigHome = path.join(agentHome, ".config");
  const xdgDataHome = path.join(agentHome, ".local", "share");
  const xdgCacheHome = path.join(agentHome, ".cache");
  return {
    ...providerEnv,
    PATH: isolatedAgentToolPath(providerEnv.PATH),
    HOME: agentHome,
    CLAUDE_CONFIG_DIR: path.join(agentHome, ".claude"),
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_CACHE_HOME: xdgCacheHome,
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
  } as NodeJS.ProcessEnv;
}

export function buildNativeClaudeSettings(
  sourcePath: string,
  agentHome: string,
  tempRoot: string,
  guardScriptPath: string,
  boundary: AgentFilesystemBoundary,
) {
  const readBoundary = claudeFilesystemBoundarySettings(boundary, [sourcePath, agentHome, tempRoot]);
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {
        allowWrite: [sourcePath, agentHome, tempRoot],
        denyRead: readBoundary.denyRead,
        allowRead: readBoundary.allowRead,
      },
      network: {
        allowedDomains: [],
      },
    },
    permissions: {
      allow: ["Read", "Edit", "Write", "Bash"],
      deny: ["WebSearch", "WebFetch", ...readBoundary.permissionDeny],
    },
    hooks: {
      PreToolUse: [{
        matcher: "Read|Edit|Write|MultiEdit|Bash",
        hooks: [{
          type: "command",
          command: [process.execPath, guardScriptPath, sourcePath].map(shellQuote).join(" "),
          timeout: 10,
        }],
      }],
    },
  };
}

export function buildNativeClaudeArgs(model: string, settingsPath: string, prompt: string) {
  return [
    "-p", "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--permission-mode", "dontAsk", "--no-session-persistence",
    "--setting-sources", "user", "--settings", settingsPath,
    "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}",
    "--disable-slash-commands", "--tools", "Read,Edit,Write,Glob,Grep,Bash",
    ...(model ? ["--model", model] : []),
    prompt,
  ];
}

export function buildExecutionContract(options: Pick<Options,
  "runId" | "count" | "offset" | "lanes" | "timeoutMs" | "solverLaneConcurrency" | "solverAttempts" | "solverRetryBackoffMs"
  | "harnessTimeoutSeconds" | "maxHarnessWorkers" | "harnessAttempts" | "harnessRetryBackoffMs"
  | "codexModel" | "codexReasoningEffort" | "glmModel"
>, binaries: { codex: string; claude: string; codexAcp: LooseRecord }) {
  const phaseBudgetsByRisk = Object.fromEntries(
    (["low", "medium", "high", "critical"] as const).map((riskLevel) => {
      const policy = derivePhaseBudgetPolicy({
        sourceContext: {
          assurance: { mode: "high" },
          riskMap: { riskLevel },
        },
      });
      return [riskLevel, policy.phases];
    }),
  );
  const contract = {
    schemaVersion: 16,
    runId: options.runId,
    dataset: DATASET,
    split: SPLIT,
    count: options.count,
    offset: options.offset,
    lanes: [...options.lanes],
    solver: {
      timeoutMs: options.timeoutMs,
      laneConcurrency: { ...options.solverLaneConcurrency },
      attempts: options.solverAttempts,
      retryBackoffMs: options.solverRetryBackoffMs,
      retryableToolBudgetExceeded: true,
      providerResetAwareBackoff: true,
    },
    harness: {
      timeoutSeconds: options.harnessTimeoutSeconds,
      maxWorkers: options.maxHarnessWorkers,
      attempts: options.harnessAttempts,
      retryBackoffMs: options.harnessRetryBackoffMs,
    },
    models: {
      codex: {
        requested: options.codexModel,
        effective: effectiveProviderModel(options.codexModel),
        reasoningEffort: options.codexReasoningEffort,
      },
      claudeGlm: {
        requested: options.glmModel,
        effective: effectiveProviderModel(options.glmModel),
        observedAssistantModelRequired: effectiveProviderModel(options.glmModel),
        syntheticTransportErrorsExcludedFromIdentity: true,
      },
    },
    phaseBudgetPolicy: {
      source: "core/policy/phase-budget",
      highAssurancePlanSemantics: "terminal_deny_only_without_budget_override",
      byRisk: phaseBudgetsByRisk,
    },
    sourceBoundary: {
      required: true,
      policy: "minimal_runtime_exact_paths_without_install_prefix_plus_same_project_and_package_cache_denies",
      network: "deny",
      preflight: "per_lane_codex_negative_and_python_header_compile_probe_plus_run_level_claude_tool_event_negative_probe",
      claudeRuntime: {
        bareMode: false,
        failIfSandboxUnavailable: true,
        pathGuardHook: true,
        strictEmptyMcpConfig: true,
        restrictedBuiltInTools: true,
        providerResetAwareRetry: true,
      },
      projectLocalConfig: "ignored",
      perLaneManifest: "source-boundary.json",
    },
    binaries,
    cpbRoute: {
      allowedAgents: [...CPB_ALLOWED_AGENTS],
      plannerA: "codex",
      plannerB: "claude-glm",
      executor: "claude-glm",
      verifier: "codex",
      verifierIndependentOfFinalMutator: true,
      invalidVerifierContractFeedbackRetry: true,
      baselineContractUsesDisposableWritableReplay: true,
    },
  };
  return { ...contract, contractSha256: sha256(stableJson(contract)) };
}

async function resolveBinaryIdentity(command: string) {
  let executablePath = "";
  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(entry, command);
    if (await exists(candidate)) {
      executablePath = candidate;
      break;
    }
  }
  if (!executablePath) throw new Error(`required binary not found on PATH: ${command}`);
  const canonicalPath = await realpath(executablePath);
  let packageName: string | null = null;
  let packageVersion: string | null = null;
  let current = path.dirname(canonicalPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, "package.json");
    if (await exists(packagePath)) {
      const manifest = await readJson<LooseRecord>(packagePath);
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        packageName = manifest.name;
        packageVersion = manifest.version;
        break;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return {
    command,
    executablePath,
    canonicalPath,
    packageName,
    packageVersion,
    sha256: sha256(await readFile(canonicalPath)),
  };
}

async function freezeExecutionContract(options: Options) {
  const contractPath = path.join(options.runRoot, "execution-contract.json");
  if (!options.execute && await exists(contractPath)) return readJson<LooseRecord>(contractPath);
  if (!options.codexModel || !options.codexReasoningEffort || !options.glmModel) {
    throw new Error("execution requires explicit --codex-model, --codex-reasoning-effort, and --glm-model values");
  }
  const [codexVersion, claudeVersion, codexAcpIdentity] = await Promise.all([
    runRequired("codex", ["--version"], REPO_ROOT, 30_000),
    runRequired("claude", ["--version"], REPO_ROOT, 30_000),
    resolveBinaryIdentity("codex-acp"),
  ]);
  const current = buildExecutionContract(options, {
    codex: codexVersion.stdout.trim(),
    claude: claudeVersion.stdout.trim(),
    codexAcp: codexAcpIdentity,
  });
  if (await exists(contractPath)) {
    const frozen = await readJson<typeof current>(contractPath);
    if (options.execute && frozen.contractSha256 !== current.contractSha256) {
      throw new Error(`execution contract changed after run freeze (${frozen.contractSha256} != ${current.contractSha256})`);
    }
    return frozen;
  }
  await writeJsonAtomic(contractPath, current);
  return current;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const TRANSIENT_SOLVER_FAILURE = /(?:\b429\b|\b529\b|rate.?limit|overload|temporar(?:y|ily)|connection (?:reset|closed|refused)|stream disconnected|socket hang up|econn(?:reset|refused)|timed?\s*out|timeout|provider unavailable|window exhausted)/i;
const TRANSIENT_SOURCE_FETCH_FAILURE = /(?:\b408\b|\b429\b|\b5\d\d\b|ssl_error|tls|could not resolve host|connection (?:reset|closed|refused)|remote end hung up|early eof|rpc failed|network is unreachable|operation timed out|timed?\s*out|http\/2 stream|unexpected disconnect)/i;

export function isTransientSourceFetchFailure(diagnostics: string) {
  return TRANSIENT_SOURCE_FETCH_FAILURE.test(diagnostics);
}

export function isTransientSolverFailure(result: Pick<LaneResult, "status" | "timedOut" | "error" | "metadata">, diagnostics = "") {
  if (result.status !== "failed") return false;
  if (result.timedOut) return true;
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const jobFailure = isRecord(metadata.jobFailure) ? metadata.jobFailure : {};
  const cause = isRecord(jobFailure.cause) ? jobFailure.cause : {};
  const kind = text(jobFailure.kind);
  if (kind) {
    if ([
      "agent_rate_limited",
      "agent_unavailable",
      "agent_spawn_error",
      "agent_exit_nonzero",
      "runtime_interrupted",
      "timeout",
      "provider_transport",
      "tool_budget_exceeded",
    ].includes(kind)) return jobFailure.retryable === true;
    if (["agent_contract_invalid", "artifact_invalid"].includes(kind)) return jobFailure.retryable === true;
    // Structured failure kinds are authoritative. Do not let unrelated worker,
    // lease, or provider log text turn a semantic failure into a solver retry.
    return false;
  }
  const failureEvidence = [
    result.error || "",
    diagnostics,
    text(jobFailure.reason),
    text(cause.reason),
    text(cause.status),
    text(cause.source),
  ].join("\n");
  if (metadata.failureStage === "source_prepare") return isTransientSourceFetchFailure(failureEvidence);
  return TRANSIENT_SOLVER_FAILURE.test(failureEvidence);
}

export function solverRetryDelayMs(
  result: Pick<LaneResult, "error" | "metadata">,
  diagnostics: string,
  baseDelayMs: number,
  nowMs = Date.now(),
) {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const jobFailure = isRecord(metadata.jobFailure) ? metadata.jobFailure : {};
  const evidence = [
    result.error || "",
    diagnostics,
    text(jobFailure.reason),
  ].join("\n");
  const resetTimes: number[] = [];
  for (const match of evidence.matchAll(/(?:unavailable\s+until|reset(?:s|\s+at)?(?:\s+on)?)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/gi)) {
    const parsed = Date.parse(match[1]);
    if (Number.isFinite(parsed)) resetTimes.push(parsed);
  }
  for (const match of evidence.matchAll(/限额将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*重置/g)) {
    const parsed = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ).getTime();
    if (Number.isFinite(parsed)) resetTimes.push(parsed);
  }
  const resetAt = resetTimes.length > 0 ? Math.max(...resetTimes) : 0;
  const resetDelayMs = resetAt > nowMs ? resetAt - nowMs + 1_000 : 0;
  return Math.min(2_147_000_000, Math.max(0, baseDelayMs, resetDelayMs));
}

type SolverAttemptArchiveDecision =
  | "retry_transient_failure"
  | "resume_noncompleted_result"
  | "resume_interrupted_attempt";

type SolverAttemptArchiveOptions = Pick<Options, "runRoot" | "solverRetryBackoffMs">;

type SolverAttemptArchiveRecord = {
  schemaVersion: 2;
  historyAttempt: number;
  invocationId: string;
  invocationAttempt: number | null;
  decision: SolverAttemptArchiveDecision;
  backoffMs: number;
  archivedAt: string;
  originalLaneRoot: string;
  archiveRoot: string;
  pathRelocations: Array<{
    originalPath: string;
    archivedPath: string;
  }>;
  artifacts: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  result: LaneResult | null;
};

const SOLVER_ATTEMPT_DIRECTORY = /^attempt-(\d+)$/;

export function nextSolverAttemptNumber(entries: string[]) {
  return entries.reduce((highest, entry) => {
    const match = SOLVER_ATTEMPT_DIRECTORY.exec(entry);
    if (!match) return highest;
    const attempt = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(attempt) ? Math.max(highest, attempt) : highest;
  }, 0) + 1;
}

function runRelativePath(runRoot: string, target: string) {
  return path.relative(runRoot, target).split(path.sep).join("/");
}

export async function compactLaneEphemeralArtifacts(laneRoot: string, runRoot: string) {
  const lanesRoot = path.join(runRoot, "lanes");
  if (!isPathInside(lanesRoot, laneRoot) || laneRoot === lanesRoot) {
    throw new Error(`refusing to compact a path outside the run lanes root: ${laneRoot}`);
  }
  const targets = new Set([
    path.join(laneRoot, "source"),
    path.join(laneRoot, "tmp"),
    path.join(laneRoot, "agent-homes"),
    path.join(laneRoot, "hub", "worktrees"),
  ]);
  const projectsRoot = path.join(laneRoot, "hub", "projects");
  for (const entry of await readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) targets.add(path.join(projectsRoot, entry.name, "agent-homes"));
  }

  const removed: string[] = [];
  for (const target of [...targets].sort()) {
    if (!(await exists(target))) continue;
    if (!isPathInside(laneRoot, target) || target === laneRoot) {
      throw new Error(`refusing to compact an unsafe lane artifact path: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
    removed.push(runRelativePath(runRoot, target));
  }
  const record = {
    schemaVersion: 1,
    compactedAt: now(),
    laneRoot: runRelativePath(runRoot, laneRoot),
    removed,
    preserved: [
      runRelativePath(runRoot, path.join(laneRoot, "candidate.patch")),
      runRelativePath(runRoot, path.join(laneRoot, "stdout.log")),
      runRelativePath(runRoot, path.join(laneRoot, "stderr.log")),
      runRelativePath(runRoot, path.join(laneRoot, "result.json")),
      runRelativePath(runRoot, path.join(laneRoot, "hub", "projects")),
    ],
  };
  await writeJsonAtomic(path.join(laneRoot, "artifact-retention.json"), record);
  return record;
}

function collectArchivedPathRelocations(
  value: unknown,
  laneRoot: string,
  archiveRoot: string,
  runRoot: string,
  output = new Map<string, string>(),
  seen = new Set<object>(),
) {
  if (typeof value === "string" && path.isAbsolute(value) && isPathInside(laneRoot, value)) {
    const archivedPath = path.join(archiveRoot, path.relative(laneRoot, value));
    output.set(runRelativePath(runRoot, value), runRelativePath(runRoot, archivedPath));
    return output;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectArchivedPathRelocations(nested, laneRoot, archiveRoot, runRoot, output, seen);
  }
  return output;
}

async function describeArchivedArtifact(runRoot: string, target: string) {
  try {
    const details = await stat(target);
    if (!details.isFile()) return null;
    const contents = await readFile(target);
    return {
      path: runRelativePath(runRoot, target),
      sha256: sha256(contents),
      bytes: contents.byteLength,
    };
  } catch {
    return null;
  }
}

async function rebuildSolverAttemptHistoryIndex(runRoot: string, lane: Lane, opaqueId: string) {
  const historyRoot = path.join(runRoot, "attempt-history", lane, opaqueId);
  const entries = await readdir(historyRoot, { withFileTypes: true }).catch(() => []);
  const attempts = [];
  for (const entry of entries) {
    const match = entry.isDirectory() ? SOLVER_ATTEMPT_DIRECTORY.exec(entry.name) : null;
    if (!match) continue;
    const historyAttempt = Number.parseInt(match[1], 10);
    const archiveRoot = path.join(historyRoot, entry.name);
    const record = await readJson<SolverAttemptArchiveRecord>(path.join(archiveRoot, "archive-record.json")).catch(() => null);
    const legacyDecision = record
      ? null
      : await readJson<LooseRecord>(path.join(archiveRoot, "retry-decision.json")).catch(() => null);
    const archivedResult = record?.result
      || (isRecord(legacyDecision?.result) ? legacyDecision.result : null)
      || await readJson<LooseRecord>(path.join(archiveRoot, "result.json")).catch(() => null);
    const metadata = isRecord(archivedResult?.metadata) ? archivedResult.metadata : {};
    const jobFailure = isRecord(metadata.jobFailure) ? metadata.jobFailure : {};
    attempts.push({
      historyAttempt,
      archiveRoot: runRelativePath(runRoot, archiveRoot),
      recordPath: record ? runRelativePath(runRoot, path.join(archiveRoot, "archive-record.json")) : null,
      retryDecisionPath: await exists(path.join(archiveRoot, "retry-decision.json"))
        ? runRelativePath(runRoot, path.join(archiveRoot, "retry-decision.json"))
        : null,
      traceStatus: record ? "complete" : legacyDecision ? "legacy_record" : "record_missing",
      invocationId: record?.invocationId || null,
      invocationAttempt: record?.invocationAttempt ?? (Number(legacyDecision?.attempt) || null),
      decision: record?.decision || text(legacyDecision?.decision) || "unknown",
      archivedAt: record?.archivedAt || text(legacyDecision?.archivedAt) || null,
      resultStatus: text(archivedResult?.status) || null,
      resultError: text(archivedResult?.error) || null,
      failureKind: text(jobFailure.kind) || null,
      failurePhase: text(jobFailure.phase) || null,
      failureReason: text(jobFailure.reason) || null,
    });
  }
  attempts.sort((left, right) => left.historyAttempt - right.historyAttempt);
  const index = {
    schemaVersion: 1,
    lane,
    opaqueId,
    generatedAt: now(),
    attempts,
  };
  await mkdir(historyRoot, { recursive: true });
  await writeJsonAtomic(path.join(historyRoot, "index.json"), index);
  return index;
}

async function archiveLaneRoot(input: {
  lane: Lane;
  opaqueId: string;
  result: LaneResult | null;
  decision: SolverAttemptArchiveDecision;
  invocationId: string;
  invocationAttempt: number | null;
  backoffMs: number;
  options: SolverAttemptArchiveOptions;
}) {
  const laneRoot = path.join(input.options.runRoot, "lanes", input.lane, input.opaqueId);
  const historyRoot = path.join(input.options.runRoot, "attempt-history", input.lane, input.opaqueId);
  await mkdir(historyRoot, { recursive: true });
  const historyAttempt = nextSolverAttemptNumber(await readdir(historyRoot));
  const archiveRoot = path.join(historyRoot, `attempt-${String(historyAttempt).padStart(3, "0")}`);
  if (await exists(archiveRoot)) throw new Error(`solver attempt archive already exists: ${archiveRoot}`);
  await compactLaneEphemeralArtifacts(laneRoot, input.options.runRoot);
  await rename(laneRoot, archiveRoot);

  const relocationMap = collectArchivedPathRelocations(
    input.result,
    laneRoot,
    archiveRoot,
    input.options.runRoot,
  );
  relocationMap.set(runRelativePath(input.options.runRoot, laneRoot), runRelativePath(input.options.runRoot, archiveRoot));
  const artifactTargets = new Set([
    path.join(archiveRoot, "result.json"),
    path.join(archiveRoot, "state.json"),
    path.join(archiveRoot, "stdout.log"),
    path.join(archiveRoot, "stderr.log"),
    path.join(archiveRoot, "candidate.patch"),
    path.join(archiveRoot, "artifact-retention.json"),
    ...[...relocationMap.values()].map((relative) => path.join(input.options.runRoot, relative)),
  ]);
  const artifacts = (await Promise.all(
    [...artifactTargets].sort().map((target) => describeArchivedArtifact(input.options.runRoot, target)),
  )).filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
  const record: SolverAttemptArchiveRecord = {
    schemaVersion: 2,
    historyAttempt,
    invocationId: input.invocationId,
    invocationAttempt: input.invocationAttempt,
    decision: input.decision,
    backoffMs: input.backoffMs,
    archivedAt: now(),
    originalLaneRoot: runRelativePath(input.options.runRoot, laneRoot),
    archiveRoot: runRelativePath(input.options.runRoot, archiveRoot),
    pathRelocations: [...relocationMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([originalPath, archivedPath]) => ({ originalPath, archivedPath })),
    artifacts,
    result: input.result,
  };
  await writeJsonAtomic(path.join(archiveRoot, "archive-record.json"), record);
  if (input.decision === "retry_transient_failure") {
    await writeJsonAtomic(path.join(archiveRoot, "retry-decision.json"), record);
  }
  await rebuildSolverAttemptHistoryIndex(input.options.runRoot, input.lane, input.opaqueId);
  return record;
}

export async function archiveLaneAttempt(
  result: LaneResult,
  invocationAttempt: number,
  options: SolverAttemptArchiveOptions,
  invocationId = "solver-invocation-unknown",
  backoffMs = options.solverRetryBackoffMs * invocationAttempt,
) {
  return archiveLaneRoot({
    lane: result.lane,
    opaqueId: result.opaqueId,
    result,
    decision: "retry_transient_failure",
    invocationId,
    invocationAttempt,
    backoffMs,
    options,
  });
}

export async function prepareLaneForSolverInvocation(
  lane: Lane,
  opaqueId: string,
  options: SolverAttemptArchiveOptions,
  invocationId = "solver-invocation-unknown",
) {
  const laneRoot = path.join(options.runRoot, "lanes", lane, opaqueId);
  const historyRoot = path.join(options.runRoot, "attempt-history", lane, opaqueId);
  if (await exists(historyRoot)) await rebuildSolverAttemptHistoryIndex(options.runRoot, lane, opaqueId);
  if (!(await exists(laneRoot))) return null;
  const resultPath = path.join(laneRoot, "result.json");
  const result = await readJson<LaneResult>(resultPath).catch(() => null);
  if (result?.status === "completed") return result;
  await archiveLaneRoot({
    lane,
    opaqueId,
    result,
    decision: result ? "resume_noncompleted_result" : "resume_interrupted_attempt",
    invocationId,
    invocationAttempt: null,
    backoffMs: 0,
    options,
  });
  return null;
}

function pidIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function reconcileInterruptedSolverInvocations(
  runRoot: string,
  options: {
    currentPid?: number;
    currentHost?: string;
    isPidAlive?: (pid: number) => boolean;
  } = {},
) {
  const invocationRoot = path.join(runRoot, "solver-invocations");
  const entries = await readdir(invocationRoot, { withFileTypes: true }).catch(() => []);
  const currentPid = options.currentPid ?? process.pid;
  const currentHost = options.currentHost ?? hostname();
  const isAlive = options.isPidAlive || pidIsAlive;
  const recovered: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const invocationPath = path.join(invocationRoot, entry.name);
    const invocation = await readJson<LooseRecord>(invocationPath).catch(() => null);
    if (!invocation || invocation.status !== "running") continue;
    const ownerPid = Number(invocation.pid);
    const ownerHost = text(invocation.host) || currentHost;
    if (ownerHost !== currentHost || (ownerPid !== currentPid && isAlive(ownerPid))) {
      throw new Error(`solver invocation already active: ${text(invocation.invocationId) || entry.name} (${ownerHost}:${ownerPid})`);
    }
    await writeJsonAtomic(invocationPath, {
      ...invocation,
      status: "interrupted",
      completedAt: now(),
      interruptionReason: "owner_process_missing",
      recoveredBy: { host: currentHost, pid: currentPid },
    });
    recovered.push(text(invocation.invocationId) || entry.name.replace(/\.json$/, ""));
  }
  return recovered;
}

function opaqueId(runId: string, rowIndex: number) {
  return `task-${sha256(`${runId}:row:${rowIndex}`).slice(0, 16)}`;
}

export function buildFrozenManifests(rows: Array<{ rowIndex: number; row: LooseRecord }>, runId: string) {
  const solverTasks: SolverTask[] = [];
  const evaluatorTasks: EvaluatorTask[] = [];
  for (const { rowIndex, row } of rows) {
    const task = text(row.problem_statement).trim();
    const repository = text(row.repo);
    const baseCommit = text(row.base_commit);
    const instanceId = text(row.instance_id);
    if (!task || !repository || !baseCommit || !instanceId) throw new Error(`invalid dataset row ${rowIndex}`);
    const id = opaqueId(runId, rowIndex);
    solverTasks.push({
      opaqueId: id,
      rowIndex,
      repository,
      baseCommit,
      task,
      taskSha256: sha256(task),
    });
    evaluatorTasks.push({
      opaqueId: id,
      rowIndex,
      instanceId,
      failToPass: arrayFromJson(row.FAIL_TO_PASS),
      passToPass: arrayFromJson(row.PASS_TO_PASS),
    });
  }
  const solverHash = sha256(stableJson(solverTasks));
  return {
    solver: { schemaVersion: 1, runId, dataset: DATASET, split: SPLIT, manifestSha256: solverHash, tasks: solverTasks },
    evaluator: { schemaVersion: 1, runId, solverManifestSha256: solverHash, tasks: evaluatorTasks },
  };
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function assertRunNotInvalidated(runRoot: string) {
  const invalidationPath = path.join(runRoot, "INVALIDATED.json");
  if (!(await exists(invalidationPath))) return;
  let reason = "unspecified";
  try {
    reason = text((await readJson<LooseRecord>(invalidationPath)).reason) || reason;
  } catch {}
  throw new Error(`run is permanently invalidated (${reason}); create a new run-id instead of resuming or scoring it`);
}

async function startQuotaDelegate(hubRoot: string, laneRoot: string, frozenDistRoot: string) {
  const logPath = path.join(laneRoot, "quota-delegate.log");
  const child = spawn(process.execPath, [
    path.join(frozenDistRoot, "server", "services", "quota-delegate.js"),
    "--hub-root", hubRoot,
  ], {
    cwd: frozenDistRoot,
    env: { ...process.env, CPB_HUB_ROOT: hubRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logChain = Promise.resolve();
  const record = (chunk: Buffer | string) => {
    logChain = logChain.then(() => appendFile(logPath, String(chunk), "utf8"));
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  const deadline = Date.now() + 10_000;
  while (!(await isDelegateAlive(hubRoot))) {
    if (child.exitCode !== null) {
      await logChain.catch(() => null);
      throw new Error(`quota delegate exited during startup with code ${child.exitCode}`);
    }
    if (Date.now() >= deadline) {
      child.kill("SIGTERM");
      await logChain.catch(() => null);
      throw new Error("quota delegate did not become ready within 10000ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await logChain.catch(() => null);
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function isRetryableDatasetStatus(status: number | null) {
  return status === null || status === 408 || status === 429 || status >= 500;
}

export function buildDatasetCacheEnvelope(
  rows: DatasetRow[],
  offset: number,
  count: number,
  source: DatasetCacheEnvelope["source"],
): DatasetCacheEnvelope {
  return {
    schemaVersion: 1,
    dataset: DATASET,
    split: SPLIT,
    offset,
    count,
    source,
    acquiredAt: now(),
    rowsSha256: sha256(stableJson(rows)),
    rows,
  };
}

export function validateDatasetCacheEnvelope(
  value: unknown,
  expected: { offset: number; count: number },
): { ok: true; envelope: DatasetCacheEnvelope } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "cache_not_object" };
  const rows = Array.isArray(value.rows) ? value.rows : [];
  const metadataMatches = value.schemaVersion === 1
    && value.dataset === DATASET
    && value.split === SPLIT
    && Number(value.offset) === expected.offset
    && Number(value.count) === expected.count
    && ["hf_rows_api", "python_datasets_offline"].includes(String(value.source));
  if (!metadataMatches) return { ok: false, reason: "cache_metadata_mismatch" };
  if (rows.length !== expected.count) return { ok: false, reason: "cache_row_count_mismatch" };
  const normalized: DatasetRow[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const entry = rows[index];
    if (!isRecord(entry) || !isRecord(entry.row)) return { ok: false, reason: `cache_row_${index}_invalid` };
    const rowIndex = Number(entry.rowIndex);
    if (rowIndex !== expected.offset + index) return { ok: false, reason: `cache_row_${index}_index_mismatch` };
    normalized.push({ rowIndex, row: entry.row });
  }
  if (value.rowsSha256 !== sha256(stableJson(normalized))) return { ok: false, reason: "cache_hash_mismatch" };
  return {
    ok: true,
    envelope: {
      schemaVersion: 1,
      dataset: DATASET,
      split: SPLIT,
      offset: expected.offset,
      count: expected.count,
      source: value.source as DatasetCacheEnvelope["source"],
      acquiredAt: text(value.acquiredAt),
      rowsSha256: text(value.rowsSha256),
      rows: normalized,
    },
  };
}

export function sliceValidatedDatasetCacheEnvelope(
  value: unknown,
  expected: { offset: number; count: number },
): { ok: true; envelope: DatasetCacheEnvelope } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "cache_not_object" };
  const sourceOffset = Number(value.offset);
  const sourceCount = Number(value.count);
  if (!Number.isInteger(sourceOffset) || !Number.isInteger(sourceCount) || sourceCount < 1) {
    return { ok: false, reason: "source_cache_range_invalid" };
  }
  const validated = validateDatasetCacheEnvelope(value, { offset: sourceOffset, count: sourceCount });
  if (validated.ok === false) return { ok: false, reason: `source_${validated.reason}` };
  const start = expected.offset - sourceOffset;
  if (start < 0 || start + expected.count > sourceCount) {
    return { ok: false, reason: "source_cache_does_not_contain_range" };
  }
  return {
    ok: true,
    envelope: buildDatasetCacheEnvelope(
      validated.envelope.rows.slice(start, start + expected.count),
      expected.offset,
      expected.count,
      validated.envelope.source,
    ),
  };
}

async function findContainingDatasetCache(cachePath: string, offset: number, count: number) {
  const cacheDir = path.dirname(cachePath);
  let names: string[] = [];
  try {
    names = await readdir(cacheDir);
  } catch {
    return null;
  }
  const prefix = `swe-bench-verified-${SPLIT}-`;
  const candidates = names.map((name) => {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) return null;
    const match = name.slice(prefix.length, -".json".length).match(/^(\d+)-(\d+)$/);
    if (!match) return null;
    const sourceOffset = Number(match[1]);
    const sourceCount = Number(match[2]);
    if (sourceOffset > offset || sourceOffset + sourceCount < offset + count) return null;
    return { name, sourceCount };
  }).filter((entry): entry is { name: string; sourceCount: number } => Boolean(entry));
  candidates.sort((left, right) => left.sourceCount - right.sourceCount || left.name.localeCompare(right.name));
  for (const candidate of candidates) {
    try {
      const sliced = sliceValidatedDatasetCacheEnvelope(
        await readJson<unknown>(path.join(cacheDir, candidate.name)),
        { offset, count },
      );
      if (sliced.ok) return { envelope: sliced.envelope, sourceName: candidate.name };
    } catch {}
  }
  return null;
}

async function fetchRowsFromPythonCache(offset: number, count: number): Promise<DatasetRow[]> {
  const script = [
    "import json, sys",
    "from datasets import load_dataset",
    "offset, count = int(sys.argv[1]), int(sys.argv[2])",
    "dataset = load_dataset(sys.argv[3], split=sys.argv[4])",
    "rows = [{'rowIndex': index, 'row': dict(dataset[index])} for index in range(offset, offset + count)]",
    "print(json.dumps({'rows': rows}, separators=(',', ':')))",
  ].join("\n");
  const commands = [
    process.env.CPB_DATASET_PYTHON,
    "python3",
    "python",
    "/usr/bin/python3",
    "/opt/anaconda3/bin/python3",
    "/opt/conda/bin/python3",
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
  let result: Awaited<ReturnType<typeof runCommand>> | null = null;
  const failures: string[] = [];
  for (const command of commands) {
    result = await runCommand({
      command,
      args: ["-c", script, String(offset), String(count), DATASET, SPLIT],
      cwd: REPO_ROOT,
      env: { ...process.env, HF_DATASETS_OFFLINE: "1" },
      timeoutMs: 120_000,
    });
    if (result.code === 0) break;
    failures.push(`${command}: ${result.error || result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  if (!result || result.code !== 0) {
    throw new Error(`offline datasets cache failed: ${failures.join(" | ")}`);
  }
  const payload = JSON.parse(result.stdout) as LooseRecord;
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length !== count) throw new Error(`offline datasets cache expected ${count} rows, received ${rows.length}`);
  return rows.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const row = isRecord(record.row) ? record.row : {};
    return { rowIndex: Number(record.rowIndex ?? offset + index), row };
  });
}

async function fetchRows(offset: number, count: number, cachePath: string) {
  if (await exists(cachePath)) {
    const cached = validateDatasetCacheEnvelope(await readJson<unknown>(cachePath), { offset, count });
    if (cached.ok === false) throw new Error(`dataset cache is invalid: ${cached.reason}`);
    return { rows: cached.envelope.rows, cache: cached.envelope, reused: true };
  }
  const containingCache = await findContainingDatasetCache(cachePath, offset, count);
  if (containingCache) {
    await writeJsonAtomic(cachePath, containingCache.envelope);
    console.warn(`derived dataset slice from verified cache ${containingCache.sourceName}`);
    return { rows: containingCache.envelope.rows, cache: containingCache.envelope, reused: true };
  }
  const url = buildDatasetRowsUrl({ offset, length: count });
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await fetch(url);
      if (response.ok) break;
      lastError = new Error(`dataset request failed: ${response.status} ${response.statusText}`);
      if (!isRetryableDatasetStatus(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /dataset request failed: \d+/.test(error.message)) {
        const status = Number(error.message.match(/dataset request failed: (\d+)/)?.[1] || 0);
        if (!isRetryableDatasetStatus(status)) throw error;
      }
    }
    if (attempt < 5) {
      const delayMs = Math.min(8_000, 1_000 * (2 ** (attempt - 1)));
      console.warn(`dataset fetch attempt ${attempt}/5 failed; retrying after ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  let source: DatasetCacheEnvelope["source"] = "hf_rows_api";
  let normalizedRows: DatasetRow[];
  if (response?.ok) {
    const payload = await response.json() as LooseRecord;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (rows.length !== count) throw new Error(`expected ${count} rows, received ${rows.length}`);
    normalizedRows = rows.map((entry, index) => {
      const record = isRecord(entry) ? entry : {};
      const row = isRecord(record.row) ? record.row : {};
      return { rowIndex: Number(record.row_idx ?? offset + index), row };
    });
  } else {
    source = "python_datasets_offline";
    try {
      normalizedRows = await fetchRowsFromPythonCache(offset, count);
      console.warn("dataset rows API remained unavailable; using the verified local datasets cache");
    } catch (fallbackError) {
      const primary = lastError instanceof Error ? lastError.message : "dataset request failed after 5 attempts";
      const fallback = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primary}; ${fallback}`);
    }
  }
  const envelope = buildDatasetCacheEnvelope(normalizedRows, offset, count, source);
  const validated = validateDatasetCacheEnvelope(envelope, { offset, count });
  if (validated.ok === false) throw new Error(`dataset acquisition produced invalid cache data: ${validated.reason}`);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeJsonAtomic(cachePath, envelope);
  return { rows: normalizedRows, cache: envelope, reused: false };
}

async function freezeManifests(options: Options) {
  const solverPath = path.join(options.runRoot, "manifests", "solver.json");
  const evaluatorPath = path.join(options.runRoot, "evaluator", "manifest.json");
  if (await exists(solverPath) || await exists(evaluatorPath)) {
    if (!(await exists(solverPath)) || !(await exists(evaluatorPath))) throw new Error("frozen manifest pair is incomplete");
    const solver = await readJson<LooseRecord>(solverPath);
    const evaluator = await readJson<LooseRecord>(evaluatorPath);
    const tasks = Array.isArray(solver.tasks) ? solver.tasks : [];
    if (tasks.length !== options.count) throw new Error(`frozen manifest count ${tasks.length} differs from requested ${options.count}`);
    const manifestHash = sha256(stableJson(tasks));
    if (manifestHash !== solver.manifestSha256 || evaluator.solverManifestSha256 !== manifestHash) {
      throw new Error("frozen manifest hash mismatch");
    }
    return { solver, evaluator, solverPath, evaluatorPath };
  }
  const datasetCachePath = path.join(
    path.dirname(options.runRoot),
    "_dataset-cache",
    `swe-bench-verified-${SPLIT}-${options.offset}-${options.count}.json`,
  );
  const fetched = await fetchRows(options.offset, options.count, datasetCachePath);
  const manifests = buildFrozenManifests(fetched.rows, options.runId);
  await mkdir(path.dirname(solverPath), { recursive: true });
  await mkdir(path.dirname(evaluatorPath), { recursive: true });
  await writeJsonAtomic(solverPath, manifests.solver);
  await writeJsonAtomic(evaluatorPath, manifests.evaluator);
  await writeJsonAtomic(path.join(options.runRoot, "evaluator", "dataset-provenance.json"), {
    schemaVersion: 1,
    dataset: DATASET,
    split: SPLIT,
    offset: options.offset,
    count: options.count,
    source: fetched.cache.source,
    acquiredAt: fetched.cache.acquiredAt,
    rowsSha256: fetched.cache.rowsSha256,
    cachePath: datasetCachePath,
    cacheReused: fetched.reused,
  });
  return { ...manifests, solverPath, evaluatorPath };
}

async function runCommand({
  command,
  args,
  cwd,
  env = process.env,
  timeoutMs,
  stdin = null,
  logs = null,
}: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string | null;
  logs?: { stdoutPath: string; stderrPath: string; activityPath: string } | null;
}): Promise<CommandResult> {
  if (logs) {
    await mkdir(path.dirname(logs.stdoutPath), { recursive: true });
    await Promise.all([
      writeFile(logs.stdoutPath, "", "utf8"),
      writeFile(logs.stderrPath, "", "utf8"),
      writeFile(logs.activityPath, "", "utf8"),
    ]);
  }
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let logWrites = Promise.resolve();
    const recordChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString();
      const combined = (stream === "stdout" ? stdout : stderr) + value;
      if (stream === "stdout") stdout = combined.slice(-2_000_000);
      else stderr = combined.slice(-2_000_000);
      if (!logs) return;
      const outputPath = stream === "stdout" ? logs.stdoutPath : logs.stderrPath;
      const activity = `${JSON.stringify({ ts: now(), stream, bytes: chunk.length })}\n`;
      logWrites = logWrites
        .then(() => Promise.all([appendFile(outputPath, chunk), appendFile(logs.activityPath, activity, "utf8")]))
        .then(() => undefined);
    };
    child.stdout.on("data", (chunk: Buffer) => recordChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => recordChunk("stderr", chunk));
    child.stdin.end(stdin || undefined);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      void logWrites.finally(() => {
        resolve({ code, signal, stdout, stderr, timedOut, error: timedOut ? `timed out after ${timeoutMs}ms` : null });
      });
    });
  });
}

async function runRequired(command: string, args: string[], cwd: string, timeoutMs = 600_000) {
  const result = await runCommand({ command, args, cwd, timeoutMs });
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function discoverProjectPackageNames(sourcePath: string, repository: string) {
  const names = new Set<string>();
  const ignored = new Set(["src", "lib", "tests", "test", "docs", "doc", "examples", "example", "scripts"]);
  const scan = async (root: string) => {
    if (!(await exists(root))) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.name.startsWith(".")) continue;
      if (entry.isDirectory() && await exists(path.join(root, entry.name, "__init__.py"))) names.add(entry.name);
    }
  };
  await scan(sourcePath);
  await scan(path.join(sourcePath, "src"));

  const repositoryName = repository.split("/").pop() || "";
  for (const candidate of [repositoryName, repositoryName.replaceAll("-", "_"), repositoryName.replaceAll("-", "")]) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) names.add(candidate);
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(sourcePath, "package.json"), "utf8")) as LooseRecord;
    const packageName = text(manifest.name).split("/").pop() || "";
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(packageName)) {
      names.add(packageName);
      names.add(packageName.replaceAll("-", "_"));
    }
  } catch {}
  return [...names].sort();
}

export function parseRuntimeRoots(stdout: string) {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const parsed = JSON.parse(line) as LooseRecord;
      const paths = Array.isArray(parsed.paths) ? parsed.paths.map(String) : [];
      const runtimePaths = Array.isArray(parsed.runtimePaths) ? parsed.runtimePaths.map(String) : [];
      const prefixes = Array.isArray(parsed.prefixes) ? parsed.prefixes.map(String) : [];
      return {
        readRoots: [...new Set([
          ...paths,
          ...runtimePaths,
          ...prefixes.map((prefix) => path.join(prefix, "lib")),
        ])],
        prefixes: [...new Set(prefixes)],
      };
    } catch {}
  }
  return { readRoots: [], prefixes: [] };
}

export function runtimePackageCacheDenyRoots(prefixes: string[]) {
  return [...new Set(prefixes.flatMap((prefix) => [
    path.join(prefix, "conda-bld"),
    path.join(prefix, "pkgs"),
  ]))].sort();
}

export function runtimeConfigReadRoots(
  prefixes: string[],
  env: { OPENSSL_CONF?: string } = process.env,
) {
  return [...new Set([
    "/System/Library/OpenSSL",
    ...(env.OPENSSL_CONF ? [path.dirname(env.OPENSSL_CONF)] : []),
    ...prefixes.map((prefix) => path.join(prefix, "ssl")),
  ])].sort();
}

function normalizedPackageIdentity(value: string) {
  return (value.split("/").pop() || value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function nearestPackageRoot(target: string) {
  let current = path.dirname(target);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(current, "package.json");
    if (await exists(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LooseRecord;
        return { root: current, name: text(manifest.name) };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export async function discoverExecutablePackageRoots(
  pathRoots: string[],
  projectPackageNames: string[],
) {
  const runtimeToolNames = new Set(["npm", "npx", "corepack", "pnpm", "pnpx", "yarn", "yarnpkg"]);
  const projectIdentities = new Set(projectPackageNames.map(normalizedPackageIdentity));
  const roots = new Set<string>();
  for (const pathRoot of pathRoots) {
    if (!pathRoot || !path.isAbsolute(pathRoot) || !(await exists(pathRoot))) continue;
    let entries;
    try {
      entries = await readdir(pathRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!runtimeToolNames.has(entry.name)) continue;
      if (!entry.isSymbolicLink()) continue;
      let target;
      try {
        target = await realpath(path.join(pathRoot, entry.name));
      } catch {
        continue;
      }
      const packageInfo = await nearestPackageRoot(target);
      if (!packageInfo?.name) continue;
      if (projectIdentities.has(normalizedPackageIdentity(packageInfo.name))) continue;
      roots.add(packageInfo.root);
    }
  }
  return [...roots].sort();
}

async function discoverDependencyReadRoots(
  sourcePath: string,
  runRoot: string,
  projectPackageNames: string[],
) {
  const pathRoots = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const candidates = new Set<string>([
    path.dirname(process.execPath),
    "/Applications/Xcode.app/Contents/Developer/usr",
    "/Applications/Xcode.app/Contents/Developer/usr/bin",
    "/Applications/Xcode.app/Contents/Developer/Toolchains",
    "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    "/Library/Developer/CommandLineTools/usr",
    "/Library/Developer/CommandLineTools/usr/bin",
    "/Library/Developer/CommandLineTools/SDKs",
    "/Library/Developer/CommandLineTools/Library/Frameworks",
    "/opt/anaconda3/bin",
    "/opt/conda/bin",
    ...(process.env.CONDA_PREFIX ? [path.join(process.env.CONDA_PREFIX, "bin")] : []),
    ...pathRoots,
    ...String(process.env.NODE_PATH || "").split(path.delimiter),
  ].filter(Boolean));
  const runtimePrefixes = new Set<string>([
    ...(process.env.CONDA_PREFIX ? [process.env.CONDA_PREFIX] : []),
  ]);
  const pythonProbe = [
    "import json,sys,sysconfig",
    "p=sysconfig.get_paths()",
    "keys=('stdlib','platstdlib','purelib','platlib','include','platinclude','scripts')",
    "print(json.dumps({'paths':sys.path,'runtimePaths':[p[k] for k in keys if p.get(k)],'prefixes':[sys.prefix,sys.base_prefix]}))",
  ].join(";");
  for (const command of [
    "python3",
    "python",
    "/usr/bin/python3",
    "/opt/anaconda3/bin/python3",
    "/opt/anaconda3/bin/python",
    "/opt/conda/bin/python3",
    "/opt/conda/bin/python",
  ]) {
    const result = await runCommand({ command, args: ["-I", "-c", pythonProbe], cwd: sourcePath, timeoutMs: 30_000 });
    if (result.code === 0) {
      const layout = parseRuntimeRoots(result.stdout);
      for (const entry of layout.readRoots) candidates.add(entry);
      for (const prefix of layout.prefixes) runtimePrefixes.add(prefix);
    }
  }
  for (const packageRoot of await discoverExecutablePackageRoots(pathRoots, projectPackageNames)) {
    candidates.add(packageRoot);
  }
  for (const configRoot of runtimeConfigReadRoots([...runtimePrefixes])) candidates.add(configRoot);
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || !(await exists(candidate))) continue;
    let canonical = path.resolve(candidate);
    try {
      canonical = await realpath(canonical);
    } catch {}
    if (isPathInside(runRoot, canonical) || isPathInside(canonical, sourcePath)) continue;
    if (canonical === homedir()) continue;
    const segments = canonical.split(path.sep);
    if (segments.includes(".cpb-evaluations") || segments.includes("worktrees")) continue;
    let ancestor = canonical;
    let sourceCheckout = false;
    for (let depth = 0; depth < 8; depth += 1) {
      if (await exists(path.join(ancestor, ".git"))) {
        sourceCheckout = true;
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (sourceCheckout) continue;
    roots.push(canonical);
  }
  return {
    readRoots: [...new Set(roots)].sort(),
    runtimePrefixes: [...runtimePrefixes].sort(),
  };
}

export async function buildAgentFilesystemBoundary(
  repository: string,
  sourcePath: string,
  runRoot: string,
): Promise<AgentFilesystemBoundary> {
  const projectPackageNames = await discoverProjectPackageNames(sourcePath, repository);
  const dependencyLayout = await discoverDependencyReadRoots(sourcePath, runRoot, projectPackageNames);
  const dependencyReadRoots = dependencyLayout.readRoots;
  const denied = new Set<string>();
  for (const root of dependencyReadRoots) {
    for (const packageName of projectPackageNames) {
      for (const candidate of [
        path.join(root, packageName),
        path.join(root, `${packageName}.py`),
        path.join(root, `${packageName}.h`),
        path.join(root, `${packageName}.hpp`),
        path.join(root, "node_modules", packageName),
      ]) {
        if (!(await exists(candidate))) continue;
        let canonical = path.resolve(candidate);
        try {
          canonical = await realpath(canonical);
        } catch {}
        if (!isPathInside(sourcePath, canonical)) denied.add(canonical);
      }
    }
  }
  for (const cacheRoot of runtimePackageCacheDenyRoots(dependencyLayout.runtimePrefixes)) {
    if (!(await exists(cacheRoot))) continue;
    let canonical = path.resolve(cacheRoot);
    try {
      canonical = await realpath(canonical);
    } catch {}
    if (!isPathInside(sourcePath, canonical)) denied.add(canonical);
  }
  return {
    schemaVersion: 1,
    homeDenyRoot: path.resolve(homedir()),
    projectPackageNames,
    dependencyReadRoots,
    denyReadPaths: [...denied].sort(),
  };
}

export async function findBoundaryProbeTarget(deniedPath: string) {
  const root = path.resolve(deniedPath);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return null;
  }
  if (rootStat.isFile()) return root;
  if (!rootStat.isDirectory()) return root;

  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 2_000) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visited += 1;
      const candidate = path.join(current.directory, entry.name);
      if (entry.isFile()) return candidate;
      if (entry.isDirectory() && current.depth < 6) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
      if (visited >= 2_000) break;
    }
  }
  return root;
}

async function openLoopbackProbeServer() {
  const server = createServer((socket) => {
    socket.on("error", () => {
      // The host control probe closes immediately after connect. A reset is
      // expected and must not turn the boundary preflight into a false failure.
    });
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not allocate loopback source-boundary probe port");
  }
  return { server, port: address.port };
}

type BoundaryDeniedTarget = {
  deniedPath: string;
  target: string;
  kind: "file" | "directory";
};

type BoundaryProbeOutput = {
  inside?: { ok?: boolean; code?: string | null };
  denied?: Array<{ target?: string; ok?: boolean; code?: string | null }>;
  network?: { connected?: boolean; code?: string | null };
};

export function evaluateBoundaryProbe(
  probe: BoundaryProbeOutput,
  deniedTargets: BoundaryDeniedTarget[],
) {
  const violations: string[] = [];
  if (probe.inside?.ok !== true) {
    violations.push(`inside_target_not_readable:${probe.inside?.code || "unknown"}`);
  }
  const deniedByTarget = new Map((probe.denied || []).map((entry) => [entry.target, entry]));
  for (const expected of deniedTargets) {
    const observed = deniedByTarget.get(expected.target);
    if (!observed) {
      violations.push(`denied_target_probe_missing:${expected.target}`);
      continue;
    }
    if (observed.ok === true || !["EPERM", "EACCES"].includes(observed.code || "")) {
      violations.push(`denied_target_not_permission_blocked:${expected.target}:${observed.code || (observed.ok ? "readable" : "unknown")}`);
    }
  }
  if (probe.network?.connected === true || !["EPERM", "EACCES"].includes(probe.network?.code || "")) {
    violations.push(`network_not_permission_blocked:${probe.network?.code || (probe.network?.connected ? "connected" : "unknown")}`);
  }
  return violations;
}

export function parseClaudeRuntimeBoundaryStream(
  stdout: string,
  expectedCommand: string,
  expectedModel: string,
) {
  let init: LooseRecord | null = null;
  let toolUseId = "";
  let observedCommand = "";
  let hookAllowed = false;
  let probe: BoundaryProbeOutput = {};
  const parseObject = (value: unknown) => {
    if (typeof value !== "string") return null;
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  for (const line of stdout.split(/\r?\n/)) {
    const entry = parseObject(line);
    if (!entry) continue;
    if (entry.type === "system" && entry.subtype === "init") init = entry;
    if (entry.type === "system" && entry.subtype === "hook_response" && entry.hook_name === "PreToolUse:Bash") {
      const hook = parseObject(entry.output);
      const specific = recordValue(hook?.hookSpecificOutput);
      if (specific.permissionDecision === "allow") hookAllowed = true;
    }
    const message = recordValue(entry.message);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const itemValue of content) {
      const item = recordValue(itemValue);
      if (entry.type === "assistant" && item.type === "tool_use" && item.name === "Bash") {
        toolUseId = text(item.id);
        observedCommand = text(recordValue(item.input).command);
      }
      if (entry.type === "user" && item.type === "tool_result" && text(item.tool_use_id) === toolUseId) {
        const parsed = parseObject(item.content);
        if (parsed) probe = parsed as BoundaryProbeOutput;
      }
    }
  }
  const violations: string[] = [];
  if (!init) violations.push("claude_init_event_missing");
  const initModel = text(init?.model);
  if (initModel !== expectedModel) violations.push(`claude_init_model_mismatch:${initModel || "missing"}:expected:${expectedModel}`);
  const tools = Array.isArray(init?.tools) ? init.tools.map(String).sort() : [];
  const expectedTools = ["Bash", "Edit", "Glob", "Grep", "Read", "Write"].sort();
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) violations.push(`claude_tool_set_mismatch:${tools.join(",")}`);
  if (!Array.isArray(init?.mcp_servers) || init.mcp_servers.length !== 0) violations.push("claude_mcp_servers_not_empty");
  if (!Array.isArray(init?.slash_commands) || init.slash_commands.length !== 0) violations.push("claude_slash_commands_not_empty");
  if (!toolUseId) violations.push("claude_bash_probe_missing");
  if (observedCommand !== expectedCommand) violations.push("claude_bash_probe_command_changed");
  if (!hookAllowed) violations.push("claude_path_guard_hook_not_observed");
  return { init, toolUseId, observedCommand, hookAllowed, probe, violations };
}

export function claudeRuntimeBoundaryRetryReason(
  parsed: ReturnType<typeof parseClaudeRuntimeBoundaryStream>,
  diagnostics = "",
) {
  if (TRANSIENT_SOLVER_FAILURE.test(diagnostics)) return "provider_transient_failure";
  const bashMissing = parsed.violations.includes("claude_bash_probe_missing");
  const commandChanged = parsed.violations.includes("claude_bash_probe_command_changed");
  const hardViolations = parsed.violations.filter((violation) => (
    violation !== "claude_bash_probe_missing"
    && violation !== "claude_bash_probe_command_changed"
    && !(bashMissing && violation === "claude_path_guard_hook_not_observed")
  ));
  if (hardViolations.length > 0) return null;
  if (bashMissing) return "model_did_not_invoke_bash_probe";
  if (commandChanged) return "model_changed_bash_probe_command";
  return null;
}

export async function recoverInterruptedClaudeBoundaryPreflight(
  runRoot: string,
  options: {
    currentPid?: number;
    currentHost?: string;
    isPidAlive?: (pid: number) => boolean;
  } = {},
) {
  const preflightRoot = path.join(runRoot, "preflight", "claude-runtime-boundary");
  if (!(await exists(preflightRoot)) || await exists(path.join(preflightRoot, "result.json"))) return null;
  const owner = await readJson<LooseRecord>(path.join(preflightRoot, "owner.json")).catch(() => null);
  const currentPid = options.currentPid ?? process.pid;
  const currentHost = options.currentHost ?? hostname();
  const isAlive = options.isPidAlive || pidIsAlive;
  const ownerPid = Number(owner?.pid);
  const ownerHost = text(owner?.host) || currentHost;
  if (owner && (ownerHost !== currentHost || (ownerPid !== currentPid && isAlive(ownerPid)))) {
    throw new Error(`Claude runtime boundary preflight already active (${ownerHost}:${ownerPid})`);
  }

  const historyRoot = path.join(runRoot, "preflight", "claude-runtime-boundary-history");
  await mkdir(historyRoot, { recursive: true });
  const historyAttempt = nextSolverAttemptNumber(await readdir(historyRoot));
  const archiveRoot = path.join(historyRoot, `attempt-${String(historyAttempt).padStart(3, "0")}`);
  await rename(preflightRoot, archiveRoot);
  const record = {
    schemaVersion: 1,
    historyAttempt,
    decision: "resume_interrupted_preflight",
    archivedAt: now(),
    originalRoot: runRelativePath(runRoot, preflightRoot),
    archiveRoot: runRelativePath(runRoot, archiveRoot),
    owner,
    recoveredBy: { host: currentHost, pid: currentPid },
  };
  await writeJsonAtomic(path.join(archiveRoot, "recovery-record.json"), record);
  return record;
}

async function assertHostBoundaryTargetReadable(target: BoundaryDeniedTarget) {
  if (target.kind === "directory") {
    await readdir(target.target);
    return;
  }
  const handle = await open(target.target, "r");
  try {
    const buffer = Buffer.alloc(1);
    await handle.read(buffer, 0, 1, 0);
  } finally {
    await handle.close();
  }
}

async function assertLoopbackProbeReachable(port: number) {
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("loopback control probe timed out"));
    }, 2_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const BOUNDARY_PROBE_PROGRAM = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const input = JSON.parse(process.argv[process.argv.length - 1]);
function readTarget(target, kind) {
  try {
    if (kind === "directory") fs.readdirSync(target);
    else { const fd = fs.openSync(target, "r"); try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); } }
    return { target, ok: true, code: null };
  } catch (error) {
    return { target, ok: false, code: error && error.code ? String(error.code) : "UNKNOWN" };
  }
}
(async () => {
  const inside = readTarget(input.insidePath, "file");
  const denied = input.deniedTargets.map((entry) => readTarget(entry.target, entry.kind));
  const network = await new Promise((resolve) => {
    const socket = net.connect(input.port, "127.0.0.1");
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); resolve({ connected: true, code: null }); });
    socket.once("timeout", () => { socket.destroy(); resolve({ connected: false, code: "ETIMEDOUT" }); });
    socket.once("error", (error) => resolve({ connected: false, code: error && error.code ? String(error.code) : "UNKNOWN" }));
  });
  process.stdout.write(JSON.stringify({ inside, denied, network }) + "\n");
})().catch((error) => { console.error(error); process.exit(70); });
`;

export async function verifyCodexFilesystemBoundary(
  sourcePath: string,
  boundary: AgentFilesystemBoundary,
  laneRoot: string,
) {
  const insideCandidates = [
    ...boundary.projectPackageNames.map((name) => path.join(sourcePath, name, "__init__.py")),
    path.join(sourcePath, "README.md"),
    path.join(sourcePath, "README.rst"),
  ];
  let insidePath = path.join(sourcePath, ".git", "HEAD");
  for (const candidate of insideCandidates) {
    if (await exists(candidate)) {
      insidePath = candidate;
      break;
    }
  }
  const deniedTargets = (await Promise.all(boundary.denyReadPaths.map(async (deniedPath) => {
    const target = await findBoundaryProbeTarget(deniedPath);
    if (!target) return null;
    const targetStat = await stat(target);
    return { deniedPath, target, kind: targetStat.isDirectory() ? "directory" as const : "file" as const };
  }))).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (deniedTargets.length !== boundary.denyReadPaths.length) {
    throw new Error("source boundary preflight could not materialize every denied target");
  }
  for (const target of deniedTargets) await assertHostBoundaryTargetReadable(target);
  const loopback = await openLoopbackProbeServer();
  await assertLoopbackProbeReachable(loopback.port);
  let result: CommandResult;
  try {
    result = await runCommand({
      command: "codex",
      args: [
        "sandbox", "-C", sourcePath,
        ...codexFilesystemBoundaryConfigArgs(boundary, "write"),
        "-P", SOURCE_BOUNDARY_PROFILE,
        "--", "/usr/bin/env", "OPENSSL_CONF=/dev/null", process.execPath,
        "-e", BOUNDARY_PROBE_PROGRAM,
        JSON.stringify({ insidePath, deniedTargets, port: loopback.port }),
      ],
      cwd: sourcePath,
      timeoutMs: 30_000,
    });
  } finally {
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
  }
  let probe: BoundaryProbeOutput = {};
  for (const line of result.stdout.trim().split("\n").reverse()) {
    try {
      probe = JSON.parse(line) as BoundaryProbeOutput;
      break;
    } catch {}
  }
  const violations = result.code === 0
    ? evaluateBoundaryProbe(probe, deniedTargets)
    : [`probe_process_failed:${result.code ?? result.signal ?? "unknown"}`];
  const runtimeCompileChecks = [];
  for (const includeRoot of boundary.dependencyReadRoots.filter((root) => path.basename(root).startsWith("python"))) {
    if (!(await exists(path.join(includeRoot, "Python.h")))) continue;
    const compile = await runCommand({
      command: "codex",
      args: [
        "sandbox", "-C", sourcePath,
        ...codexFilesystemBoundaryConfigArgs(boundary, "write"),
        "-P", SOURCE_BOUNDARY_PROFILE,
        "--", "/usr/bin/clang", "-fsyntax-only", `-I${includeRoot}`, "-x", "c", "-",
      ],
      cwd: sourcePath,
      timeoutMs: 30_000,
      stdin: "#include <Python.h>\nint main(void) { return 0; }\n",
    });
    const check = {
      includeRoot,
      ok: compile.code === 0,
      exitCode: compile.code,
      signal: compile.signal,
      stderr: compile.stderr.slice(-2_000),
    };
    runtimeCompileChecks.push(check);
    if (!check.ok) violations.push(`python_header_compile_probe_failed:${includeRoot}:${compile.code ?? compile.signal ?? "unknown"}`);
  }
  const record = {
    schemaVersion: 2,
    ok: result.code === 0 && violations.length === 0,
    insidePath,
    deniedPaths: boundary.denyReadPaths,
    deniedTargets,
    networkProbe: { host: "127.0.0.1", mode: "local-listener-must-be-unreachable" },
    probe,
    runtimeCompileChecks,
    violations,
    exitCode: result.code,
    signal: result.signal,
    stderr: result.stderr.slice(-2_000),
    verifiedAt: now(),
  };
  await writeJsonAtomic(path.join(laneRoot, "source-boundary-preflight.json"), record);
  if (!record.ok) {
    throw new Error(`source boundary preflight failed: ${violations.join(",") || result.stderr || result.stdout}`);
  }
  return record;
}

export async function verifyClaudeRuntimeBoundary(options: Options, frozenDistRoot = DIST_ROOT) {
  const preflightRoot = path.join(options.runRoot, "preflight", "claude-runtime-boundary");
  const recordPath = path.join(preflightRoot, "result.json");
  if (await exists(recordPath)) {
    const existing = await readJson<LooseRecord>(recordPath);
    if (existing.ok === true && existing.expectedModel === effectiveProviderModel(options.glmModel)) return existing;
    throw new Error(`Claude runtime boundary preflight already failed and its evidence is preserved: ${text(existing.violations) || recordPath}`);
  }
  const recoveredPreflight = await recoverInterruptedClaudeBoundaryPreflight(options.runRoot);
  const sourcePath = path.join(preflightRoot, "allowed-source");
  const deniedRoot = path.join(preflightRoot, "denied-source");
  const insidePath = path.join(sourcePath, "inside.txt");
  const deniedPath = path.join(deniedRoot, "future-copy.txt");
  const probeScriptPath = path.join(sourcePath, "boundary-probe.cjs");
  await Promise.all([
    mkdir(sourcePath, { recursive: true }),
    mkdir(deniedRoot, { recursive: true }),
  ]);
  await writeJsonAtomic(path.join(preflightRoot, "owner.json"), {
    schemaVersion: 1,
    host: hostname(),
    pid: process.pid,
    startedAt: now(),
  });
  await Promise.all([
    writeFile(insidePath, "current source\n", "utf8"),
    writeFile(deniedPath, "later implementation\n", "utf8"),
    writeFile(probeScriptPath, BOUNDARY_PROBE_PROGRAM, "utf8"),
  ]);
  const boundary: AgentFilesystemBoundary = {
    schemaVersion: 1,
    homeDenyRoot: path.resolve(homedir()),
    projectPackageNames: [],
    dependencyReadRoots: [],
    denyReadPaths: [deniedRoot],
  };
  const providerEnv = envForAgent("claude-glm", {
    ...process.env,
    ZHIPU_MODEL: options.glmModel,
    GLM_MODEL: options.glmModel,
  }) as NodeJS.ProcessEnv;
  const env = buildNativeClaudeIsolatedEnv(preflightRoot, providerEnv);
  await Promise.all([
    mkdir(String(env.HOME), { recursive: true }),
    mkdir(String(env.CLAUDE_CONFIG_DIR), { recursive: true }),
    mkdir(String(env.XDG_CONFIG_HOME), { recursive: true }),
    mkdir(String(env.XDG_DATA_HOME), { recursive: true }),
    mkdir(String(env.XDG_CACHE_HOME), { recursive: true }),
    mkdir(String(env.TMPDIR), { recursive: true }),
  ]);
  const settingsPath = path.join(String(env.CLAUDE_CONFIG_DIR), "settings.json");
  const settings = buildNativeClaudeSettings(
    sourcePath,
    String(env.HOME),
    String(env.TMPDIR),
    path.join(frozenDistRoot, "scripts", "claude-path-guard.js"),
    boundary,
  );
  await writeJsonAtomic(settingsPath, settings);
  const deniedTargets: BoundaryDeniedTarget[] = [{ deniedPath: deniedRoot, target: deniedPath, kind: "file" }];
  await assertHostBoundaryTargetReadable(deniedTargets[0]);
  const loopback = await openLoopbackProbeServer();
  await assertLoopbackProbeReachable(loopback.port);
  const probeInput = JSON.stringify({ insidePath, deniedTargets, port: loopback.port });
  const command = [process.execPath, probeScriptPath, probeInput].map(shellQuote).join(" ");
  const model = text(env.ANTHROPIC_MODEL || env.ZHIPU_MODEL);
  const expectedModel = effectiveProviderModel(options.glmModel);
  const attemptSummaries: LooseRecord[] = [];
  let acceptedAttempt: number | null = null;
  let finalParsed: ReturnType<typeof parseClaudeRuntimeBoundaryStream> | null = null;
  let finalCommandResult: CommandResult | null = null;
  let finalViolations: string[] = ["claude_boundary_probe_not_attempted"];
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptRoot = path.join(preflightRoot, "attempts", `attempt-${String(attempt).padStart(3, "0")}`);
      await mkdir(attemptRoot, { recursive: true });
      const prompt = [
        "This is an authorized CPB runtime-boundary self-test, not an attempt to bypass the boundary.",
        "The local probe reads one allowed fixture, then deliberately attempts one denied read and one loopback connection. The outer sandbox must block the latter two and the probe reports their error codes as JSON.",
        attempt > 1
          ? "A previous attempt returned no usable Bash evidence. A prose explanation cannot satisfy this security preflight."
          : "The command and its expected containment behavior are fully described above.",
        "Use the Bash tool exactly once and execute the command between the markers byte-for-byte without changing it.",
        "BEGIN_COMMAND",
        command,
        "END_COMMAND",
      ].join("\n");
      const args = buildNativeClaudeArgs(model, settingsPath, prompt);
      args.splice(args.length - 1, 0, "--max-turns", "3");
      const commandResult = await runCommand({
        command: "claude",
        args,
        cwd: sourcePath,
        env,
        timeoutMs: 120_000,
        logs: {
          stdoutPath: path.join(attemptRoot, "stdout.log"),
          stderrPath: path.join(attemptRoot, "stderr.log"),
          activityPath: path.join(attemptRoot, "activity.jsonl"),
        },
      });
      const parsed = parseClaudeRuntimeBoundaryStream(commandResult.stdout, command, expectedModel);
      const violations = [
        ...(commandResult.code === 0 ? [] : [`claude_probe_process_failed:${commandResult.code ?? commandResult.signal ?? "unknown"}`]),
        ...parsed.violations,
        ...evaluateBoundaryProbe(parsed.probe, deniedTargets),
      ];
      const retryDiagnostics = [commandResult.stdout, commandResult.stderr, commandResult.error || ""].join("\n");
      const retryReason = claudeRuntimeBoundaryRetryReason(parsed, retryDiagnostics);
      const retryScheduled = violations.length > 0 && Boolean(retryReason) && attempt < 3;
      const retryBackoffMs = retryScheduled
        ? solverRetryDelayMs(
          { error: retryDiagnostics, metadata: {} },
          "",
          options.solverRetryBackoffMs,
        )
        : 0;
      const attemptRecord = {
        schemaVersion: 1,
        attempt,
        ok: violations.length === 0,
        promptSha256: sha256(prompt),
        commandSha256: sha256(command),
        retryEligibleReason: retryReason,
        retryScheduled,
        retryBackoffMs,
        hookAllowed: parsed.hookAllowed,
        init: parsed.init,
        probe: parsed.probe,
        violations,
        exitCode: commandResult.code,
        signal: commandResult.signal,
        timedOut: commandResult.timedOut,
        error: commandResult.error,
        stderr: commandResult.stderr.slice(-2_000),
        completedAt: now(),
      };
      await writeJsonAtomic(path.join(attemptRoot, "result.json"), attemptRecord);
      attemptSummaries.push({
        attempt,
        ok: attemptRecord.ok,
        retryEligibleReason: retryReason,
        retryScheduled,
        retryBackoffMs,
        resultPath: path.relative(preflightRoot, path.join(attemptRoot, "result.json")),
        promptSha256: attemptRecord.promptSha256,
        violations,
      });
      finalParsed = parsed;
      finalCommandResult = commandResult;
      finalViolations = violations;
      if (violations.length === 0) {
        acceptedAttempt = attempt;
        break;
      }
      if (!retryScheduled) break;
      if (retryBackoffMs > 0) await new Promise((resolve) => setTimeout(resolve, retryBackoffMs));
    }
  } finally {
    await new Promise<void>((resolve) => loopback.server.close(() => resolve()));
  }
  const record = {
    schemaVersion: 2,
    ok: acceptedAttempt !== null,
    expectedModel,
    settingsSha256: sha256(stableJson(settings)),
    commandSha256: sha256(command),
    maxAttempts: 3,
    acceptedAttempt,
    attempts: attemptSummaries,
    hookAllowed: finalParsed?.hookAllowed === true,
    init: finalParsed?.init || null,
    probe: finalParsed?.probe || {},
    deniedTargets,
    networkProbe: { host: "127.0.0.1", mode: "local-listener-must-be-unreachable" },
    violations: finalViolations,
    exitCode: finalCommandResult?.code ?? null,
    signal: finalCommandResult?.signal ?? null,
    stderr: finalCommandResult?.stderr.slice(-2_000) || "",
    verifiedAt: now(),
    recoveredPreflight,
  };
  await writeJsonAtomic(recordPath, record);
  if (!record.ok) throw new Error(`Claude runtime boundary preflight failed: ${finalViolations.join(",")}`);
  return record;
}

async function fetchSourceCommit(cachePath: string, task: SolverTask, laneRoot: string) {
  const attempts: LooseRecord[] = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const startedAt = now();
    const result = await runCommand({
      command: "git",
      args: ["fetch", "--no-tags", "--depth=1", "origin", task.baseCommit],
      cwd: cachePath,
      timeoutMs: 600_000,
    });
    const diagnostics = `${result.stderr}\n${result.stdout}`.trim();
    attempts.push({
      attempt,
      startedAt,
      completedAt: now(),
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      error: result.error,
      diagnostics: diagnostics.slice(-4_000),
    });
    await writeJsonAtomic(path.join(laneRoot, "source-fetch-attempts.json"), { repository: task.repository, baseCommit: task.baseCommit, attempts });
    if (result.code === 0) return attempts;
    if (!isTransientSourceFetchFailure(diagnostics) || attempt === 5) {
      throw new Error(`git fetch failed after ${attempt} attempt(s): ${diagnostics || result.error || `exit ${result.code}`}`);
    }
    const delayMs = Math.min(8_000, 1_000 * (2 ** (attempt - 1)));
    console.warn(`  source fetch attempt ${attempt}/5 failed; retrying after ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return attempts;
}

async function prepareSource(task: SolverTask, laneRoot: string, runRoot: string) {
  const sourcePath = path.join(laneRoot, "source");
  const cacheKey = task.repository.replace(/[^a-zA-Z0-9._-]+/g, "__");
  const cachePath = path.join(runRoot, "source-cache", `${cacheKey}.git`);
  await mkdir(path.dirname(cachePath), { recursive: true });
  const cache = await withSourceCacheLock(cachePath, async () => {
    if (!(await exists(path.join(cachePath, "HEAD")))) {
      await rm(cachePath, { recursive: true, force: true });
      await mkdir(cachePath, { recursive: true });
      await runRequired("git", ["init", "--bare"], cachePath);
      await runRequired("git", ["remote", "add", "origin", `https://github.com/${task.repository}.git`], cachePath);
    }
    const cached = await runCommand({
      command: "git",
      args: ["cat-file", "-e", `${task.baseCommit}^{commit}`],
      cwd: cachePath,
      timeoutMs: 30_000,
    });
    const fetchAttempts = cached.code === 0 ? [] : await fetchSourceCommit(cachePath, task, laneRoot);
    const verified = await runRequired("git", ["cat-file", "-e", `${task.baseCommit}^{commit}`], cachePath, 30_000);
    return { cacheHit: cached.code === 0, fetchAttempts, commitVerified: verified.code === 0 };
  });
  await rm(sourcePath, { recursive: true, force: true });
  await mkdir(sourcePath, { recursive: true });
  await runRequired("git", ["init"], sourcePath);
  await runRequired("git", ["remote", "add", "origin", cachePath], sourcePath);
  await runRequired("git", ["fetch", "--depth=1", "origin", task.baseCommit], sourcePath);
  await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], sourcePath);
  const head = (await runRequired("git", ["rev-parse", "HEAD"], sourcePath, 30_000)).stdout.trim();
  if (head !== task.baseCommit) throw new Error(`source identity mismatch: expected ${task.baseCommit}, got ${head}`);
  await writeJsonAtomic(path.join(laneRoot, "source-prepare.json"), {
    repository: task.repository,
    baseCommit: task.baseCommit,
    sourcePath,
    cachePath,
    cacheHit: cache.cacheHit,
    fetchAttempts: cache.fetchAttempts,
    commitVerified: cache.commitVerified,
    preparedAt: now(),
  });
  return sourcePath;
}

async function initializeCodeGraph(sourcePath: string) {
  const init = await runRequired("codegraph", ["init", sourcePath], REPO_ROOT, 600_000);
  const status = await runRequired("codegraph", ["status", sourcePath], REPO_ROOT, 120_000);
  return {
    init: { stdout: init.stdout.slice(-4000), stderr: init.stderr.slice(-4000) },
    status: { stdout: status.stdout.slice(-4000), stderr: status.stderr.slice(-4000) },
  };
}

function ordinaryTaskPrompt(task: string) {
  return `${task}\n\nWork on this as an ordinary repository task. Inspect the local checkout, identify the real failing path, implement the smallest correct fix, and run repository-appropriate focused tests. Preserve unrelated behavior. Do not merely describe a patch: edit the working tree and verify it.`;
}

export function promptLeakageViolations(prompt: string, instanceId: string) {
  const violations: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["instance_id", new RegExp(instanceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")],
    ["benchmark_name", /SWE-?bench/i],
    ["fail_to_pass", /FAIL_TO_PASS/i],
    ["pass_to_pass", /PASS_TO_PASS/i],
    ["gold_patch", /gold(?:en)?\s+patch|oracle\s+patch/i],
    ["official_harness", /official\s+harness|run_evaluation\.py/i],
  ];
  for (const [label, pattern] of checks) if (pattern.test(prompt)) violations.push(label);
  return violations;
}

async function capturePatch(sourcePath: string, baseCommit: string, patchPath: string) {
  // Agent/runtime state is not part of a software candidate. Explicit-path
  // `git clean` removes only untracked entries; tracked project config at the
  // same paths is preserved.
  await runRequired("git", ["clean", "-fd", "--", ".omc", ".claude", ".codex", ".cpb", ".codegraph", "cpb-task"], sourcePath, 120_000).catch(() => null);
  await runRequired("git", ["add", "-N", "--", "."], sourcePath, 120_000).catch(() => null);
  const diff = await runRequired("git", ["diff", "--binary", baseCommit, "--", "."], sourcePath, 120_000);
  await mkdir(path.dirname(patchPath), { recursive: true });
  await writeFile(patchPath, diff.stdout, "utf8");
  return { patch: diff.stdout, sha256: sha256(diff.stdout), bytes: Buffer.byteLength(diff.stdout) };
}

async function nativeCodex(
  task: SolverTask,
  sourcePath: string,
  laneRoot: string,
  options: Options,
  boundary: AgentFilesystemBoundary,
) {
  const prompt = ordinaryTaskPrompt(task.task);
  const promptPath = path.join(laneRoot, "prompt.txt");
  const lastMessagePath = path.join(laneRoot, "last-message.txt");
  const isolatedEnv = await createAgentHome(REPO_ROOT, "codex", task.opaqueId, {
    parentEnv: process.env,
    dataRoot: laneRoot,
    isolateTemp: true,
  });
  await writeFile(promptPath, prompt, "utf8");
  const command = await runCommand({
    command: "codex",
    args: [
      "exec", "--ephemeral", "--json", "--color", "never",
      "--ignore-user-config", "--ignore-rules", "--strict-config", "--cd", sourcePath,
      "--model", options.codexModel,
      "-c", `model_reasoning_effort=${JSON.stringify(options.codexReasoningEffort)}`,
      "-c", 'web_search="disabled"',
      "-c", "features.apps=false",
      "-c", "features.plugins=false",
      "-c", "features.remote_plugin=false",
      ...codexFilesystemBoundaryConfigArgs(boundary, "write", [
        String(isolatedEnv.HOME || ""),
        String(isolatedEnv.CODEX_HOME || ""),
        String(isolatedEnv.TMPDIR || ""),
      ].filter(Boolean)),
      "--output-last-message", lastMessagePath, "-",
    ],
    cwd: sourcePath,
    env: { ...process.env, ...isolatedEnv },
    timeoutMs: options.timeoutMs,
    stdin: prompt,
    logs: {
      stdoutPath: path.join(laneRoot, "stdout.log"),
      stderrPath: path.join(laneRoot, "stderr.log"),
      activityPath: path.join(laneRoot, "activity.jsonl"),
    },
  });
  return {
    command,
    prompt,
    metadata: {
      lastMessagePath,
      model: effectiveProviderModel(options.codexModel),
      reasoningEffort: options.codexReasoningEffort,
      sourceBoundary: boundary,
      agentHome: isolatedEnv.HOME || null,
      tempRoot: isolatedEnv.TMPDIR || null,
    },
  };
}

async function nativeClaudeGlm(
  task: SolverTask,
  sourcePath: string,
  laneRoot: string,
  options: Options,
  boundary: AgentFilesystemBoundary,
) {
  const prompt = ordinaryTaskPrompt(task.task);
  const promptPath = path.join(laneRoot, "prompt.txt");
  const stdoutPath = path.join(laneRoot, "stdout.log");
  const stderrPath = path.join(laneRoot, "stderr.log");
  await writeFile(promptPath, prompt, "utf8");
  const providerEnv = envForAgent("claude-glm", {
    ...process.env,
    ZHIPU_MODEL: options.glmModel,
    GLM_MODEL: options.glmModel,
  }) as NodeJS.ProcessEnv;
  const env = buildNativeClaudeIsolatedEnv(laneRoot, providerEnv);
  const settingsPath = path.join(String(env.CLAUDE_CONFIG_DIR), "settings.json");
  const guardScriptPath = path.join(DIST_ROOT, "scripts", "claude-path-guard.js");
  await Promise.all([
    mkdir(String(env.HOME), { recursive: true }),
    mkdir(String(env.CLAUDE_CONFIG_DIR), { recursive: true }),
    mkdir(String(env.XDG_CONFIG_HOME), { recursive: true }),
    mkdir(String(env.XDG_DATA_HOME), { recursive: true }),
    mkdir(String(env.XDG_CACHE_HOME), { recursive: true }),
    mkdir(String(env.TMPDIR), { recursive: true }),
  ]);
  const nativeSandboxSettings = buildNativeClaudeSettings(
    sourcePath,
    String(env.HOME),
    String(env.TMPDIR),
    guardScriptPath,
    boundary,
  );
  await writeJsonAtomic(settingsPath, nativeSandboxSettings);
  const model = text(env.ANTHROPIC_MODEL || env.ZHIPU_MODEL);
  const args = buildNativeClaudeArgs(model, settingsPath, prompt);
  const command = await runCommand({
    command: "claude",
    args,
    cwd: sourcePath,
    env,
    timeoutMs: options.timeoutMs,
    logs: {
      stdoutPath,
      stderrPath,
      activityPath: path.join(laneRoot, "activity.jsonl"),
    },
  });
  const attestation = observedModelAttestation(await readFile(stdoutPath, "utf8").catch(() => ""));
  const expectedModel = effectiveProviderModel(options.glmModel);
  const modelContractViolation = observedModelContractViolation(attestation, expectedModel);
  return {
    command,
    prompt,
    metadata: {
      providerKey: "claude:glm",
      model: model || null,
      expectedObservedModel: expectedModel,
      observedModels: attestation,
      modelContractViolation,
      sourceBoundary: boundary,
      sandbox: {
        provider: "claude-native",
        settingsPath,
        settingsSha256: sha256(stableJson(nativeSandboxSettings)),
        enabled: nativeSandboxSettings.sandbox.enabled,
        failIfUnavailable: nativeSandboxSettings.sandbox.failIfUnavailable,
        allowUnsandboxedCommands: nativeSandboxSettings.sandbox.allowUnsandboxedCommands,
      },
      agentHome: env.HOME,
    },
  };
}

async function writeNeutralAssignment({
  runRoot,
  laneRoot,
  task,
  sourcePath,
}: {
  runRoot: string;
  laneRoot: string;
  task: SolverTask;
  sourcePath: string;
}) {
  const hubRoot = path.join(laneRoot, "hub");
  const cpbRoot = path.join(laneRoot, "cpb");
  const workerId = `w-${task.opaqueId}`;
  const entryId = task.opaqueId;
  const projectId = `project-${task.opaqueId}`;
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const previousIndexOnly = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
  process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
  try {
    await registerProject(hubRoot, {
      id: projectId,
      name: projectId,
      sourcePath,
      metadata: { comparisonRunRootHash: sha256(runRoot), lane: "cpb_high_assurance" },
    });
  } finally {
    if (previousIndexOnly === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
    else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previousIndexOnly;
  }
  const agents: ProductValidationAgents = {
    planner: "codex",
    executor: "claude-glm",
    verifier: "codex",
    adversarial_verifier: "codex",
  };
  const input = {
    entryId, projectId,
    task: task.task,
    sourcePath,
    workflow: "standard",
    planMode: "full",
    sourceContext: {
      agentPolicy: {
        allowedAgents: [...CPB_ALLOWED_AGENTS],
        enforcement: "fail_closed",
      },
      assurance: {
        mode: "high",
        planning: { candidates: ["codex", "claude-glm"], arbiter: "codex", critiqueRounds: 1 },
        execution: { agent: "claude-glm", required: true },
        verification: { agent: "codex", required: true, blind: true, independent: true },
      },
      comparison: { lane: "cpb_high_assurance", taskId: task.opaqueId },
    },
    metadata: { autoFinalize: true, finalizeMode: "dry-run", agents },
  };
  const assignment = await store.getOrCreateAssignmentForEntry(input);
  const assignmentId = String(assignment.assignmentId);
  const attempt = await store.createAttempt(assignmentId, { workerId, orchestratorEpoch: 1 });
  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", String(attempt.attempt).padStart(3, "0"));
  const inboxPath = path.join(hubRoot, "workers", "inbox", workerId, `${assignmentId}-attempt-${String(attempt.attempt).padStart(3, "0")}.json`);
  await mkdir(path.dirname(inboxPath), { recursive: true });
  await writeJsonAtomic(inboxPath, {
    ...assignment,
    ...attempt,
    workerId,
    status: "assigned",
    sourcePath,
    task: task.task,
    workflow: "standard",
    planMode: "full",
    sourceContext: input.sourceContext,
    metadata: input.metadata,
  });
  return { hubRoot, cpbRoot, workerId, assignmentId, entryId, projectId, attemptDir, agents };
}

async function collectPromptFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const name of await readdir(dir)) {
      const target = path.join(dir, name);
      const info = await stat(target);
      if (info.isDirectory()) await walk(target);
      else if (
        /^prompt-[^.]+\.md$/i.test(name)
        && dir.endsWith(`${path.sep}wiki${path.sep}outputs`)
        && info.size <= 5_000_000
      ) files.push(target);
    }
  };
  await walk(root);
  return files;
}

async function collectObservedModels(root: string) {
  if (!(await exists(root))) {
    return {
      aggregate: { initModels: [], assistantModels: [], modelUsageModels: [] } as ObservedModelAttestation,
      streams: [] as LooseRecord[],
    };
  }
  const files = (await readdir(root))
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(root, name))
    .sort();
  const initModels = new Set<string>();
  const assistantModels = new Set<string>();
  const modelUsageModels = new Set<string>();
  const streams: LooseRecord[] = [];
  for (const file of files) {
    const attestation = observedModelAttestation(await readFile(file, "utf8").catch(() => ""));
    for (const model of attestation.initModels) initModels.add(model);
    for (const model of attestation.assistantModels) assistantModels.add(model);
    for (const model of attestation.modelUsageModels) modelUsageModels.add(model);
    streams.push({ file, ...attestation });
  }
  return {
    aggregate: {
      initModels: [...initModels].sort(),
      assistantModels: [...assistantModels].sort(),
      modelUsageModels: [...modelUsageModels].sort(),
    },
    streams,
  };
}

export async function latestCandidateReplayBundle(outputsRoot: string) {
  if (!(await exists(outputsRoot))) return { bundle: null, path: null, error: null };
  const candidates = (await readdir(outputsRoot))
    .filter((name) => /^candidate-replay-bundle-[^.]+\.md$/i.test(name))
    .map((name) => path.join(outputsRoot, name));
  const ranked = await Promise.all(candidates.map(async (candidatePath) => ({
    path: candidatePath,
    mtimeMs: (await stat(candidatePath)).mtimeMs,
  })));
  ranked.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  if (ranked.length === 0) return { bundle: null, path: null, error: null };
  const replayPath = ranked[0].path;
  try {
    const bundle = await readJson<CandidateReplayBundle>(replayPath);
    const invalidReason = validateCandidateReplayBundle(bundle);
    if (invalidReason) return { bundle: null, path: replayPath, error: invalidReason };
    return { bundle, path: replayPath, error: null };
  } catch (error) {
    return {
      bundle: null,
      path: replayPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cpbHighAssurance(
  task: SolverTask,
  sourcePath: string,
  laneRoot: string,
  runRoot: string,
  options: Options,
  boundary: AgentFilesystemBoundary,
) {
  const codegraph = await initializeCodeGraph(sourcePath);
  const assignment = await writeNeutralAssignment({ runRoot, laneRoot, task, sourcePath });
  const frozenDistRoot = path.join(runRoot, "runtime-dist");
  const stopQuotaDelegate = await startQuotaDelegate(assignment.hubRoot, laneRoot, frozenDistRoot);
  let worker;
  try {
    worker = await runManagedWorker({
      workerId: assignment.workerId,
      hubRoot: assignment.hubRoot,
      cpbRoot: assignment.cpbRoot,
      assignmentId: assignment.assignmentId,
      phaseAgents: assignment.agents,
      timeoutMs: options.timeoutMs,
      distRoot: frozenDistRoot,
      extraEnv: {
        CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
        CPB_ASSURANCE_MODE: "high",
        CPB_AGENT_FS_BOUNDARY_JSON: JSON.stringify(boundary),
        ZHIPU_MODEL: options.glmModel,
        GLM_MODEL: options.glmModel,
        CPB_ACP_CODEX_ARGS: JSON.stringify([
          "-c", `model=${JSON.stringify(options.codexModel)}`,
          "-c", `model_reasoning_effort=${JSON.stringify(options.codexReasoningEffort)}`,
        ]),
      },
    });
  } finally {
    await stopQuotaDelegate();
  }
  const resultPath = path.join(assignment.attemptDir, "result.json");
  const result: LooseRecord = await readJson<LooseRecord>(resultPath).catch((): LooseRecord => ({}));
  const candidatePath = path.join(assignment.hubRoot, "worktrees", `job-${assignment.entryId}-pipeline`);
  const jobResult = isRecord(result.jobResult) ? result.jobResult : {};
  const phaseResults = Array.isArray(jobResult.phaseResults) ? jobResult.phaseResults.filter(isRecord) : [];
  const verifyPassed = phaseResults.some((phase) => phase.phase === "verify" && phase.status === "passed");
  const completionReport = isRecord(jobResult.completionReport) ? jobResult.completionReport : {};
  const candidateValidation = isRecord(completionReport.candidateValidation) ? completionReport.candidateValidation : {};
  const candidateBound = Object.keys(candidateValidation).length > 0 && candidateValidation.matches !== false;
  const candidateReadable = await exists(path.join(candidatePath, ".git"));
  const replay = await latestCandidateReplayBundle(path.join(
    assignment.hubRoot,
    "projects",
    assignment.projectId,
    "wiki",
    "outputs",
  ));
  const completionViolations = [
    ...(result.status === "completed" ? [] : [`attempt_status:${text(result.status) || "missing"}`]),
    ...(jobResult.status === "completed" ? [] : [`job_status:${text(jobResult.status) || "missing"}`]),
    ...(verifyPassed ? [] : ["verify_phase_not_passed"]),
    ...(candidateBound ? [] : ["candidate_identity_not_bound"]),
    ...(candidateReadable ? [] : ["candidate_worktree_missing"]),
    ...(replay.error ? [`candidate_replay_invalid:${replay.error}`] : []),
  ];
  const promptFiles = [
    ...await collectPromptFiles(assignment.cpbRoot),
    ...await collectPromptFiles(assignment.hubRoot),
  ];
  const promptCorpus = (await Promise.all(promptFiles.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
  const observedModels = await collectObservedModels(path.join(
    assignment.hubRoot,
    "projects",
    assignment.projectId,
    "acp-streams",
    `job-${assignment.entryId}`,
  ));
  const expectedObservedModel = effectiveProviderModel(options.glmModel);
  const modelContractViolation = observedModelContractViolation(observedModels.aggregate, expectedObservedModel);
  const agentAuditPath = path.join(
    assignment.hubRoot,
    "projects",
    assignment.projectId,
    "acp-audit",
    assignment.projectId,
    `job-${assignment.entryId}.jsonl`,
  );
  const agentAudit = await readFile(agentAuditPath, "utf8").catch(() => "");
  const rawAgentContractViolation = agentLaunchContractViolation(agentAudit, CPB_ALLOWED_AGENTS);
  const jobFailure = isRecord(jobResult.failure) ? jobResult.failure : {};
  const hardGateFailure = isRecord(jobFailure.cause) && jobFailure.cause.hardGate === true;
  const agentContractViolation = rawAgentContractViolation === "agent_launch_audit_missing"
    && jobResult.status !== "completed"
    && !hardGateFailure
    ? null
    : rawAgentContractViolation;
  if (agentContractViolation) completionViolations.push(agentContractViolation);
  const eventPath = path.join(
    assignment.hubRoot,
    "projects",
    assignment.projectId,
    "events",
    assignment.projectId,
    `job-${assignment.entryId}.jsonl`,
  );
  const eventAudit = await readFile(eventPath, "utf8").catch(() => "");
  const rawIndependentVerificationViolation = independentVerificationContractViolation(eventAudit);
  const independentVerificationViolation = jobResult.status !== "completed"
    && (rawIndependentVerificationViolation === "independent_verification_mutator_missing"
      || rawIndependentVerificationViolation === "independent_verification_verifier_missing")
    ? null
    : rawIndependentVerificationViolation;
  if (independentVerificationViolation) completionViolations.push(independentVerificationViolation);
  return {
    command: {
      code: worker.code,
      signal: worker.signal,
      stdout: worker.stdout,
      stderr: worker.stderr,
      timedOut: worker.timedOut === true,
      error: worker.errorMessage || (completionViolations.length > 0 ? `CPB completion invariant failed: ${completionViolations.join(", ")}` : null),
    },
    prompt: promptCorpus,
    candidatePath,
    frozenCandidatePatch: replay.bundle?.patch,
    frozenCandidatePatchError: replay.error,
    metadata: {
      resultPath,
      assignmentId: assignment.assignmentId,
      projectId: assignment.projectId,
      promptFiles,
      codegraph,
      completionViolations,
      attemptStatus: result.status || null,
      jobStatus: jobResult.status || null,
      verifyPassed,
      candidateValidation,
      candidateReplay: replay.bundle ? {
        path: replay.path,
        bundleHash: replay.bundle.bundleHash,
        candidateIdentityHash: replay.bundle.candidateIdentityHash,
        patchSha256: replay.bundle.patchSha256,
        patchBytes: replay.bundle.patchBytes,
      } : { path: replay.path, error: replay.error },
      jobFailure: Object.keys(jobFailure).length > 0 ? jobFailure : null,
      models: {
        codex: effectiveProviderModel(options.codexModel),
        codexReasoningEffort: options.codexReasoningEffort,
        claudeGlm: effectiveProviderModel(options.glmModel),
      },
      expectedObservedModel,
      observedModels,
      modelContractViolation,
      agentAuditPath,
      rawAgentContractViolation,
      agentContractViolation,
      eventPath,
      rawIndependentVerificationViolation,
      independentVerificationViolation,
      sourceBoundary: boundary,
    },
  };
}

async function runLane(task: SolverTask, evaluator: EvaluatorTask, lane: Lane, options: Options): Promise<LaneResult> {
  const laneRoot = path.join(options.runRoot, "lanes", lane, task.opaqueId);
  const resultPath = path.join(laneRoot, "result.json");
  await mkdir(laneRoot, { recursive: true });
  const startedAt = now();
  let sourcePath = path.join(laneRoot, "source");
  try {
    sourcePath = await prepareSource(task, laneRoot, options.runRoot);
  } catch (error) {
    const message = `source preparation failed: ${error instanceof Error ? error.message : String(error)}`;
    const patchPath = path.join(laneRoot, "candidate.patch");
    const stdoutPath = path.join(laneRoot, "stdout.log");
    const stderrPath = path.join(laneRoot, "stderr.log");
    const emptyPatchSha256 = sha256("");
    await Promise.all([
      writeFile(patchPath, "", "utf8"),
      writeFile(stdoutPath, "", "utf8"),
      writeFile(stderrPath, `${message}\n`, "utf8"),
    ]);
    const result: LaneResult = {
      lane,
      opaqueId: task.opaqueId,
      status: "failed",
      startedAt,
      completedAt: now(),
      sourcePath,
      patchPath,
      patchSha256: emptyPatchSha256,
      patchBytes: 0,
      exitCode: null,
      signal: null,
      timedOut: /timed?\s*out/i.test(message),
      error: message,
      promptLeakage: [],
      stdoutPath,
      stderrPath,
      metadata: { failureStage: "source_prepare" },
    };
    await writeJsonAtomic(resultPath, result);
    await writeJsonAtomic(path.join(laneRoot, "state.json"), result);
    return result;
  }
  await writeJsonAtomic(path.join(laneRoot, "state.json"), {
    lane,
    opaqueId: task.opaqueId,
    status: "running",
    startedAt,
    sourcePath,
  });
  let sourceBoundary: AgentFilesystemBoundary | null = null;
  let sourceBoundaryPreflight: LooseRecord | null = null;
  let execution;
  try {
    sourceBoundary = await buildAgentFilesystemBoundary(task.repository, sourcePath, options.runRoot);
    await writeJsonAtomic(path.join(laneRoot, "source-boundary.json"), sourceBoundary);
    sourceBoundaryPreflight = await verifyCodexFilesystemBoundary(sourcePath, sourceBoundary, laneRoot);
    execution = lane === "native_codex"
      ? await nativeCodex(task, sourcePath, laneRoot, options, sourceBoundary)
      : lane === "native_claude_glm"
        ? await nativeClaudeGlm(task, sourcePath, laneRoot, options, sourceBoundary)
        : await cpbHighAssurance(task, sourcePath, laneRoot, options.runRoot, options, sourceBoundary);
  } catch (error) {
    const sourceBoundaryViolation = sourceBoundary === null || sourceBoundaryPreflight?.ok !== true
      ? `source_boundary_unavailable:${error instanceof Error ? error.message : String(error)}`
      : null;
    execution = {
      command: { code: null, signal: null, stdout: "", stderr: "", timedOut: false, error: error instanceof Error ? error.message : String(error) },
      prompt: lane === "cpb_high_assurance" ? "" : ordinaryTaskPrompt(task.task),
      metadata: { sourceBoundaryViolation },
      candidatePath: sourcePath,
    };
  }
  const stdoutPath = path.join(laneRoot, "stdout.log");
  const stderrPath = path.join(laneRoot, "stderr.log");
  if (!(await exists(stdoutPath))) await writeFile(stdoutPath, execution.command.stdout, "utf8");
  if (!(await exists(stderrPath))) await writeFile(stderrPath, execution.command.stderr, "utf8");
  const candidatePath = "candidatePath" in execution && execution.candidatePath ? execution.candidatePath : sourcePath;
  const patchPath = path.join(laneRoot, "candidate.patch");
  const frozenCandidatePatch = "frozenCandidatePatch" in execution
    && typeof execution.frozenCandidatePatch === "string"
    ? execution.frozenCandidatePatch
    : null;
  const frozenCandidatePatchError = "frozenCandidatePatchError" in execution
    && typeof execution.frozenCandidatePatchError === "string"
    ? execution.frozenCandidatePatchError
    : null;
  const patch = frozenCandidatePatchError
    ? await (async () => {
        await writeFile(patchPath, "", "utf8");
        return { patch: "", sha256: sha256(""), bytes: 0, error: `frozen candidate replay invalid: ${frozenCandidatePatchError}` };
      })()
    : frozenCandidatePatch !== null
      ? await (async () => {
          await writeFile(patchPath, frozenCandidatePatch, "utf8");
          return {
            patch: frozenCandidatePatch,
            sha256: sha256(frozenCandidatePatch),
            bytes: Buffer.byteLength(frozenCandidatePatch, "utf8"),
          };
        })()
      : await capturePatch(candidatePath, task.baseCommit, patchPath).catch(async (error) => {
          await writeFile(patchPath, "", "utf8");
          return { patch: "", sha256: sha256(""), bytes: 0, error: error instanceof Error ? error.message : String(error) };
        });
  const promptLeakage = promptLeakageViolations(execution.prompt, evaluator.instanceId);
  const commandOk = execution.command.code === 0 && !execution.command.timedOut && !execution.command.error;
  const patchError = "error" in patch ? patch.error || "candidate patch capture failed" : null;
  const executionMetadata = isRecord(execution.metadata) ? execution.metadata : {};
  const modelContractViolation = typeof executionMetadata.modelContractViolation === "string"
    && executionMetadata.modelContractViolation
    ? executionMetadata.modelContractViolation
    : null;
  const agentContractViolation = typeof executionMetadata.agentContractViolation === "string"
    && executionMetadata.agentContractViolation
    ? executionMetadata.agentContractViolation
    : null;
  const sourceBoundaryViolation = typeof executionMetadata.sourceBoundaryViolation === "string"
    && executionMetadata.sourceBoundaryViolation
    ? executionMetadata.sourceBoundaryViolation
    : null;
  const result: LaneResult = {
    lane,
    opaqueId: task.opaqueId,
    status: promptLeakage.length > 0 || patchError || modelContractViolation || agentContractViolation || sourceBoundaryViolation ? "blocked" : commandOk ? "completed" : "failed",
    startedAt,
    completedAt: now(),
    sourcePath: candidatePath,
    patchPath,
    patchSha256: patch.sha256,
    patchBytes: patch.bytes,
    exitCode: execution.command.code,
    signal: execution.command.signal,
    timedOut: execution.command.timedOut,
    error: execution.command.error || patchError || modelContractViolation || agentContractViolation || sourceBoundaryViolation,
    promptLeakage,
    stdoutPath,
    stderrPath,
    metadata: {
      ...executionMetadata,
      sourceBoundary,
      sourceBoundaryPreflight,
    },
  };
  await writeJsonAtomic(resultPath, result);
  await writeJsonAtomic(path.join(laneRoot, "state.json"), result);
  return result;
}

async function executeAll(solverTasks: SolverTask[], evaluatorTasks: EvaluatorTask[], options: Options) {
  const recoveredInvocations = await reconcileInterruptedSolverInvocations(options.runRoot);
  const invocationStartedAt = now();
  const invocationId = `solver-${invocationStartedAt.replace(/[^0-9]/g, "")}-${process.pid}`;
  const invocationPath = path.join(options.runRoot, "solver-invocations", `${invocationId}.json`);
  const invocation = {
    schemaVersion: 2,
    invocationId,
    runId: options.runId,
    host: hostname(),
    pid: process.pid,
    startedAt: invocationStartedAt,
    status: "running",
    solverAttempts: options.solverAttempts,
    solverRetryBackoffMs: options.solverRetryBackoffMs,
    laneConcurrency: { ...options.solverLaneConcurrency },
    taskCount: solverTasks.length,
    lanes: options.lanes,
    recoveredInvocations,
  };
  await mkdir(path.dirname(invocationPath), { recursive: true });
  await writeJsonAtomic(invocationPath, invocation);
  const results: LaneResult[] = [];
  let progressWrite = Promise.resolve();
  const writeProgress = () => {
    const completedByLane = Object.fromEntries(options.lanes.map((lane) => [
      lane,
      results.filter((result) => result.lane === lane).length,
    ]));
    progressWrite = progressWrite.then(() => writeJsonAtomic(invocationPath, {
      ...invocation,
      resultCount: results.length,
      completedByLane,
      lastProgressAt: now(),
    }));
    return progressWrite;
  };
  try {
    const queued = await runIndependentLaneQueues({
      lanes: options.lanes,
      taskCount: solverTasks.length,
      laneConcurrency: options.solverLaneConcurrency,
      run: async (lane, index) => {
      const task = solverTasks[index];
      const evaluator = evaluatorTasks.find((entry) => entry.opaqueId === task.opaqueId);
      if (!evaluator) throw new Error(`evaluator mapping missing for ${task.opaqueId}`);
      console.log(`[${lane} ${index + 1}/${solverTasks.length}] ${task.opaqueId}`);
      const existing = await prepareLaneForSolverInvocation(lane, task.opaqueId, options, invocationId);
      let result = existing || await runLane(task, evaluator, lane, options);
      for (let attempt = 1; attempt < options.solverAttempts; attempt += 1) {
        const diagnostics = [
          await readFile(result.stdoutPath, "utf8").catch(() => ""),
          await readFile(result.stderrPath, "utf8").catch(() => ""),
        ].join("\n").slice(-20_000);
        if (!isTransientSolverFailure(result, diagnostics)) break;
        const backoffMs = solverRetryDelayMs(
          result,
          diagnostics,
          options.solverRetryBackoffMs * attempt,
        );
        const archive = await archiveLaneAttempt(result, attempt, options, invocationId, backoffMs);
        console.log(`  ${lane}/${task.opaqueId} transient failure archived as attempt-${String(archive.historyAttempt).padStart(3, "0")}; retry ${attempt + 1}/${options.solverAttempts} after ${backoffMs}ms`);
        if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
        result = await runLane(task, evaluator, lane, options);
      }
      const finalDiagnostics = [
        await readFile(result.stdoutPath, "utf8").catch(() => ""),
        await readFile(result.stderrPath, "utf8").catch(() => ""),
      ].join("\n").slice(-20_000);
      if (isTransientSolverFailure(result, finalDiagnostics)) {
        const originalError = result.error;
        result = {
          ...result,
          status: "blocked",
          error: `transient solver failure exhausted this invocation's retry budget; resume the same frozen run: ${originalError || "unknown transient failure"}`,
          metadata: {
            ...(isRecord(result.metadata) ? result.metadata : {}),
            transientExhausted: true,
            resumeRequired: true,
            solverInvocationId: invocationId,
            attemptsThisInvocation: options.solverAttempts,
            originalError,
          },
        };
        await writeJsonAtomic(path.join(options.runRoot, "lanes", lane, task.opaqueId, "result.json"), result);
        await writeJsonAtomic(path.join(options.runRoot, "lanes", lane, task.opaqueId, "state.json"), result);
      }
      const laneRoot = path.join(options.runRoot, "lanes", lane, task.opaqueId);
      const artifactRetention = await compactLaneEphemeralArtifacts(laneRoot, options.runRoot);
      result = {
        ...result,
        metadata: {
          ...(isRecord(result.metadata) ? result.metadata : {}),
          artifactRetention,
        },
      };
      await writeJsonAtomic(path.join(laneRoot, "result.json"), result);
      await writeJsonAtomic(path.join(laneRoot, "state.json"), result);
      results.push(result);
      await writeProgress();
      console.log(`  ${lane}/${task.opaqueId} ${result.status} patch=${result.patchBytes}B exit=${result.exitCode}`);
      return result;
      },
    });
    const orderedResults = queued.map((entry) => entry.value);
    await progressWrite;
    await writeJsonAtomic(invocationPath, {
      ...invocation,
      status: "completed",
      completedAt: now(),
      resultCount: orderedResults.length,
      completedByLane: Object.fromEntries(options.lanes.map((lane) => [
        lane,
        orderedResults.filter((result) => result.lane === lane).length,
      ])),
    });
    return orderedResults;
  } catch (error) {
    await progressWrite;
    await writeJsonAtomic(invocationPath, {
      ...invocation,
      status: "failed",
      completedAt: now(),
      resultCount: results.length,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function allLaneResults(solverTasks: SolverTask[], options: Options) {
  const results: LaneResult[] = [];
  for (const task of solverTasks) {
    for (const lane of options.lanes) {
      const resultPath = path.join(options.runRoot, "lanes", lane, task.opaqueId, "result.json");
      if (!(await exists(resultPath))) throw new Error(`candidate is not frozen: ${lane}/${task.opaqueId}`);
      results.push(await readJson<LaneResult>(resultPath));
    }
  }
  return results;
}

async function writePredictions(
  solverTasks: SolverTask[],
  evaluatorTasks: EvaluatorTask[],
  results: LaneResult[],
  options: Options,
) {
  const paths: Partial<Record<Lane, string>> = {};
  for (const lane of options.lanes) {
    const predictions = [];
    for (const task of solverTasks) {
      const evaluator = evaluatorTasks.find((entry) => entry.opaqueId === task.opaqueId);
      const result = results.find((entry) => entry.opaqueId === task.opaqueId && entry.lane === lane);
      if (!evaluator || !result) throw new Error(`missing frozen mapping for ${lane}/${task.opaqueId}`);
      const modelPatch = await readFile(result.patchPath, "utf8").catch(() => "");
      predictions.push({ instance_id: evaluator.instanceId, model_name_or_path: lane, model_patch: modelPatch });
    }
    const outputPath = path.join(options.runRoot, "predictions", `${lane}.jsonl`);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, predictions.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    paths[lane] = outputPath;
  }
  return paths;
}

export type HarnessInstanceResult = {
  instanceId: string;
  resolved: boolean;
  reportPath: string | null;
  attempt: number | null;
  testsStatus: LooseRecord | null;
};

export function parseHarnessInstanceReport(report: unknown, instanceId: string) {
  if (!isRecord(report)) return { ok: false as const, reason: "report_missing_or_invalid" };
  const entry = recordValue(report[instanceId]);
  if (typeof entry.resolved !== "boolean") {
    return { ok: false as const, reason: "report_instance_or_resolved_missing" };
  }
  return {
    ok: true as const,
    result: {
      instanceId,
      resolved: entry.resolved,
      testsStatus: isRecord(entry.tests_status) ? entry.tests_status : null,
    },
  };
}

export function selectHarnessRetryIds({
  requestedIds,
  aggregate,
  reports,
}: {
  requestedIds: string[];
  aggregate: unknown;
  reports: Record<string, unknown>;
}) {
  const aggregateRecord = recordValue(aggregate);
  const emptyPatchIds = new Set(Array.isArray(aggregateRecord.empty_patch_ids)
    ? aggregateRecord.empty_patch_ids.map(String)
    : []);
  return requestedIds.filter((instanceId) => {
    if (emptyPatchIds.has(instanceId)) return false;
    return !parseHarnessInstanceReport(reports[instanceId], instanceId).ok;
  });
}

export function nextHarnessAttemptNumber(attemptHistory: unknown[], discoveredAttemptNumbers: number[]) {
  const highest = Math.max(
    0,
    ...discoveredAttemptNumbers.filter((entry) => Number.isInteger(entry) && entry > 0),
    ...attemptHistory.map((entry) => Number(recordValue(entry).attempt) || 0),
  );
  return highest + 1;
}

function harnessCategory(testsStatus: LooseRecord | null, category: "FAIL_TO_PASS" | "PASS_TO_PASS") {
  const value = recordValue(testsStatus?.[category]);
  const success = Array.isArray(value.success) ? value.success.map(String) : [];
  const failure = Array.isArray(value.failure) ? value.failure.map(String) : [];
  return { success, failure, total: success.length + failure.length };
}

export function summarizeHarnessTestMetrics(instanceResults: HarnessInstanceResult[]) {
  const perInstance: Record<string, LooseRecord> = {};
  const totals = {
    FAIL_TO_PASS: { success: 0, failure: 0, total: 0 },
    PASS_TO_PASS: { success: 0, failure: 0, total: 0 },
  };
  const metricsAvailableIds: string[] = [];
  const metricsMissingIds: string[] = [];
  for (const result of instanceResults) {
    if (!result.testsStatus) {
      metricsMissingIds.push(result.instanceId);
      perInstance[result.instanceId] = { resolved: result.resolved, metricsAvailable: false };
      continue;
    }
    metricsAvailableIds.push(result.instanceId);
    const failToPass = harnessCategory(result.testsStatus, "FAIL_TO_PASS");
    const passToPass = harnessCategory(result.testsStatus, "PASS_TO_PASS");
    for (const [name, category] of Object.entries({ FAIL_TO_PASS: failToPass, PASS_TO_PASS: passToPass })) {
      totals[name as keyof typeof totals].success += category.success.length;
      totals[name as keyof typeof totals].failure += category.failure.length;
      totals[name as keyof typeof totals].total += category.total;
    }
    perInstance[result.instanceId] = {
      resolved: result.resolved,
      metricsAvailable: true,
      FAIL_TO_PASS: failToPass,
      PASS_TO_PASS: passToPass,
    };
  }
  return {
    metricsAvailableIds: metricsAvailableIds.sort(),
    metricsMissingIds: metricsMissingIds.sort(),
    perInstance,
    micro: {
      FAIL_TO_PASS: {
        ...totals.FAIL_TO_PASS,
        rate: totals.FAIL_TO_PASS.total > 0 ? totals.FAIL_TO_PASS.success / totals.FAIL_TO_PASS.total : null,
      },
      PASS_TO_PASS: {
        ...totals.PASS_TO_PASS,
        rate: totals.PASS_TO_PASS.total > 0 ? totals.PASS_TO_PASS.success / totals.PASS_TO_PASS.total : null,
      },
    },
  };
}

export async function recoverHarnessInstanceReports({
  harnessRoot,
  lane,
  runId,
  expectedIds,
  instanceResults,
  attemptHistory,
}: {
  harnessRoot: string;
  lane: Lane;
  runId: string;
  expectedIds: string[];
  instanceResults: Map<string, HarnessInstanceResult>;
  attemptHistory: LooseRecord[];
}) {
  for (const instanceId of expectedIds) {
    const current = instanceResults.get(instanceId);
    if (current?.testsStatus) continue;
    const candidates: Array<{ reportPath: string; attempt: number | null }> = [];
    if (current?.reportPath) {
      candidates.push({ reportPath: current.reportPath, attempt: current.attempt });
    }
    candidates.push({
      reportPath: path.join(harnessRoot, "logs", "run_evaluation", runId, lane, instanceId, "report.json"),
      attempt: null,
    });
    for (const rawAttempt of attemptHistory) {
      const attempt = recordValue(rawAttempt);
      const reportPath = text(recordValue(attempt.reportPaths)[instanceId]);
      if (reportPath) {
        candidates.push({
          reportPath,
          attempt: Number.isInteger(Number(attempt.attempt)) ? Number(attempt.attempt) : null,
        });
      }
    }
    const visited = new Set<string>();
    for (const candidate of candidates) {
      if (visited.has(candidate.reportPath)) continue;
      visited.add(candidate.reportPath);
      const report = await readJson<LooseRecord>(candidate.reportPath).catch(() => null);
      const parsed = parseHarnessInstanceReport(report, instanceId);
      if (!parsed.ok) continue;
      instanceResults.set(instanceId, {
        ...parsed.result,
        reportPath: candidate.reportPath,
        attempt: candidate.attempt ?? current?.attempt ?? null,
      });
      break;
    }
  }
}

async function runHarness(lane: Lane, predictionsPath: string, evaluatorTasks: EvaluatorTask[], options: Options) {
  const harnessRoot = path.join(options.runRoot, "harness", lane);
  await mkdir(harnessRoot, { recursive: true });
  const runId = `${options.runId}-${lane}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const predictionsSha256 = sha256(await readFile(predictionsPath));
  const summaryPath = path.join(harnessRoot, "official-score-summary.json");
  const expectedIds = evaluatorTasks.map((task) => task.instanceId);
  const expectedIdSet = new Set(expectedIds);
  const instanceResults = new Map<string, HarnessInstanceResult>();
  const emptyPatchIds = new Set<string>();
  const attemptHistory: LooseRecord[] = [];
  const attemptsRoot = path.join(harnessRoot, "attempts");

  if (await exists(summaryPath)) {
    const existing = await readJson<LooseRecord>(summaryPath);
    const resume = harnessResumeDecision(existing, {
      lane,
      runId,
      predictionsSha256,
      totalInstances: evaluatorTasks.length,
    });
    if (resume.reusable) {
      if (!(await exists(String(resume.aggregatePath)))) {
        throw new Error(`official harness resume rejected for ${lane}: aggregate report is missing`);
      }
      console.log(`  revalidating reusable official harness score for ${lane}`);
    } else {
      const identityMismatches = [
        ...(existing.lane === lane ? [] : ["lane"]),
        ...(existing.runId === runId ? [] : ["run_id"]),
        ...(existing.predictionsSha256 === predictionsSha256 ? [] : ["predictions_sha256"]),
        ...(Number(existing.totalInstances) === evaluatorTasks.length ? [] : ["total_instances"]),
      ];
      if (identityMismatches.length > 0) {
        throw new Error(`official harness resume rejected for ${lane}: summary_mismatch:${identityMismatches.join(",")}`);
      }
    }
    for (const raw of Array.isArray(existing.instanceResults) ? existing.instanceResults : []) {
      const result = recordValue(raw);
      const instanceId = text(result.instanceId);
      if (!expectedIdSet.has(instanceId) || typeof result.resolved !== "boolean") continue;
      instanceResults.set(instanceId, {
        instanceId,
        resolved: result.resolved,
        reportPath: text(result.reportPath) || null,
        attempt: typeof result.attempt === "number" ? result.attempt : null,
        testsStatus: isRecord(result.testsStatus) ? result.testsStatus : null,
      });
    }
    if (instanceResults.size === 0) {
      for (const instanceId of Array.isArray(existing.resolvedIds) ? existing.resolvedIds.map(String) : []) {
        if (expectedIdSet.has(instanceId)) instanceResults.set(instanceId, { instanceId, resolved: true, reportPath: null, attempt: null, testsStatus: null });
      }
      for (const instanceId of Array.isArray(existing.unresolvedIds) ? existing.unresolvedIds.map(String) : []) {
        if (expectedIdSet.has(instanceId)) instanceResults.set(instanceId, { instanceId, resolved: false, reportPath: null, attempt: null, testsStatus: null });
      }
    }
    for (const instanceId of Array.isArray(existing.emptyPatchIds) ? existing.emptyPatchIds.map(String) : []) {
      if (expectedIdSet.has(instanceId)) emptyPatchIds.add(instanceId);
    }
    attemptHistory.push(...(Array.isArray(existing.attempts) ? existing.attempts.map(recordValue) : []));
  }

  const attemptEntries = await readdir(attemptsRoot, { withFileTypes: true }).catch(() => []);
  const discoveredAttemptNumbers = attemptEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => Number.parseInt(entry.name.match(/^attempt-(\d+)$/)?.[1] || "", 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
  const knownAttemptRunIds = new Set(attemptHistory.map((entry) => text(recordValue(entry).runId)).filter(Boolean));
  for (const attempt of discoveredAttemptNumbers) {
    const attemptSummaryPath = path.join(attemptsRoot, `attempt-${String(attempt).padStart(3, "0")}`, "attempt-summary.json");
    const attemptSummary = await readJson<LooseRecord>(attemptSummaryPath).catch(() => null);
    if (attemptSummary && !knownAttemptRunIds.has(text(attemptSummary.runId))) {
      attemptHistory.push(attemptSummary);
      knownAttemptRunIds.add(text(attemptSummary.runId));
    }
  }

  await recoverHarnessInstanceReports({
    harnessRoot,
    lane,
    runId,
    expectedIds,
    instanceResults,
    attemptHistory,
  });

  const pythonCandidates = [...new Set([
    process.env.CPB_SWEBENCH_HARNESS_PYTHON,
    "/opt/anaconda3/bin/python",
    "/opt/conda/bin/python",
    "python3",
    "python",
  ].filter((entry): entry is string => Boolean(entry)))];
  let harnessPython = "";
  for (const candidate of pythonCandidates) {
    const probe = await runCommand({
      command: candidate,
      args: ["-c", "import swebench"],
      cwd: harnessRoot,
      timeoutMs: 30_000,
    });
    if (probe.code === 0) {
      harnessPython = candidate;
      break;
    }
  }
  if (!harnessPython) {
    throw new Error(`official harness Python unavailable; probed: ${pythonCandidates.join(", ")}`);
  }

  const frozenPredictions = (await readFile(predictionsPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as LooseRecord);
  const predictionById = new Map(frozenPredictions.map((entry) => [text(entry.instance_id), entry]));
  let pendingIds = expectedIds.filter((instanceId) => !instanceResults.has(instanceId) && !emptyPatchIds.has(instanceId));

  for (let attempt = nextHarnessAttemptNumber(attemptHistory, discoveredAttemptNumbers); pendingIds.length > 0 && attempt <= options.harnessAttempts; attempt += 1) {
    const attemptRoot = path.join(harnessRoot, "attempts", `attempt-${String(attempt).padStart(3, "0")}`);
    await mkdir(attemptRoot, { recursive: true });
    const attemptRunId = `${runId}-attempt-${String(attempt).padStart(3, "0")}`;
    const attemptPredictions = pendingIds.map((instanceId) => {
      const prediction = predictionById.get(instanceId);
      if (!prediction) throw new Error(`frozen prediction missing for ${lane}/${instanceId}`);
      return prediction;
    });
    const attemptPredictionsPath = path.join(attemptRoot, "predictions.jsonl");
    const attemptPredictionsText = attemptPredictions.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(attemptPredictionsPath, attemptPredictionsText, "utf8");
    const args = [
      "-m", "swebench.harness.run_evaluation",
      "--dataset_name", DATASET,
      "--split", SPLIT,
      "--predictions_path", attemptPredictionsPath,
      "--max_workers", String(Math.min(options.maxHarnessWorkers, pendingIds.length)),
      "--timeout", String(options.harnessTimeoutSeconds),
      "--cache_level", "env",
      "--clean", "False",
      "--run_id", attemptRunId,
      "--report_dir", path.join(attemptRoot, "reports"),
      "--instance_ids", ...pendingIds,
    ];
    console.log(`  official harness ${lane} attempt ${attempt}/${options.harnessAttempts}: ${pendingIds.length} instance(s)`);
    const command = await runCommand({
      command: harnessPython,
      args,
      cwd: attemptRoot,
      env: buildHarnessEnvironment(),
      timeoutMs: Math.max(options.timeoutMs, options.harnessTimeoutSeconds * 1000 * Math.ceil(pendingIds.length / options.maxHarnessWorkers) + 600_000),
    });
    await writeFile(path.join(attemptRoot, "command.full.txt"), [harnessPython, ...args].map(shellQuote).join(" ") + "\n", "utf8");
    await writeJsonAtomic(path.join(attemptRoot, "command.json"), {
      command: harnessPython,
      args,
      cwd: attemptRoot,
      frozenPredictionsPath: predictionsPath,
      frozenPredictionsSha256: predictionsSha256,
      attemptPredictionsPath,
      attemptPredictionsSha256: sha256(attemptPredictionsText),
      requestedIds: pendingIds,
    });
    await writeFile(path.join(attemptRoot, "stdout.log"), command.stdout, "utf8");
    await writeFile(path.join(attemptRoot, "stderr.log"), command.stderr, "utf8");
    await writeJsonAtomic(path.join(attemptRoot, "result.json"), { lane, runId: attemptRunId, command, completedAt: now() });

    const aggregatePath = path.join(attemptRoot, `${lane}.${attemptRunId}.json`);
    const aggregate: LooseRecord = await readJson<LooseRecord>(aggregatePath).catch(() => ({}));
    const reports: Record<string, unknown> = {};
    const reportPaths: Record<string, string> = {};
    for (const instanceId of pendingIds) {
      const reportPath = path.join(attemptRoot, "logs", "run_evaluation", attemptRunId, lane, instanceId, "report.json");
      reportPaths[instanceId] = reportPath;
      reports[instanceId] = await readJson<LooseRecord>(reportPath).catch(() => null);
      const parsed = parseHarnessInstanceReport(reports[instanceId], instanceId);
      if (parsed.ok) {
        instanceResults.set(instanceId, {
          ...parsed.result,
          reportPath,
          attempt,
        });
      }
    }
    for (const instanceId of Array.isArray(aggregate.empty_patch_ids) ? aggregate.empty_patch_ids.map(String) : []) {
      if (expectedIdSet.has(instanceId)) emptyPatchIds.add(instanceId);
    }
    const retryIds = selectHarnessRetryIds({ requestedIds: pendingIds, aggregate, reports });
    const attemptSummary = {
      attempt,
      runId: attemptRunId,
      requestedIds: [...pendingIds],
      completedIds: pendingIds.filter((instanceId) => instanceResults.has(instanceId)),
      resolvedIds: pendingIds.filter((instanceId) => instanceResults.get(instanceId)?.resolved === true),
      unresolvedIds: pendingIds.filter((instanceId) => instanceResults.get(instanceId)?.resolved === false),
      emptyPatchIds: pendingIds.filter((instanceId) => emptyPatchIds.has(instanceId)),
      retryIds,
      commandCode: command.code,
      timedOut: command.timedOut,
      aggregatePath: await exists(aggregatePath) ? aggregatePath : null,
      reportPaths,
    };
    attemptHistory.push(attemptSummary);
    await writeJsonAtomic(path.join(attemptRoot, "attempt-summary.json"), attemptSummary);
    pendingIds = expectedIds.filter((instanceId) => !instanceResults.has(instanceId) && !emptyPatchIds.has(instanceId));
    if (pendingIds.length > 0 && attempt < options.harnessAttempts) {
      const backoffMs = options.harnessRetryBackoffMs * attempt;
      console.log(`  official harness infrastructure retry ${attempt + 1}/${options.harnessAttempts} after ${backoffMs}ms: ${pendingIds.join(", ")}`);
      if (backoffMs > 0) await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  const resolvedIds = expectedIds.filter((instanceId) => instanceResults.get(instanceId)?.resolved === true);
  const unresolvedIds = expectedIds.filter((instanceId) => instanceResults.get(instanceId)?.resolved === false);
  const finalEmptyPatchIds = expectedIds.filter((instanceId) => emptyPatchIds.has(instanceId));
  const errorIds = expectedIds.filter((instanceId) => !instanceResults.has(instanceId) && !emptyPatchIds.has(instanceId));
  const finalInstanceResults = expectedIds.map((instanceId) => instanceResults.get(instanceId)).filter((entry): entry is HarnessInstanceResult => Boolean(entry));
  const officialReport = {
    total_instances: expectedIds.length,
    submitted_instances: expectedIds.length,
    completed_instances: finalInstanceResults.length,
    resolved_instances: resolvedIds.length,
    unresolved_instances: unresolvedIds.length,
    empty_patch_instances: finalEmptyPatchIds.length,
    error_instances: errorIds.length,
    completed_ids: [...resolvedIds, ...unresolvedIds].sort(),
    incomplete_ids: [],
    empty_patch_ids: finalEmptyPatchIds,
    submitted_ids: expectedIds,
    resolved_ids: resolvedIds,
    unresolved_ids: unresolvedIds,
    error_ids: errorIds,
    schema_version: 3,
    merged_from_attempts: attemptHistory.map((attempt) => recordValue(attempt).runId).filter(Boolean),
  };
  const aggregatePath = path.join(harnessRoot, "official-merged-report.json");
  await writeJsonAtomic(aggregatePath, officialReport);
  await writeJsonAtomic(path.join(harnessRoot, "official-report.json"), officialReport);
  const testMetrics = summarizeHarnessTestMetrics(finalInstanceResults);
  const summary = {
    lane,
    runId,
    scoredAt: now(),
    predictionsPath,
    predictionsSha256,
    totalInstances: expectedIds.length,
    submittedInstances: expectedIds.length,
    completedInstances: finalInstanceResults.length,
    resolvedInstances: resolvedIds.length,
    unresolvedInstances: unresolvedIds.length,
    implementationFailureInstances: unresolvedIds.length,
    emptyPatchInstances: finalEmptyPatchIds.length,
    errorInstances: errorIds.length,
    evaluationInfrastructureErrorInstances: errorIds.length,
    resolvedIds,
    unresolvedIds,
    emptyPatchIds: finalEmptyPatchIds,
    errorIds,
    instanceResults: finalInstanceResults,
    testMetrics,
    attempts: attemptHistory,
    attemptsExhausted: errorIds.length > 0
      && Math.max(0, ...attemptHistory.map((entry) => Number(recordValue(entry).attempt) || 0)) >= options.harnessAttempts,
    aggregatePath,
  };
  await writeJsonAtomic(summaryPath, summary);
  return summary;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseOptions(process.argv);
  await mkdir(options.runRoot, { recursive: true });
  await assertRunNotInvalidated(options.runRoot);
  const executionContract = await freezeExecutionContract(options);
  const frozenDistRoot = path.join(options.runRoot, "runtime-dist");
  if (!(await exists(frozenDistRoot))) await cp(DIST_ROOT, frozenDistRoot, { recursive: true, force: false });
  const sourceFiles = (await runRequired("git", [
    "ls-files", "--cached", "--others", "--exclude-standard", "--",
    "core", "server", "runtime", "shared", "scripts", "cli", "package.json", "tsconfig.node.json",
  ], REPO_ROOT, 120_000)).stdout.split(/\r?\n/).filter(Boolean).sort();
  const sourceTreeHash = createHash("sha256");
  for (const file of sourceFiles) {
    sourceTreeHash.update(file).update("\0");
    sourceTreeHash.update(await readFile(path.join(REPO_ROOT, file))).update("\0");
  }
  const currentSourceSnapshot = {
    generatedAt: now(),
    repoRoot: REPO_ROOT,
    head: (await runRequired("git", ["rev-parse", "HEAD"], REPO_ROOT, 30_000)).stdout.trim(),
    diffSha256: sha256((await runRequired("git", ["diff", "--binary", "HEAD"], REPO_ROOT, 120_000)).stdout),
    sourceTreeSha256: sourceTreeHash.digest("hex"),
    sourceFileCount: sourceFiles.length,
    frozenDistRoot,
  };
  const sourceSnapshotPath = path.join(options.runRoot, "source-snapshot.json");
  let sourceSnapshot = currentSourceSnapshot;
  if (await exists(sourceSnapshotPath)) {
    sourceSnapshot = await readJson<typeof currentSourceSnapshot>(sourceSnapshotPath);
    if (options.execute && sourceSnapshot.sourceTreeSha256 !== currentSourceSnapshot.sourceTreeSha256) {
      throw new Error(
        `solver source changed after run freeze (${sourceSnapshot.sourceTreeSha256} != ${currentSourceSnapshot.sourceTreeSha256}); resume with the frozen runtime or use --score-only`,
      );
    }
  } else {
    await writeJsonAtomic(sourceSnapshotPath, sourceSnapshot);
  }
  const frozen = await freezeManifests(options);
  const solverTasks = (Array.isArray(frozen.solver.tasks) ? frozen.solver.tasks : []) as SolverTask[];
  const evaluatorTasks = (Array.isArray(frozen.evaluator.tasks) ? frozen.evaluator.tasks : []) as EvaluatorTask[];
  if (options.execute) {
    if (options.lanes.some((lane) => lane === "native_claude_glm" || lane === "cpb_high_assurance")) {
      await verifyClaudeRuntimeBoundary(options, frozenDistRoot);
    }
    await executeAll(solverTasks, evaluatorTasks, options);
  }
  if (options.execute && options.lanes.length < LANES.length) {
    console.log(`Selected lane execution complete (${options.lanes.join(",")}): ${options.runRoot}`);
    return;
  }
  const results = await allLaneResults(solverTasks, options);
  const freezeSummary = summarizeCandidateFreeze(results);
  await writeJsonAtomic(path.join(options.runRoot, "candidate-freeze.json"), {
    schemaVersion: 1,
    frozenAt: now(),
    solverManifestSha256: frozen.solver.manifestSha256,
    sourceSnapshot,
    executionContractSha256: executionContract.contractSha256,
    ...freezeSummary,
    candidates: results.map((result) => ({
      lane: result.lane,
      opaqueId: result.opaqueId,
      patchPath: runRelativePath(options.runRoot, result.patchPath),
      patchSha256: result.patchSha256,
      patchBytes: result.patchBytes,
    })),
  });
  if (!freezeSummary.complete) {
    throw new Error(`${freezeSummary.blocked.length + freezeSummary.missingArtifacts.length} candidates cannot be trusted for official scoring`);
  }
  const predictions = await writePredictions(solverTasks, evaluatorTasks, results, options);
  if (options.score) {
    // Evaluation starts only after all three candidate sets and hashes are frozen.
    const scores = [];
    for (const lane of options.lanes) {
      const predictionsPath = predictions[lane];
      if (!predictionsPath) throw new Error(`predictions were not frozen for selected lane: ${lane}`);
      scores.push(await runHarness(lane, predictionsPath, evaluatorTasks, options));
    }
    await writeJsonAtomic(path.join(options.runRoot, "official-score-comparison.json"), {
      schemaVersion: 1,
      runId: options.runId,
      solverManifestSha256: frozen.solver.manifestSha256,
      executionContractSha256: executionContract.contractSha256,
      scoredAt: now(),
      solverOutcomeSummary: freezeSummary.solverOutcomeSummary,
      solverHarnessCorrelation: correlateSolverAndHarnessOutcomes(results, evaluatorTasks, scores),
      scores,
    });
  }
  console.log(`Three-way SWE-bench run complete: ${options.runRoot}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
