#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getDescriptor, hasAgent, loadRegistry, resolveAgentCommand } from "../core/agents/registry.js";
import {
  captureProcessIdentity,
  captureSpawnProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  runCommandTree,
  type KillTreeOptions,
  type ProcessIdentity,
} from "../core/runtime/process-tree.js";
import { createTemporaryWorkspace } from "../core/runtime/temporary-workspace.js";
import { compensateProjectRegistration, loadRegistry as loadHubRegistry, mutateRegistry, registerProject, registerProjectWithReceipt } from "../server/services/hub/hub-registry.js";
import { AcpPool, envForAgent, providerKeyForAgent } from "../server/services/acp/acp-pool.js";
import {
  isDelegateAlive,
  waitForDelegateIncarnation,
  type QuotaDelegateLockReceipt,
} from "../server/services/quota-delegate-client.js";
import { getProviderAdapter } from "../server/services/provider-adapters.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";
import { AssignmentStore, type AssignmentAttempt, type AssignmentRecord } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import {
  buildTask,
  DEFAULT_PRODUCT_VALIDATION_AGENTS,
  deriveSweBenchDiagnosticCommands,
  deriveSweBenchVerificationCommands,
  resolveProductValidationAgents,
  type ProductValidationAgents,
  type ProductValidationPlanMode,
} from "./run-swebench-product-validation.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ROOT = path.resolve(import.meta.dirname, "..");
const DATASET = "SWE-bench/SWE-bench_Verified";
const DATASET_CONFIG = "default";
const DATASET_SPLIT = "test";
const DATASET_ROWS_BASE = "https://datasets-server.huggingface.co/rows";
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_LIVE_PROVIDER_PREFLIGHT_TIMEOUT_MS = 120_000;
const LIVE_PROVIDER_PREFLIGHT_SENTINEL = "CPB_PROVIDER_PREFLIGHT_OK";
const PROVIDER_PREFLIGHT_GENERATOR = "scripts/queue-swebench-batch.ts#runSweBenchProviderPreflight";
const LIVE_HANDSHAKE_GENERATOR = "scripts/queue-swebench-batch.ts#liveProviderPreflightHandshake";
const CONTROL_PLANE_AUDIT_GENERATOR = "scripts/queue-swebench-batch.ts#controlPlaneAuditArtifact";
const CODEGRAPH_CLEANUP_PROOF_GENERATOR = "runtime/worker/managed-worker.ts#stopAssignmentCodeGraphRuntime";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const HARD_CONSTRAINT_FAILURE_KINDS = new Set([
  "web_tool_denied",
  "read_only_mutation_denied",
  "broad_test_command_denied",
  "swebench_execute_no_edit_progress",
  "whole_filesystem_search_denied",
  "tool_budget_exceeded",
]);

function liveProviderPreflightPrompt() {
  return [
    "CPB provider live preflight.",
    `Do not call tools. Do not inspect files. Reply exactly with: ${LIVE_PROVIDER_PREFLIGHT_SENTINEL}`,
  ].join("\n");
}

export type SweBenchBatchRecord = LooseRecord & {
  validationMode: "swe-bench-verified";
  benchmarkDataset: typeof DATASET;
  benchmarkSplit: typeof DATASET_SPLIT;
  benchmarkInstanceId: string;
  representativeRepository: string;
  baseCommit: string;
  datasetRowRef: string;
  problemStatementSha256: string;
  failToPassTests: number;
  passToPassTests: number;
};

type SelectedRow = {
  rowIndex: number;
  row: LooseRecord;
  record: SweBenchBatchRecord;
};

type QueueOptions = {
  count: number;
  offset: number;
  pageSize: number;
  planMode: ProductValidationPlanMode;
  providerPreflightMode: "live" | "structural";
  agents: ProductValidationAgents;
  hubRoot: string;
  cpbRoot: string;
  sourceRoot: string;
  outputPath: string;
  reportPath: string;
  workerCount: number;
  workerPrefix: string;
  timeoutMs: number;
  waitTimeoutMs: number;
  notify: boolean;
  notifyTitle: string;
  skipCodegraph: boolean;
  excludeExisting: boolean;
  excludePaths: string[];
  startWorkers: number;
  wait: boolean;
  dryRun: boolean;
  rebuildReport: boolean;
  hubRootExplicit: boolean;
  scorerRequired: boolean;
  scorerEvidencePath: string | null;
};

type StartedWorker = {
  workerId: string;
  pid: number | null;
  processIdentity: ProcessIdentity | null;
  ownerToken?: string;
};

type SpawnLike = (
  command: string,
  args: string[],
  options: LooseRecord,
) => {
  pid?: number | null;
  unref?: () => void;
  once?: (event: "error" | "close", listener: (...args: unknown[]) => void) => unknown;
};

type WorkerCleanupEvidence = {
  workerCleanupEvents: number;
  forcedKills: number;
  residualProcesses: number;
  residualScanOk: boolean;
  residualScanFailures: string[];
  reasons: string[];
  workerIds: string[];
  pids: number[];
};

type ProviderPreflightPhaseInput = {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command: string;
  args: string[];
  correlationNonce?: string;
  projectId?: string;
  jobId?: string;
  outputPath: string;
  outputBytes?: number;
  outputSha256?: string;
  outputContent?: unknown;
  env: LooseRecord;
  denyRules: string[];
  artifactBaseDir?: string;
  artifactPathRewrite?: { from: string; to: string };
  signal?: AbortSignal;
};

type ProviderPreflightHandshake = (input: ProviderPreflightPhaseInput) => Promise<unknown> | unknown;
type CleanupRemove = typeof rm;

type AssignmentInput = {
  entryId: string;
  projectId: string;
  task: string;
  sourcePath: string;
  workflow: "standard";
  planMode: ProductValidationPlanMode;
  sourceContext: LooseRecord;
  metadata: LooseRecord;
};

export type SweBenchBatchReportValidation = {
  valid: boolean;
  violations: string[];
};

export type SweBenchBatchReport = LooseRecord & {
  schemaVersion: 1;
  generatedAt: string;
  sourceManifest: LooseRecord;
  manifest: LooseRecord;
  summary: LooseRecord;
  jobs: LooseRecord[];
  validation: SweBenchBatchReportValidation;
};

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  return args[index + 1] || null;
}

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function phaseProviderRoute(agents: ProductValidationAgents) {
  return [
    { phase: "plan", role: "planner", agent: agents.planner },
    { phase: "execute", role: "executor", agent: agents.executor },
    { phase: "verify", role: "verifier", agent: agents.verifier },
    { phase: "adversarial_verify", role: "adversarial_verifier", agent: agents.adversarial_verifier },
  ];
}

function positiveInt(value: string | null, fallback: number, flag: string) {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${value}`);
  }
  return parsed;
}

function parsePlanMode(value: string | null): ProductValidationPlanMode {
  if (value === null || value === "full") return "full";
  if (value === "light") return "light";
  throw new Error(`--plan-mode must be "full" or "light", got ${value}`);
}

function parseProviderPreflightMode(value: string | null): "live" | "structural" | null {
  if (value === null || value.length === 0) return null;
  if (value === "live" || value === "structural") return value;
  throw new Error(`--provider-preflight must be "live" or "structural", got ${value}`);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalStringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function envFirst(env: LooseRecord, keys: string[]) {
  for (const key of keys) {
    if (typeof env[key] === "string" && String(env[key]).length > 0) return key;
  }
  return null;
}

function stringEnvRecord(env: LooseRecord): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

function batchAbortError(
  message = "SWE-bench batch queue aborted",
  exitCode?: number,
  reason?: unknown,
) {
  const reasonCode = reason instanceof Error && "code" in reason
    ? (reason as Error & { code?: unknown }).code
    : undefined;
  return Object.assign(new Error(message), {
    name: "AbortError",
    code: typeof reasonCode === "string" && reasonCode ? reasonCode : "ABORT_ERR",
    ...(reason !== undefined ? { cause: reason, reason } : {}),
    ...(exitCode ? { exitCode } : {}),
  });
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal | undefined, message?: string) {
  if (!signal?.aborted) return;
  throw abortErrorForSignal(signal, message);
}

function abortErrorForSignal(signal: AbortSignal, message?: string) {
  const reason = signal.reason;
  if (isAbortError(reason)) return reason;
  return batchAbortError(
    message || (reason instanceof Error ? reason.message : reason ? String(reason) : undefined),
    undefined,
    reason,
  );
}

function abortExitCode(error: unknown) {
  const exitCode = Number(recordValue(error).exitCode);
  return Number.isInteger(exitCode) && exitCode > 0 ? exitCode : null;
}

async function runCleanupSteps(
  originalError: unknown,
  steps: Array<{ label: string; run: () => Promise<unknown> }>,
) {
  const cleanupErrors = await collectCleanupErrors(steps);
  if (cleanupErrors.length === 0) return;
  const aggregate = new AggregateError(
    [originalError, ...cleanupErrors],
    "cleanup failed after original operation error",
  );
  (aggregate as AggregateError & { cause?: unknown }).cause = originalError;
  throw aggregate;
}

async function collectCleanupErrors(
  steps: Array<{ label: string; run: () => Promise<unknown> }>,
) {
  const settled = await Promise.allSettled(
    steps.map((step) => Promise.resolve().then(step.run)),
  );
  return settled.flatMap((result, index) => result.status === "rejected"
    ? [Object.assign(result.reason instanceof Error ? result.reason : new Error(String(result.reason)), {
        cleanupLabel: steps[index]?.label,
      })]
    : []);
}

async function runRequiredCleanupSteps(
  steps: Array<{ label: string; run: () => Promise<unknown> }>,
) {
  const cleanupErrors = await collectCleanupErrors(steps);
  if (cleanupErrors.length === 0) return;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  const aggregate = new AggregateError(cleanupErrors, "cleanup failed after operation completed");
  (aggregate as AggregateError & { cause?: unknown }).cause = cleanupErrors[0];
  throw aggregate;
}

function errorContains(value: unknown, target: unknown, seen = new Set<unknown>()): boolean {
  if (value === target) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof AggregateError && value.errors.some((error) => errorContains(error, target, seen))) {
    return true;
  }
  const record = value as { cause?: unknown; reason?: unknown };
  return errorContains(record.cause, target, seen) || errorContains(record.reason, target, seen);
}

function combineAbortAndOperationError(signal: AbortSignal, operationError: unknown) {
  if (isAbortError(operationError) || errorContains(operationError, signal.reason)) return operationError;
  const abortError = abortErrorForSignal(signal);
  const aggregate = new AggregateError(
    [abortError, operationError],
    "SWE-bench batch queue aborted while another operation also failed",
  );
  (aggregate as AggregateError & { cause?: unknown }).cause = abortError;
  return aggregate;
}

function requiredProviderEnvGroups(providerKey: string) {
  if (providerKey === "claude:glm") {
    return [
      { label: "baseUrl", keys: ["ZHIPU_BASE_URL", "GLM_BASE_URL"] },
      { label: "apiKey", keys: ["ZHIPU_API_KEY", "ZHIPU_AUTH_TOKEN", "GLM_API_KEY", "GLM_AUTH_TOKEN"] },
      { label: "model", keys: ["ZHIPU_MODEL", "GLM_MODEL"] },
    ];
  }
  if (providerKey === "claude:mimo-v2.5pro") {
    return [
      { label: "baseUrl", keys: ["XIAOMI_BASE_URL", "MIMO_BASE_URL"] },
      { label: "apiKey", keys: ["XIAOMI_API_KEY", "XIAOMI_AUTH_TOKEN", "MIMO_API_KEY", "MIMO_AUTH_TOKEN"] },
    ];
  }
  return [];
}

function presentProviderEnvKeys(providerKey: string, env: LooseRecord) {
  return requiredProviderEnvGroups(providerKey)
    .map((group) => envFirst(env, group.keys))
    .filter((key): key is string => Boolean(key));
}

function stringArrayFromJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [value];
  }
}

function safeId(value: string) {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "sample";
}

async function pathExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function buildDatasetRowsUrl({ offset, length }: { offset: number; length: number }) {
  const params = new URLSearchParams({
    dataset: DATASET,
    config: DATASET_CONFIG,
    split: DATASET_SPLIT,
    offset: String(offset),
    length: String(length),
  });
  return `${DATASET_ROWS_BASE}?${params.toString()}`;
}

export function recordFromDatasetRow(row: LooseRecord, rowIndex: number): SweBenchBatchRecord {
  const benchmarkInstanceId = stringValue(row.instance_id || row.instanceId);
  const representativeRepository = stringValue(row.repo || row.repository);
  const baseCommit = stringValue(row.base_commit || row.baseCommit);
  const problemStatement = stringValue(row.problem_statement || row.problemStatement);
  if (!benchmarkInstanceId) throw new Error(`dataset row ${rowIndex} is missing instance_id`);
  if (!representativeRepository) throw new Error(`dataset row ${rowIndex} is missing repo`);
  if (!baseCommit) throw new Error(`dataset row ${rowIndex} is missing base_commit`);
  if (!problemStatement) throw new Error(`dataset row ${rowIndex} is missing problem_statement`);

  return {
    validationMode: "swe-bench-verified",
    benchmarkDataset: DATASET,
    benchmarkSplit: DATASET_SPLIT,
    benchmarkInstanceId,
    representativeRepository,
    baseCommit,
    datasetRowRef: buildDatasetRowsUrl({ offset: rowIndex, length: 1 }),
    problemStatementSha256: createHash("sha256").update(problemStatement).digest("hex"),
    failToPassTests: stringArrayFromJson(row.FAIL_TO_PASS).length,
    passToPassTests: stringArrayFromJson(row.PASS_TO_PASS).length,
  };
}

function normalizedHandshakeFailureKind(value: unknown) {
  const failureKind = stringValue(value);
  return failureKind === "agent_rate_limited"
    || failureKind === "agent_unavailable"
    || failureKind === "provider_unavailable"
    ? failureKind
    : null;
}

const PROVIDER_HANDSHAKE_EVIDENCE_FIELDS = new Set([
  "ok",
  "mode",
  "generator",
  "sentinelVerified",
  "phase",
  "role",
  "agent",
  "providerKey",
  "transport",
  "command",
  "projectId",
  "jobId",
  "correlationNonce",
  "controlPlaneEvidence",
  "controlPlaneEvidenceSha256",
  "controlPlaneAudit",
  "failureKind",
  "error",
]);

function hasUnexpectedProviderHandshakeEvidence(handshake: LooseRecord) {
  return Object.keys(handshake).some((field) => !PROVIDER_HANDSHAKE_EVIDENCE_FIELDS.has(field));
}

const REQUIRED_ACP_PREFLIGHT_DENY_TOOLS = [
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/kill",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
];

const REQUIRED_CLAUDE_PREFLIGHT_DENY_TOOLS = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
  "Read",
  "WebFetch",
  "WebSearch",
  "Write",
];

function sortedStringValues(value: unknown) {
  return arrayValue(value).map(String).sort();
}

function controlPlaneEvidenceValid(evidence: unknown, expected: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
}) {
  const proof = recordValue(evidence);
  if (proof.transport !== expected.transport) return false;
  if (proof.phase !== expected.phase || proof.role !== expected.role || proof.agent !== expected.agent || proof.providerKey !== expected.providerKey) return false;
  if (proof.agentLaunchObserved !== true || proof.sessionObserved !== true || proof.policyVerified !== true) return false;
  if (Number(proof.toolCallCount) !== 0 || Number(proof.terminalLaunchCount) !== 0) return false;
  const policy = recordValue(proof.policySummary);
  if (policy.terminalPolicy !== "deny" || policy.permissionRequests !== "reject" || policy.webToolsDisabled !== true) return false;
  if (expected.transport === "acp") {
    const toolPolicy = recordValue(policy.toolPolicy);
    const allow = sortedStringValues(toolPolicy.allow);
    const deny = sortedStringValues(toolPolicy.deny);
    return allow.length === 0
      && REQUIRED_ACP_PREFLIGHT_DENY_TOOLS.every((tool) => deny.includes(tool));
  }
  const tools = sortedStringValues(policy.tools);
  const mcpServers = sortedStringValues(policy.mcpServers);
  const deny = sortedStringValues(recordValue(recordValue(policy.settings).permissions).deny);
  return tools.length === 0
    && mcpServers.length === 0
    && policy.slashCommandsDisabled === true
    && REQUIRED_CLAUDE_PREFLIGHT_DENY_TOOLS.every((tool) => deny.includes(tool));
}

function providerHandshakeControlPlaneVerified(handshake: LooseRecord, expected: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command?: string;
  projectId?: string;
  jobId?: string;
  correlationNonce?: string;
  outputPath: string;
  outputBytes?: number;
  outputSha256?: string;
  outputContent?: unknown;
  artifactBaseDir?: string;
  artifactPathRewrite?: { from: string; to: string };
}) {
  return typeof handshake.controlPlaneEvidenceSha256 === "string"
    && handshake.controlPlaneEvidenceSha256 === stableJsonSha256(handshake.controlPlaneEvidence)
    && controlPlaneEvidenceValid(handshake.controlPlaneEvidence, expected)
    && controlPlaneAuditReferenceValid(handshake.controlPlaneAudit, handshake.controlPlaneEvidence, expected).valid;
}

function providerHandshakeEvidence({
  value,
  phase,
  role,
  agent,
  providerKey,
  transport,
  command,
}: {
  value: unknown;
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command: string;
}) {
  const result = recordValue(value);
  const mode = result.mode === "live" || result.mode === "structural" ? result.mode : null;
  const generator = result.generator === LIVE_HANDSHAKE_GENERATOR ? result.generator : null;
  const failureKind = normalizedHandshakeFailureKind(result.failureKind);
  const detail = stringValue(result.error || result.reason || result.stderr);
  return {
    ok: result.ok === true,
    ...(mode ? { mode } : {}),
    ...(generator ? { generator } : {}),
    ...(typeof result.sentinelVerified === "boolean" ? { sentinelVerified: result.sentinelVerified } : {}),
    phase,
    role,
    agent,
    providerKey,
    transport,
    command,
    ...(typeof result.projectId === "string" ? { projectId: result.projectId } : {}),
    ...(typeof result.jobId === "string" ? { jobId: result.jobId } : {}),
    ...(typeof result.correlationNonce === "string" ? { correlationNonce: result.correlationNonce } : {}),
    ...(isRecord(result.controlPlaneEvidence) ? { controlPlaneEvidence: result.controlPlaneEvidence } : {}),
    ...(typeof result.controlPlaneEvidenceSha256 === "string" ? { controlPlaneEvidenceSha256: result.controlPlaneEvidenceSha256 } : {}),
    ...(isRecord(result.controlPlaneAudit) ? { controlPlaneAudit: result.controlPlaneAudit } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(detail ? { error: sanitizeLivePreflightReason(detail) } : {}),
  };
}

function abortedProviderPreflight(generatedAt: string, reason: unknown) {
  const safeReason = sanitizeLivePreflightReason(reason instanceof Error ? reason.message : String(reason || "provider preflight aborted"));
  return {
    schemaVersion: 1,
    generator: PROVIDER_PREFLIGHT_GENERATOR,
    generatedAt,
    ok: false,
    failureKind: "provider_unavailable",
    phases: [],
    providers: [],
    violations: [`provider preflight aborted: ${safeReason}`],
  };
}

export async function runSweBenchProviderPreflight({
  agents,
  env = process.env,
  handshake = null,
  generatedAt = new Date().toISOString(),
  artifactRoot = path.join(os.tmpdir(), `cpb-swebench-provider-preflight-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`),
  signal,
}: {
  agents: ProductValidationAgents;
  env?: LooseRecord;
  handshake?: ProviderPreflightHandshake | null;
  generatedAt?: string;
  artifactRoot?: string;
  signal?: AbortSignal;
}) {
  if (signal?.aborted) return abortedProviderPreflight(generatedAt, signal.reason);
  await loadRegistry("");
  if (signal?.aborted) return abortedProviderPreflight(generatedAt, signal.reason);
  const resolvedArtifactRoot = path.resolve(artifactRoot);
  await mkdir(resolvedArtifactRoot, { recursive: true });
  const artifactRootStat = lstatSync(resolvedArtifactRoot);
  if (artifactRootStat.isSymbolicLink() || !artifactRootStat.isDirectory()) {
    throw new Error("provider preflight artifactRoot must be a non-symlink directory");
  }
  const artifactRootReal = realpathSync(resolvedArtifactRoot);
  const envRecord = stringEnvRecord(env);
  const denyRules = [
    "web_tool_denied",
    "read_only_mutation_denied",
    "broad_test_command_denied",
  ];
  const phases: LooseRecord[] = [];
  const violations: string[] = [];
  const failureKinds: string[] = [];

  for (const route of phaseProviderRoute(agents)) {
    if (signal?.aborted) {
      const safeReason = sanitizeLivePreflightReason(signal.reason instanceof Error ? signal.reason.message : String(signal.reason || "provider preflight aborted"));
      violations.push(`provider preflight aborted before ${route.role} provider handshake: ${safeReason}`);
      failureKinds.push("provider_unavailable");
      break;
    }
    const providerKey = providerKeyForAgent(route.agent, envRecord);
    const phaseViolations: string[] = [];
    const registered = hasAgent(route.agent);
    const descriptor = registered ? getDescriptor(route.agent) : null;
    const transport = descriptor?.transport === "claude-cli" ? "claude-cli" : "acp";
    const commandInfo = registered ? recordValue(resolveAgentCommand(route.agent)) : {};
    const command = transport === "claude-cli"
      ? stringValue(envRecord.CPB_CLAUDE_CLI_COMMAND, "claude")
      : stringValue(commandInfo.command);
    const args = transport === "claude-cli" ? [] : arrayValue(commandInfo.args).map(String);
    const correlationNonce = randomBytes(16).toString("hex");
    const projectId = "cpb-provider-live-preflight";
    const jobId = `provider-preflight-${safeId(route.role)}-${safeId(route.agent)}-${correlationNonce}`;
    const outputPath = path.join(
      artifactRootReal,
      `${safeId(route.phase)}-${safeId(route.agent)}-${correlationNonce}.json`,
    );
    let resolvedEnv: LooseRecord = {};
    let handshakeResult: LooseRecord = {};
    let handshakeOk = false;
    let outputBytes = 0;
    let outputSha256 = "";

    if (!registered) {
      phaseViolations.push(`${route.role} agent is not registered: ${route.agent}`);
    }
    if (registered && !command) {
      phaseViolations.push(`${route.role} agent has no launch command: ${route.agent}`);
    }
    for (const group of requiredProviderEnvGroups(providerKey)) {
      if (!envFirst(env, group.keys)) {
        phaseViolations.push(`${route.role} provider ${providerKey} is missing ${group.label} env (${group.keys.join("|")})`);
      }
    }
    if (registered) {
      try {
        resolvedEnv = envForAgent(route.agent, envRecord);
      } catch (error) {
        const reason = sanitizeLivePreflightReason(error instanceof Error ? error.message : String(error));
        phaseViolations.push(`${route.role} provider env invalid for ${route.agent}/${providerKey}: ${reason}`);
      }
    }

    if (phaseViolations.length === 0) {
      if (handshake) {
        try {
          const rawHandshakeResult = recordValue(await handshake({
            phase: route.phase,
            role: route.role,
            agent: route.agent,
            providerKey,
            transport,
            command,
            args,
            correlationNonce,
            projectId,
            jobId,
            outputPath,
            artifactBaseDir: artifactRootReal,
            env: resolvedEnv,
            denyRules,
            signal,
          }));
          throwIfAborted(signal, `${route.role} provider ${providerKey} handshake aborted`);
          handshakeResult = providerHandshakeEvidence({
            value: rawHandshakeResult,
            phase: route.phase,
            role: route.role,
            agent: route.agent,
            providerKey,
            transport,
            command,
          });
          try {
            const outputFile = readContainedRegularArtifact(outputPath, {
              outputPath,
              artifactBaseDir: artifactRootReal,
            }, "provider preflight output artifact");
            const outputValue = JSON.parse(outputFile.raw.toString("utf8")) as unknown;
            if (!stableJsonEqual(outputValue, handshakeResult)) {
              phaseViolations.push(`${route.role} provider ${providerKey} output artifact does not match retained handshake`);
            } else {
              outputBytes = outputFile.raw.byteLength;
              outputSha256 = createHash("sha256").update(outputFile.raw).digest("hex");
            }
          } catch {
            phaseViolations.push(`${route.role} provider ${providerKey} output artifact is missing, unsafe, or invalid`);
          }
          handshakeOk = handshakeResult.ok === true
            && outputBytes > 0
            && providerHandshakeControlPlaneVerified(handshakeResult, {
              phase: route.phase,
              role: route.role,
              agent: route.agent,
              providerKey,
              transport,
              command,
              projectId,
              jobId,
              correlationNonce,
              outputPath,
              outputBytes,
              outputSha256,
              outputContent: handshakeResult,
              artifactBaseDir: artifactRootReal,
            });
          if (!handshakeOk) {
            const detail = stringValue(handshakeResult.error);
            phaseViolations.push(`${route.role} provider ${providerKey} failed structured handshake${detail ? `: ${detail}` : ""}`);
            const failureKind = stringValue(handshakeResult.failureKind);
            if (failureKind) failureKinds.push(failureKind);
          }
        } catch (error) {
          const rawReason = error instanceof Error ? error.message : String(error);
          const safeReason = sanitizeLivePreflightReason(rawReason);
          handshakeResult = {
            ok: false,
            mode: "live",
            generator: LIVE_HANDSHAKE_GENERATOR,
            sentinelVerified: false,
            error: safeReason,
          };
          phaseViolations.push(`${route.role} provider ${providerKey} handshake ${isAbortError(error) ? "aborted" : "failed"}: ${safeReason}`);
          failureKinds.push(livePreflightFailureKind(rawReason));
          if (isAbortError(error) || signal?.aborted) {
            failureKinds.push("provider_unavailable");
            violations.push(...phaseViolations);
            phases.push({
              phase: route.phase,
              role: route.role,
              agent: route.agent,
              providerKey,
              transport,
              registered,
              command: command || null,
              commandSource: optionalStringValue(commandInfo.source),
              argCount: args.length,
              envKeysPresent: presentProviderEnvKeys(providerKey, env),
              activeVariant: optionalStringValue(resolvedEnv.CPB_ACTIVE_CLAUDE_VARIANT),
              model: optionalStringValue(resolvedEnv.ANTHROPIC_MODEL),
              adapter: {
                timezone: optionalStringValue(recordValue(getProviderAdapter(providerKey)).timezone),
                quotaPolicy: recordValue(recordValue(getProviderAdapter(providerKey)).quotaPolicy),
              },
              outputPath,
              denyRules,
              handshakeOk: false,
              handshake: handshakeResult,
              violations: phaseViolations,
            });
            break;
          }
        }
      } else {
        handshakeOk = true;
        handshakeResult = { ok: true, mode: "structural" };
      }
    }

    violations.push(...phaseViolations);
    const adapter = recordValue(getProviderAdapter(providerKey));
    phases.push({
      phase: route.phase,
      role: route.role,
      agent: route.agent,
      providerKey,
      transport,
      registered,
      command: command || null,
      commandSource: optionalStringValue(commandInfo.source),
      argCount: args.length,
      envKeysPresent: presentProviderEnvKeys(providerKey, env),
      activeVariant: optionalStringValue(resolvedEnv.CPB_ACTIVE_CLAUDE_VARIANT),
      model: optionalStringValue(resolvedEnv.ANTHROPIC_MODEL),
      adapter: {
        timezone: optionalStringValue(adapter.timezone),
        quotaPolicy: recordValue(adapter.quotaPolicy),
      },
      outputPath,
      ...(outputBytes > 0 ? { outputBytes, outputSha256 } : {}),
      denyRules,
      handshakeOk,
      handshake: handshakeResult,
      violations: phaseViolations,
    });
  }

  const providersByKey = new Map<string, LooseRecord>();
  for (const phase of phases) {
    const providerKey = stringValue(phase.providerKey);
    if (!providerKey || providersByKey.has(providerKey)) continue;
    providersByKey.set(providerKey, {
      providerKey,
      phases: phases
        .filter((item) => recordValue(item).providerKey === providerKey)
        .map((item) => recordValue(item).phase),
    });
  }
  const ok = violations.length === 0;
  return {
    schemaVersion: 1,
    generator: PROVIDER_PREFLIGHT_GENERATOR,
    generatedAt,
    ok,
    failureKind: ok ? null : failureKinds[0] || "provider_unavailable",
    phases,
    providers: Array.from(providersByKey.values()),
    violations,
  };
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableJsonSha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJsonBytes(value: unknown) {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function assignmentInstanceId(assignment: unknown) {
  const assignmentRecord = recordValue(assignment);
  const record = recordValue(assignmentRecord.record);
  return stringValue(record.benchmarkInstanceId || record.instanceId);
}

function assignmentIdValue(assignment: unknown) {
  const assignmentRecord = recordValue(assignment);
  const queued = recordValue(assignmentRecord.queued);
  return stringValue(queued.assignmentId || assignmentRecord.assignmentId);
}

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPositiveSafeIntegerValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hardConstraintFailureKindFromText(value: unknown) {
  const text = stringValue(value);
  if (!text) return "";
  if (/tool(?:_event)?_budget_exceeded/i.test(text)) return "tool_budget_exceeded";
  if (/broad_test_command_denied/i.test(text)) return "broad_test_command_denied";
  if (/swebench_execute_no_edit_progress|SWE-bench execute phase exceeded no-edit read\/search limit/i.test(text)) return "swebench_execute_no_edit_progress";
  if (/whole-filesystem find is denied|whole_filesystem_search_denied/i.test(text)) return "whole_filesystem_search_denied";
  if (/read-only phase .*cannot run mutating terminal command|read_only_mutation_denied/i.test(text)) return "read_only_mutation_denied";
  if (/web tool use is disabled|web_tool_denied/i.test(text)) return "web_tool_denied";
  return HARD_CONSTRAINT_FAILURE_KINDS.has(text) ? text : "";
}

function preferredFailureKind(current: unknown, candidate: unknown) {
  const currentKind = stringValue(current);
  const candidateKind = stringValue(candidate);
  if (!candidateKind) return currentKind;
  if (!currentKind) return candidateKind;
  const candidateHardKind = hardConstraintFailureKindFromText(candidateKind);
  const currentHardKind = hardConstraintFailureKindFromText(currentKind);
  if (candidateHardKind && !currentHardKind) return candidateHardKind;
  return currentKind;
}

function setFailureKind(target: LooseRecord, candidate: unknown) {
  const next = preferredFailureKind(target.failureKind, candidate);
  if (next) target.failureKind = next;
}

function assignmentAttemptCount(assignment: unknown, terminalState: unknown = null) {
  const assignmentRecord = recordValue(assignment);
  const queued = recordValue(assignmentRecord.queued);
  const state = recordValue(terminalState);
  return Math.max(
    numericValue(queued.attempt),
    numericValue(assignmentRecord.attempt),
    numericValue(assignmentRecord.attempts),
    numericValue(state.attempt),
    numericValue(state.attempts),
  );
}

function attemptAuthorityViolation(assignment: unknown, terminalState: unknown, job: LooseRecord) {
  const assignmentRecord = recordValue(assignment);
  const queued = recordValue(assignmentRecord.queued);
  const state = recordValue(terminalState);
  const attempts = recordValue(job.attempts);
  const present = [
    queued.attempt,
    assignmentRecord.attempt,
    assignmentRecord.attempts,
    state.attempt,
    state.attempts,
    job.attempt,
    attempts.count,
  ].filter((value) => value !== undefined);
  if (present.length === 0) return "missing authoritative attempt";
  if (present.some((value) => !isPositiveSafeIntegerValue(value))) {
    return "missing authoritative attempt";
  }
  if (new Set(present).size > 1) return "conflicting authoritative attempt";
  return null;
}

function terminalStateMap(states: unknown[]) {
  const byAssignmentId = new Map<string, LooseRecord>();
  for (const state of states) {
    const stateRecord = recordValue(state);
    const assignmentId = stringValue(stateRecord.assignmentId);
    if (assignmentId) byAssignmentId.set(assignmentId, stateRecord);
  }
  return byAssignmentId;
}

function terminalStateCounts(states: unknown[]) {
  const counts: Record<string, number> = {};
  for (const state of states) {
    const status = stringValue(recordValue(state).status);
    if (!status) continue;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function reportJobInstanceId(job: unknown) {
  const jobRecord = recordValue(job);
  return stringValue(jobRecord.benchmarkInstanceId || jobRecord.instanceId);
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function hasPatchEvidence(job: LooseRecord) {
  return hasPatchEvidenceValue(recordValue(job.patch));
}

function hasPatchEvidenceValue(patch: LooseRecord) {
  return Boolean(
    stringValue(patch.path)
      && /^[a-f0-9]{64}$/i.test(stringValue(patch.sha256))
      && positiveNumber(patch.bytes)
      && positiveNumber(patch.changedFileCount),
  );
}

function sourceChangedFilesFromPatch(patch: LooseRecord) {
  return arrayValue(patch.changedFiles)
    .map(String)
    .filter(Boolean)
    .filter((filePath) => !testLikeChangedFile(filePath) && !fixtureLikePath(filePath));
}

function scorerPatchKind(patch: LooseRecord) {
  const changedFiles = arrayValue(patch.changedFiles).map(String).filter(Boolean);
  if (sourceChangedFilesFromPatch(patch).length > 0) return "source_patch";
  if (changedFiles.length > 0 && hasPatchEvidenceValue(patch)) return "test_only_patch";
  if (hasPatchEvidenceValue(patch)) return "patch_without_file_list";
  return "no_patch";
}

function hasSourcePatchEvidence(job: LooseRecord) {
  const patch = recordValue(job.patch);
  const kind = scorerPatchKind(patch);
  return kind === "source_patch" || kind === "patch_without_file_list";
}

function hasRegressionEvidence(job: LooseRecord) {
  const evidence = recordValue(job.regressionEvidence);
  const status = stringValue(evidence.status);
  return new Set(["present", "valid", "justified", "no-test-justified"]).has(status);
}

function hasRequiredScorerEvidence(job: LooseRecord) {
  const scorer = recordValue(job.scorer);
  if (scorer.required !== true) return true;
  return scorer.completed === true && Boolean(stringValue(scorer.logPath));
}

function requiresScorerEvidence(job: LooseRecord) {
  const scorer = recordValue(job.scorer);
  if (scorer.required !== true) return false;
  return job.status === "completed" || hasSourcePatchEvidence(job) || scorer.completed === true;
}

function isPassingExternalOracleEvidence(job: LooseRecord) {
  const scorer = recordValue(job.scorer);
  if (scorer.completed === true && scorer.resolved === true) return true;
  const regressionEvidence = recordValue(job.regressionEvidence);
  const oracle = recordValue(regressionEvidence.externalOracle || regressionEvidence.oracle);
  const status = stringValue(oracle.status);
  return oracle.resolved === true || /^(pass|passed|resolved)$/i.test(status);
}

function testLikeChangedFile(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  return /(^|\/)tests?\//i.test(normalized)
    || /(^|\/)test_[^/]+\.py$/i.test(normalized)
    || /(^|\/)[^/]+\.test\.[cm]?[jt]sx?$/i.test(normalized)
    || /(^|\/)[^/]+\.spec\.[cm]?[jt]sx?$/i.test(normalized);
}

function testPathCommandAliases(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const noExt = normalized.replace(/\.[^.]+$/, "");
  const aliases = new Set<string>([
    normalized,
    noExt,
    noExt.replace(/\//g, "."),
  ]);
  const withoutLeadingTests = noExt.replace(/^tests?\//, "");
  aliases.add(withoutLeadingTests);
  aliases.add(withoutLeadingTests.replace(/\//g, "."));
  if (/\/tests?\//i.test(noExt)) {
    const afterTests = noExt.replace(/^.*\/tests?\//i, "");
    aliases.add(afterTests);
    aliases.add(afterTests.replace(/\//g, "."));
  }
  return Array.from(aliases)
    .map((alias) => alias.toLowerCase())
    .filter((alias) => alias.length >= 4);
}

function changedOracleTestFiles(job: LooseRecord) {
  const changedFiles = arrayValue(recordValue(job.patch).changedFiles)
    .map(String)
    .filter((filePath) => filePath && testLikeChangedFile(filePath));
  const commands = arrayValue(recordValue(job.regressionEvidence).canonicalCommandsRun)
    .map(String)
    .filter(Boolean);
  if (changedFiles.length === 0 || commands.length === 0) return [];
  const commandText = commands.join("\n").toLowerCase();
  return changedFiles.filter((filePath) => {
    const aliases = testPathCommandAliases(filePath);
    return aliases.some((alias) => commandText.includes(alias));
  });
}

function oracleIntegrityEvidence(job: LooseRecord) {
  const pollutedChangedTestFiles = changedOracleTestFiles(job);
  const externalOracleRequired = pollutedChangedTestFiles.length > 0;
  const externalOracleSatisfied = isPassingExternalOracleEvidence(job);
  return {
    externalOracleRequired,
    externalOracleSatisfied,
    pollutedChangedTestFiles,
  };
}

function hasRewrittenOracleTestEvidence(job: LooseRecord) {
  const oracleIntegrity = {
    ...oracleIntegrityEvidence(job),
    ...recordValue(recordValue(job.regressionEvidence).oracleIntegrity),
  };
  const pollutedFiles = arrayValue(oracleIntegrity.pollutedChangedTestFiles);
  if (pollutedFiles.length === 0) return false;
  return oracleIntegrity.externalOracleSatisfied !== true;
}

function fixtureLikePath(filePath: string) {
  return /(^|\/)(__snapshots__|snapshots?|fixtures?|fakes?|mocks?|testdata|golden)(\/|$)/i.test(filePath)
    || /\.(snap|snapshot)$/i.test(filePath);
}

function hasInvalidFixtureOnlyRegression(job: LooseRecord) {
  const changedFiles = arrayValue(recordValue(job.patch).changedFiles)
    .map(String)
    .filter(Boolean);
  if (changedFiles.length === 0 || !changedFiles.every(fixtureLikePath)) return false;
  const evidence = recordValue(job.regressionEvidence);
  return !stringValue(evidence.justification || evidence.noTestJustification || evidence.fixtureJustification);
}

function hasAuditablePhaseArtifact(phase: string, phaseRecord: LooseRecord) {
  const artifactPath = stringValue(phaseRecord.structuredOutputPath);
  if (!artifactPath
    || numericValue(phaseRecord.structuredOutputBytes) <= 0
    || !/^[a-f0-9]{64}$/.test(stringValue(phaseRecord.artifactSha256))) {
    return false;
  }
  return phase !== "prepare_task" || artifactPath.endsWith("#riskmap_generated");
}

function emptyBlockedEvents() {
  return {
    webToolAttempts: 0,
    webToolBlocked: 0,
    readOnlyMutationAttempts: 0,
    readOnlyMutationBlocked: 0,
    broadTestCommandAttempts: 0,
    broadTestCommandBlocked: 0,
  };
}

function blockedEventsValue(value: unknown) {
  return {
    ...emptyBlockedEvents(),
    ...recordValue(value),
  };
}

function emptyCleanupEvidence() {
  return {
    terminalCleanupEvents: 0,
    forcedKills: 0,
    residualProcesses: 0,
    reasons: [],
    terminalIds: [],
  };
}

function cleanupEvidenceValue(value: unknown) {
  return {
    ...emptyCleanupEvidence(),
    ...recordValue(value),
  };
}

const CODEGRAPH_CLEANUP_PROOF_FIELDS = new Set([
  "assignmentId",
  "attempt",
  "attemptToken",
  "cleanupAttempt",
  "cleanupCompletedAt",
  "cleanupStartedAt",
  "cleanupVerified",
  "context",
  "entryId",
  "generator",
  "jobId",
  "ok",
  "orchestratorEpoch",
  "pid",
  "processPid",
  "processTreeStopped",
  "projectId",
  "startup",
  "startupSource",
  "statePath",
  "stateRemoved",
  "workerId",
  "worktreePath",
]);

const CODEGRAPH_CLEANUP_STARTUP_FIELDS = new Set([
  "ok",
  "pid",
  "processPid",
  "readyAt",
  "source",
  "startedAt",
  "statePath",
]);

function unexpectedKeys(value: LooseRecord, allowed: Set<string>) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function isIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function orderedIsoTimestamps(...values: unknown[]) {
  const parsed = values.map((value) => isIsoTimestamp(value) ? Date.parse(String(value)) : NaN);
  return parsed.every(Number.isFinite)
    && parsed.every((value, index) => index === 0 || parsed[index - 1] <= value);
}

function mergeCodeGraphCleanupEvidence(evidence: LooseRecord, proofValue: unknown) {
  if (!isRecord(proofValue)) return;
  evidence.cleanup = {
    ...cleanupEvidenceValue(evidence.cleanup),
    codegraph: recordValue(proofValue),
  };
  const proof = recordValue(proofValue);
  if (stringValue(proof.jobId)) evidence.jobId = stringValue(proof.jobId);
}

function emptyWorkerCleanupEvidence(): WorkerCleanupEvidence {
  return {
    workerCleanupEvents: 0,
    forcedKills: 0,
    residualProcesses: 0,
    residualScanOk: true,
    residualScanFailures: [],
    reasons: [],
    workerIds: [],
    pids: [],
  };
}

function workerCleanupEvidenceValue(value: unknown): WorkerCleanupEvidence {
  const record = recordValue(value);
  const workerCleanupEvents = numericValue(record.workerCleanupEvents);
  const pids = arrayValue(record.pids).map((pid) => Number(pid)).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const scanRequired = workerCleanupEvents > 0 || pids.length > 0;
  return {
    workerCleanupEvents,
    forcedKills: numericValue(record.forcedKills),
    residualProcesses: numericValue(record.residualProcesses),
    residualScanOk: scanRequired ? record.residualScanOk === true : true,
    residualScanFailures: arrayValue(record.residualScanFailures).map(String).filter(Boolean),
    reasons: arrayValue(record.reasons).map(String).filter(Boolean),
    workerIds: arrayValue(record.workerIds).map(String).filter(Boolean),
    pids,
  };
}

function cleanupEventCount(value: unknown) {
  const cleanup = recordValue(value);
  return numericValue(cleanup.terminalCleanupEvents) + numericValue(cleanup.workerCleanupEvents);
}

function phaseEvidenceEntry(evidence: LooseRecord, phase: string) {
  const phaseEvidence = recordValue(evidence.phaseEvidence);
  const current = {
    ok: null,
    durationMs: 0,
    retryCount: 0,
    toolEvents: 0,
    auditUpdateEvents: 0,
    terminalCommands: 0,
    structuredOutputBytes: 0,
    structuredOutputPath: null,
    artifactSha256: null,
    failureKind: "",
    retryFailureKinds: [],
    ...recordValue(phaseEvidence[phase]),
  };
  phaseEvidence[phase] = current;
  evidence.phaseEvidence = phaseEvidence;
  return current;
}

function mergePrepareTaskRiskmapEvidence(evidence: LooseRecord, eventFile: string, event: LooseRecord) {
  const phaseEvidence = phaseEvidenceEntry(evidence, "prepare_task");
  phaseEvidence.ok = true;
  phaseEvidence.structuredOutputPath = `${eventFile}#riskmap_generated`;
  phaseEvidence.structuredOutputBytes = stableJsonBytes(event);
  phaseEvidence.artifactSha256 = stableJsonSha256(event);
}

function normalizeChangedFile(value: unknown) {
  const text = stringValue(value).trim();
  if (!text) return "";
  return text
    .replace(/^[ MADRCU?!]{1,2}\s+/, "")
    .replace(/^.* -> /, "")
    .trim();
}

function normalizedChangedFiles(value: unknown) {
  return arrayValue(value)
    .map(normalizeChangedFile)
    .filter(Boolean);
}

function mergeUniqueStrings(current: unknown, next: unknown[]) {
  return Array.from(new Set([
    ...arrayValue(current).map(String).filter(Boolean),
    ...next.map(String).filter(Boolean),
  ]));
}

function mergePatchEvidence(evidence: LooseRecord, patchUpdate: LooseRecord) {
  const current = recordValue(evidence.patch);
  const changedFiles = mergeUniqueStrings(current.changedFiles, normalizedChangedFiles(patchUpdate.changedFiles));
  evidence.patch = {
    path: stringValue(current.path, stringValue(patchUpdate.path)) || null,
    sha256: stringValue(current.sha256, stringValue(patchUpdate.sha256)) || null,
    bytes: Math.max(numericValue(current.bytes), numericValue(patchUpdate.bytes)),
    changedFiles,
    changedFileCount: changedFiles.length,
    applyStatus: changedFiles.length > 0
      ? stringValue(current.applyStatus, stringValue(patchUpdate.applyStatus, "not_checked"))
      : stringValue(current.applyStatus, stringValue(patchUpdate.applyStatus, "not_run")),
  };
}

function ledgerTestCommands(value: unknown) {
  const ledger = recordValue(value);
  const metadata = recordValue(ledger.metadata);
  const commands: string[] = [];
  for (const itemValue of arrayValue(metadata.evidence)) {
    const item = recordValue(itemValue);
    const command = stringValue(item.command);
    if (!command) continue;
    const result = stringValue(item.result);
    if (result && result !== "pass") continue;
    commands.push(command);
  }
  return commands;
}

function mergeRegressionEvidence(evidence: LooseRecord, update: LooseRecord) {
  const current = recordValue(evidence.regressionEvidence);
  const commands = mergeUniqueStrings(current.canonicalCommandsRun, arrayValue(update.canonicalCommandsRun).map(String));
  evidence.regressionEvidence = {
    status: stringValue(current.status, stringValue(update.status, "present")),
    canonicalCommandsRun: commands,
    canonicalCommandsMissing: mergeUniqueStrings(current.canonicalCommandsMissing, arrayValue(update.canonicalCommandsMissing).map(String)),
    sourcePhase: stringValue(current.sourcePhase, stringValue(update.sourcePhase)) || null,
  };
}

function mergeEvidenceValidationViolations(evidence: LooseRecord, violations: string[]) {
  if (violations.length === 0) return;
  const current = recordValue(evidence.evidenceValidation);
  evidence.evidenceValidation = {
    ...current,
    violations: mergeUniqueStrings(current.violations, violations),
  };
}

async function readJsonFile(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath: string, label: string) {
  const events: LooseRecord[] = [];
  const violations: string[] = [];
  try {
    const raw = await readFile(filePath, "utf8");
    raw.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        events.push(recordValue(JSON.parse(trimmed)));
      } catch {
        violations.push(`${label} parse failed at line ${index + 1}`);
      }
    });
  } catch {
    return { events, violations };
  }
  return { events, violations };
}

function scorerRecordFromSummaryInstance(instance: LooseRecord, sourcePath: string, summary: LooseRecord) {
  const instanceId = stringValue(instance.instance_id || instance.instanceId || instance.benchmarkInstanceId);
  if (!instanceId) return null;
  const resolved = instance.resolved === true || instance.officialOutcome === "resolved";
  const failed = instance.failed === true || instance.officialOutcome === "error";
  const emptyPatch = instance.empty_patch === true || instance.officialOutcome === "empty_patch";
  const unresolved = instance.unresolved === true || instance.officialOutcome === "unresolved" || (!resolved && !failed && !emptyPatch);
  return {
    instanceId,
    scorer: {
      completed: true,
      resolved,
      unresolved,
      failed,
      emptyPatch,
      logPath: stringValue(instance.report || instance.logPath || summary.aggregateReport || sourcePath, sourcePath),
      reportPath: stringValue(instance.report || summary.aggregateReport),
      testOutputPath: stringValue(instance.test_output || instance.testOutput),
      aggregateReport: stringValue(summary.aggregateReport || sourcePath, sourcePath),
      predictionPath: stringValue(summary.prediction || summary.predictionsPath),
      runId: stringValue(summary.runId),
      patchSuccessfullyApplied: instance.patch_successfully_applied === true || instance.patchSuccessfullyApplied === true,
      failToPassSuccess: numericValue(instance.fail_to_pass_success || instance.failToPassSuccess),
      failToPassFailure: numericValue(instance.fail_to_pass_failure || instance.failToPassFailure),
      passToPassSuccess: numericValue(instance.pass_to_pass_success || instance.passToPassSuccess),
      passToPassFailure: numericValue(instance.pass_to_pass_failure || instance.passToPassFailure),
      source: "official_harness_summary",
    },
  };
}

function addAggregateScorerRecord(records: Record<string, LooseRecord>, instanceId: string, sourcePath: string, aggregate: LooseRecord) {
  if (!instanceId) return;
  const resolvedIds = new Set(arrayValue(aggregate.resolved_ids).map(String));
  const unresolvedIds = new Set(arrayValue(aggregate.unresolved_ids).map(String));
  const errorIds = new Set(arrayValue(aggregate.error_ids).map(String));
  const emptyPatchIds = new Set(arrayValue(aggregate.empty_patch_ids).map(String));
  records[instanceId] = {
    completed: true,
    resolved: resolvedIds.has(instanceId),
    unresolved: unresolvedIds.has(instanceId),
    failed: errorIds.has(instanceId),
    emptyPatch: emptyPatchIds.has(instanceId),
    logPath: sourcePath,
    aggregateReport: sourcePath,
    source: "official_harness_aggregate",
  };
}

export function scorerEvidenceByInstanceId(scorerEvidence: unknown, sourcePath = "") {
  const evidence = recordValue(scorerEvidence);
  const records: Record<string, LooseRecord> = {};
  for (const itemValue of arrayValue(evidence.instances)) {
    const parsed = scorerRecordFromSummaryInstance(recordValue(itemValue), sourcePath, evidence);
    if (parsed) records[parsed.instanceId] = parsed.scorer;
  }
  const aggregateIds = new Set([
    ...arrayValue(evidence.submitted_ids).map(String),
    ...arrayValue(evidence.completed_ids).map(String),
    ...arrayValue(evidence.resolved_ids).map(String),
    ...arrayValue(evidence.unresolved_ids).map(String),
    ...arrayValue(evidence.error_ids).map(String),
    ...arrayValue(evidence.empty_patch_ids).map(String),
  ]);
  for (const instanceId of aggregateIds) {
    if (!records[instanceId]) addAggregateScorerRecord(records, instanceId, sourcePath, evidence);
  }
  return records;
}

export async function loadSweBenchScorerEvidenceByAssignmentId({
  manifest,
  scorerEvidencePath,
}: {
  manifest: unknown;
  scorerEvidencePath: string;
}) {
  const scorerEvidence = await readJsonFile(scorerEvidencePath);
  const byInstanceId = scorerEvidenceByInstanceId(scorerEvidence, scorerEvidencePath);
  const byAssignmentId: Record<string, LooseRecord> = {};
  for (const assignment of arrayValue(recordValue(manifest).assignments)) {
    const assignmentId = assignmentIdValue(assignment);
    const instanceId = assignmentInstanceId(assignment);
    const scorer = instanceId ? byInstanceId[instanceId] : null;
    if (assignmentId && scorer) byAssignmentId[assignmentId] = { scorer };
  }
  return byAssignmentId;
}

function mergeEvidenceMaps(...maps: Array<Record<string, unknown>>) {
  const merged: Record<string, LooseRecord> = {};
  for (const map of maps) {
    for (const [assignmentId, value] of Object.entries(map)) {
      const current = recordValue(merged[assignmentId]);
      const update = recordValue(value);
      merged[assignmentId] = {
        ...current,
        ...update,
        patch: { ...recordValue(current.patch), ...recordValue(update.patch) },
        regressionEvidence: { ...recordValue(current.regressionEvidence), ...recordValue(update.regressionEvidence) },
        phaseEvidence: { ...recordValue(current.phaseEvidence), ...recordValue(update.phaseEvidence) },
        blockedEvents: { ...recordValue(current.blockedEvents), ...recordValue(update.blockedEvents) },
        cleanup: { ...recordValue(current.cleanup), ...recordValue(update.cleanup) },
        scorer: { ...recordValue(current.scorer), ...recordValue(update.scorer) },
      };
    }
  }
  return merged;
}

async function assignmentResultFiles(hubRoot: string, assignmentId: string) {
  const attemptsRoot = path.join(hubRoot, "assignments", assignmentId, "attempts");
  if (!await pathExists(attemptsRoot)) return [];
  const entries = await readdir(attemptsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(attemptsRoot, entry.name, "result.json"))
    .sort();
}

function runtimeEventFile(hubRoot: string, projectId: string, jobId: string) {
  if (!projectId || !jobId) return "";
  return path.join(hubRoot, "projects", projectId, "events", projectId, `${jobId}.jsonl`);
}

function phaseResultsFromAttemptResult(result: LooseRecord) {
  return [
    ...arrayValue(result.phaseResults),
    ...arrayValue(recordValue(result.jobResult).phaseResults),
  ];
}

async function mergeRuntimeEventEvidence(evidence: LooseRecord, eventFile: string) {
  if (!eventFile) return;
  const jsonl = await readJsonlFile(eventFile, "runtime event JSONL");
  mergeEvidenceValidationViolations(evidence, jsonl.violations);
  for (const event of jsonl.events) {
    const eventName = stringValue(event.type || event.event);
    if (eventName === "riskmap_generated") {
      mergePrepareTaskRiskmapEvidence(evidence, eventFile, event);
    }
    const phaseName = stringValue(event.phase);
    if (!phaseName) continue;
    if (eventName === "phase_retry") {
      const phaseEvidence = phaseEvidenceEntry(evidence, phaseName);
      phaseEvidence.retryCount = numericValue(phaseEvidence.retryCount) + 1;
      const retryFailureKind = stringValue(event.failureKind || event.kind);
      if (retryFailureKind) {
        phaseEvidence.retryFailureKinds = [
          ...new Set([...arrayValue(phaseEvidence.retryFailureKinds).map(String), retryFailureKind]),
        ];
      }
    } else if (eventName === "phase_completed") {
      phaseEvidenceEntry(evidence, phaseName).ok = true;
    } else if (eventName === "phase_failed") {
      const phaseEvidence = phaseEvidenceEntry(evidence, phaseName);
      phaseEvidence.ok = false;
      phaseEvidence.failureKind = preferredFailureKind(
        phaseEvidence.failureKind,
        event.failureKind || event.kind,
      );
      setFailureKind(evidence, phaseEvidence.failureKind);
    }
  }
}

function mergePhaseResultEvidence(evidence: LooseRecord, phaseResultValue: unknown) {
  const phaseResult = recordValue(phaseResultValue);
  const phaseName = stringValue(phaseResult.phase);
  const artifact = recordValue(phaseResult.artifact);
  const metadata = recordValue(artifact.metadata);
  const diagnostics = recordValue(phaseResult.diagnostics);
  if (phaseName) {
    const phaseEvidence = phaseEvidenceEntry(evidence, phaseName);
    const phasePassed = phaseResult.ok === true || phaseResult.status === "passed";
    const phaseFailed = phaseResult.ok === false || phaseResult.status === "failed";
    phaseEvidence.ok = phasePassed
      ? true
      : phaseFailed
      ? false
      : phaseEvidence.ok;
    phaseEvidence.durationMs = Math.max(
      numericValue(phaseEvidence.durationMs),
      numericValue(phaseResult.durationMs || metadata.durationMs || diagnostics.elapsedMs),
    );
    phaseEvidence.retryCount = Math.max(
      numericValue(phaseEvidence.retryCount),
      Math.max(0, numericValue(phaseResult.retryCount || phaseResult.attempts || phaseResult.attempt) - 1),
    );
    phaseEvidence.structuredOutputBytes = numericValue(phaseEvidence.structuredOutputBytes)
      + numericValue(artifact.bytes || metadata.bytes);
    phaseEvidence.structuredOutputPath = stringValue(artifact.path, stringValue(phaseEvidence.structuredOutputPath)) || null;
    phaseEvidence.artifactSha256 = stringValue(artifact.sha256, stringValue(phaseEvidence.artifactSha256)) || null;
    phaseEvidence.toolEvents = Math.max(
      numericValue(phaseEvidence.toolEvents),
      numericValue(recordValue(diagnostics.usage).toolCalls),
    );
    const failure = recordValue(phaseResult.failure);
    if (phasePassed) {
      phaseEvidence.failureKind = "";
    } else {
      phaseEvidence.failureKind = preferredFailureKind(
        phaseEvidence.failureKind,
        phaseResult.failureKind || failure.kind || failure.failureKind,
      );
      setFailureKind(evidence, phaseEvidence.failureKind);
    }
  }
  if (phaseResult.phase === "execute") {
    mergePatchEvidence(evidence, {
      path: artifact.path || null,
      sha256: artifact.sha256 || null,
      bytes: artifact.bytes || 0,
      changedFiles: metadata.changedFiles,
      applyStatus: "not_checked",
    });
  }
  if (phaseResult.phase === "verify" || phaseResult.phase === "adversarial_verify") {
    const verificationEvidence = recordValue(diagnostics.verificationEvidence);
    const gitEvidence = recordValue(verificationEvidence.git);
    if (arrayValue(gitEvidence.changedFiles).length > 0) {
      mergePatchEvidence(evidence, {
        changedFiles: gitEvidence.changedFiles,
      });
    }
    const tests = [
      ...arrayValue(metadata.tests).map(String),
      ...ledgerTestCommands(diagnostics.evidenceLedgerArtifact),
      ...ledgerTestCommands(verificationEvidence.evidenceLedgerArtifact),
    ];
    if (metadata.status === "pass" || phaseResult.ok === true || phaseResult.status === "passed" || tests.length > 0) {
      mergeRegressionEvidence(evidence, {
        status: "present",
        canonicalCommandsRun: tests,
        canonicalCommandsMissing: [],
        sourcePhase: phaseResult.phase,
      });
    }
  }
}

function mergeAssignmentResultFailureEvidence(evidence: LooseRecord, result: LooseRecord) {
  const jobFailure = recordValue(recordValue(result.jobResult).failure);
  const failureKind = stringValue(
    result.failureKind || result.failureReason,
    stringValue(jobFailure.kind || jobFailure.failureKind),
  );
  setFailureKind(evidence, failureKind);
  const failureReason = stringValue(result.error || jobFailure.reason || jobFailure.message);
  if (failureReason && !stringValue(evidence.failureReason)) evidence.failureReason = failureReason;
}

async function mergeAuditEvidence(evidence: LooseRecord, auditFile: unknown, fallbackPhase = "") {
  const filePath = stringValue(auditFile);
  if (!filePath) return;
  const blockedEvents = blockedEventsValue(evidence.blockedEvents);
  const cleanup = cleanupEvidenceValue(evidence.cleanup);
  const toolEventCounts: Record<string, number> = {};
  const jsonl = await readJsonlFile(filePath, "ACP audit JSONL");
  mergeEvidenceValidationViolations(evidence, jsonl.violations);
  for (const event of jsonl.events) {
    const eventName = stringValue(event.event);
    const phaseName = stringValue(event.phase, fallbackPhase);
    const phaseEvidence = phaseName ? phaseEvidenceEntry(evidence, phaseName) : null;
    if (phaseEvidence && eventName === "session_update") {
      phaseEvidence.auditUpdateEvents = numericValue(phaseEvidence.auditUpdateEvents) + 1;
    }
    if (phaseEvidence && eventName === "tool_call") {
      toolEventCounts[phaseName] = (toolEventCounts[phaseName] || 0) + 1;
    }
    if (phaseEvidence && /^terminal_/.test(eventName) && eventName !== "terminal_cleanup") {
      phaseEvidence.terminalCommands = numericValue(phaseEvidence.terminalCommands) + 1;
    }
    const reason = stringValue(event.reason);
    const classification = stringValue(event.classification || event.failureKind);
    const text = `${classification} ${reason}`;
    const hardConstraintKind = hardConstraintFailureKindFromText(text);
    if (hardConstraintKind) {
      setFailureKind(evidence, hardConstraintKind);
      if (phaseEvidence) {
        phaseEvidence.failureKind = preferredFailureKind(phaseEvidence.failureKind, hardConstraintKind);
      }
    }
    if (eventName === "terminal_cleanup") {
      cleanup.terminalCleanupEvents = numericValue(cleanup.terminalCleanupEvents) + 1;
      cleanup.forcedKills = numericValue(cleanup.forcedKills)
        + numericValue(event.forcedKillCount || event.forcedKills);
      cleanup.residualProcesses = numericValue(cleanup.residualProcesses)
        + numericValue(event.residualProcesses);
      const reasons = arrayValue(cleanup.reasons).map(String);
      if (reason) reasons.push(reason);
      cleanup.reasons = Array.from(new Set(reasons));
      cleanup.terminalIds = Array.from(new Set([
        ...arrayValue(cleanup.terminalIds).map(String),
        ...arrayValue(event.terminalIds).map(String),
      ]));
    }
    if (eventName === "tool_blocked" && /web tool use is disabled|web_tool_denied/i.test(text)) {
      blockedEvents.webToolAttempts += 1;
      blockedEvents.webToolBlocked += 1;
    }
    if (/read-only phase .*cannot run mutating terminal command|read_only_mutation_denied/i.test(text)) {
      blockedEvents.readOnlyMutationAttempts += 1;
      if (eventName === "tool_blocked" || eventName === "terminal_blocked") {
        blockedEvents.readOnlyMutationBlocked += 1;
      }
    }
    if (/broad_test_command_denied/i.test(text)) {
      blockedEvents.broadTestCommandAttempts += 1;
      if (eventName === "tool_blocked" || eventName === "terminal_blocked") {
        blockedEvents.broadTestCommandBlocked += 1;
      }
    }
  }
  for (const [phaseName, count] of Object.entries(toolEventCounts)) {
    const phaseEvidence = phaseEvidenceEntry(evidence, phaseName);
    phaseEvidence.toolEvents = Math.max(numericValue(phaseEvidence.toolEvents), count);
  }
  evidence.blockedEvents = blockedEvents;
  evidence.cleanup = cleanup;
}

export async function collectSweBenchBatchEvidence({
  hubRoot,
  manifest,
}: {
  hubRoot: string;
  manifest: unknown;
}) {
  const byAssignmentId: Record<string, LooseRecord> = {};
  const assignments = arrayValue(recordValue(manifest).assignments);
  const statesByAssignmentId = terminalStateMap(arrayValue(recordValue(manifest).terminalStates));
  for (const assignment of assignments) {
    const assignmentRecord = recordValue(assignment);
    const assignmentId = assignmentIdValue(assignment);
    if (!assignmentId) continue;
    const evidence: LooseRecord = {};
    const mergedAuditFiles = new Set<string>();
    const mergedEventFiles = new Set<string>();
    const terminalState = recordValue(statesByAssignmentId.get(assignmentId));
    const projectId = stringValue(assignmentRecord.projectId || terminalState.projectId);
    const resultFiles = await assignmentResultFiles(hubRoot, assignmentId);
    for (const resultFile of resultFiles) {
      const result = recordValue(await readJsonFile(resultFile));
      mergeAssignmentResultFailureEvidence(evidence, result);
      mergeCodeGraphCleanupEvidence(evidence, recordValue(result.cleanup).codegraph);
      const jobId = stringValue(recordValue(result.jobResult).jobId || result.jobId || terminalState.jobId);
      if (jobId) evidence.jobId = jobId;
      const eventFile = runtimeEventFile(hubRoot, projectId, jobId);
      if (eventFile && !mergedEventFiles.has(eventFile)) {
        mergedEventFiles.add(eventFile);
        await mergeRuntimeEventEvidence(evidence, eventFile);
      }
      for (const phaseResult of phaseResultsFromAttemptResult(result)) {
        const phaseResultRecord = recordValue(phaseResult);
        const auditFile = stringValue(recordValue(phaseResultRecord.diagnostics).acpAuditFile);
        mergePhaseResultEvidence(evidence, phaseResult);
        if (auditFile && !mergedAuditFiles.has(auditFile)) {
          mergedAuditFiles.add(auditFile);
          await mergeAuditEvidence(evidence, auditFile, stringValue(phaseResultRecord.phase));
        }
      }
    }
    byAssignmentId[assignmentId] = evidence;
  }
  return { byAssignmentId };
}

function preflightViolationStrings(value: unknown) {
  return arrayValue(value)
    .map((violation) => sanitizeLivePreflightReason(String(violation)))
    .filter(Boolean);
}

function stableJsonEqual(left: unknown, right: unknown) {
  return stableJson(left) === stableJson(right);
}

function codeGraphCleanupProofViolations({
  proofValue,
  assignment,
  terminalState,
  job,
  instanceId,
}: {
  proofValue: unknown;
  assignment: unknown;
  terminalState: unknown;
  job: LooseRecord;
  instanceId: string;
}) {
  const label = instanceId || stringValue(job.assignmentId) || "(unknown)";
  const violations: string[] = [];
  if (!isRecord(proofValue)) {
    return [`completed live job ${label} is missing CodeGraph cleanup proof`];
  }
  const proof = recordValue(proofValue);
  const startup = recordValue(proof.startup);
  if (unexpectedKeys(proof, CODEGRAPH_CLEANUP_PROOF_FIELDS).length > 0
    || unexpectedKeys(startup, CODEGRAPH_CLEANUP_STARTUP_FIELDS).length > 0) {
    violations.push(`completed live job ${label} CodeGraph cleanup proof schema is not closed`);
  }
  if (proof.generator !== CODEGRAPH_CLEANUP_PROOF_GENERATOR) violations.push(`completed live job ${label} CodeGraph cleanup proof generator is invalid`);
  if (proof.ok !== true || proof.cleanupVerified !== true || proof.processTreeStopped !== true || proof.stateRemoved !== true) {
    violations.push(`completed live job ${label} CodeGraph cleanup proof is not verified`);
  }
  // Runtime cleanup can recover with retries; release evidence requires first-cleanup success.
  if (!isPositiveSafeIntegerValue(proof.cleanupAttempt) || proof.cleanupAttempt !== 1) {
    violations.push(`completed live job ${label} CodeGraph cleanup proof must come from the first cleanup attempt`);
  }
  if (proof.context !== "before_terminal_publication") {
    violations.push(`completed live job ${label} CodeGraph cleanup proof context is invalid`);
  }
  if (startup.ok !== true || stringValue(startup.source) !== stringValue(proof.startupSource)) {
    violations.push(`completed live job ${label} CodeGraph startup proof is inconsistent`);
  }
  if (!isPositiveSafeIntegerValue(startup.pid)
    || !isPositiveSafeIntegerValue(startup.processPid)
    || !isPositiveSafeIntegerValue(proof.pid)
    || !isPositiveSafeIntegerValue(proof.processPid)) {
    violations.push(`completed live job ${label} CodeGraph startup pids must be positive safe integers`);
  }
  if (startup.pid !== proof.pid
    || startup.processPid !== proof.processPid
    || stringValue(startup.statePath) !== stringValue(proof.statePath)) {
    violations.push(`completed live job ${label} CodeGraph startup pids or state path are inconsistent`);
  }
  if (!orderedIsoTimestamps(startup.startedAt, startup.readyAt, proof.cleanupStartedAt, proof.cleanupCompletedAt)) {
    violations.push(`completed live job ${label} CodeGraph cleanup proof timestamps are invalid or out of order`);
  }
  if (!stringValue(proof.statePath) || !stringValue(proof.worktreePath) || !stringValue(startup.source)) {
    violations.push(`completed live job ${label} CodeGraph cleanup proof is missing startup readiness fields`);
  }

  const assignmentRecord = recordValue(assignment);
  const queued = recordValue(assignmentRecord.queued);
  const state = recordValue(terminalState);
  const requireStringIdentity = (field: string, values: unknown[], mismatch: string) => {
    const present = values.filter((value) => value !== undefined);
    const validStrings = present
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    const invalid = present.some((value) => typeof value !== "string" || value.trim().length === 0);
    const authoritative = Array.from(new Set(validStrings));
    if (invalid || authoritative.length === 0) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof is missing authoritative ${field}`);
    } else if (authoritative.length > 1) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof has conflicting authoritative ${field}`);
    } else if (proof[field] !== authoritative[0]) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof ${mismatch}`);
    }
  };
  const requireNumericIdentity = (field: string, values: unknown[], mismatch: string) => {
    const present = values.filter((value) => value !== undefined);
    const invalid = present.some((value) => !isPositiveSafeIntegerValue(value));
    const authoritative = Array.from(new Set(present.filter(isPositiveSafeIntegerValue)));
    if (invalid || authoritative.length === 0) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof is missing authoritative ${field}`);
    } else if (authoritative.length > 1) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof has conflicting authoritative ${field}`);
    } else if (proof[field] !== authoritative[0]) {
      violations.push(`completed live job ${label} CodeGraph cleanup proof ${mismatch}`);
    }
  };

  requireStringIdentity(
    "assignmentId",
    [queued.assignmentId, assignmentRecord.assignmentId, state.assignmentId, job.assignmentId],
    "assignment identity mismatch",
  );
  requireNumericIdentity("attempt", [
    queued.attempt,
    assignmentRecord.attempt,
    assignmentRecord.attempts,
    state.attempt,
    state.attempts,
    job.attempt,
    recordValue(job.attempts).count,
  ], "attempt identity mismatch");
  requireStringIdentity("attemptToken", [queued.attemptToken, assignmentRecord.attemptToken, state.attemptToken], "attempt token mismatch");
  requireStringIdentity("entryId", [assignmentRecord.entryId, queued.entryId, state.entryId], "entry identity mismatch");
  requireStringIdentity("projectId", [assignmentRecord.projectId, queued.projectId, state.projectId], "project identity mismatch");
  requireStringIdentity("jobId", [state.jobId, job.jobId], "job identity mismatch");
  requireStringIdentity("workerId", [queued.workerId, assignmentRecord.workerId, state.workerId, job.workerId], "worker identity mismatch");
  requireNumericIdentity("orchestratorEpoch", [queued.orchestratorEpoch, assignmentRecord.orchestratorEpoch, state.orchestratorEpoch, job.orchestratorEpoch], "orchestrator epoch mismatch");
  return violations;
}

export function validateSweBenchBatchReport({
  manifest,
  report,
  artifactBaseDir,
  artifactPathRewrite,
}: {
  manifest: unknown;
  report: unknown;
  artifactBaseDir?: string;
  artifactPathRewrite?: { from: string; to: string };
}): SweBenchBatchReportValidation {
  const manifestRecord = recordValue(manifest);
  const reportRecord = recordValue(report);
  const assignments = arrayValue(manifestRecord.assignments);
  const jobs = arrayValue(reportRecord.jobs);
  const terminalStatesByAssignmentId = terminalStateMap(arrayValue(manifestRecord.terminalStates));
  const assignmentsById = new Map(assignments.map((assignment) => [assignmentIdValue(assignment), assignment]));
  const manifestIds = new Set(assignments.map(assignmentInstanceId).filter(Boolean));
  const jobIds = new Set(jobs.map(reportJobInstanceId).filter(Boolean));
  const violations: string[] = [];
  const strictLiveReleaseEvidence = manifestRecord.providerPreflightMode === "live";
  const reportManifest = recordValue(reportRecord.manifest);
  const sourceManifest = recordValue(reportRecord.sourceManifest);
  const sourceManifestHash = stableJsonSha256(manifestRecord);
  if (stringValue(reportManifest.hash) !== sourceManifestHash) {
    violations.push("report manifest hash is inconsistent with source manifest");
  }
  if (!isRecord(reportRecord.sourceManifest)) {
    violations.push("report source manifest copy is missing");
  } else {
    if (!stableJsonEqual(sourceManifest, manifestRecord)) {
      violations.push("report source manifest copy is inconsistent with source manifest");
    }
    if (stableJsonSha256(sourceManifest) !== stringValue(reportManifest.hash)) {
      violations.push("report manifest hash is inconsistent with report source manifest copy");
    }
  }
  const providerPreflightSource = manifestRecord.providerPreflight;
  const providerPreflightPhases = isRecord(providerPreflightSource)
    ? arrayValue(recordValue(providerPreflightSource).phases)
    : [];
  if (!stableJsonEqual(reportManifest.providerPreflight, providerPreflightSource)) {
    violations.push("report provider preflight copy is inconsistent with source manifest");
  }
  if (providerPreflightSource === undefined || providerPreflightSource === null) {
    violations.push("provider preflight evidence is missing");
  } else if (!isRecord(providerPreflightSource)) {
    violations.push("provider preflight evidence must be a record");
  } else {
    const providerPreflight = recordValue(providerPreflightSource);
    const providerPreflightViolations = preflightViolationStrings(providerPreflight.violations);
    if (providerPreflight.schemaVersion !== 1) {
      violations.push("provider preflight evidence schemaVersion must be 1");
    }
    if (providerPreflight.generator !== PROVIDER_PREFLIGHT_GENERATOR) {
      violations.push("provider preflight evidence generator is invalid");
    }
    if (providerPreflight.ok !== true) {
      violations.push(`provider preflight failed: ${providerPreflightViolations.join("; ") || "provider_unavailable"}`);
    }
    if (providerPreflightViolations.length > 0) {
      violations.push(`provider preflight has unresolved violation(s): ${providerPreflightViolations.join("; ")}`);
    }
    const preflightPhases = providerPreflightPhases;
    if (preflightPhases.length === 0) {
      violations.push("provider preflight phases are missing");
    }
    preflightPhases.forEach((phaseValue, index) => {
      if (!isRecord(phaseValue)) {
        violations.push(`provider preflight phase ${index + 1} must be a record`);
        return;
      }
      const phase = recordValue(phaseValue);
      const phaseLabel = stringValue(phase.phase || phase.role || phase.providerKey) || String(index + 1);
      if (phase.handshakeOk !== true) {
        violations.push(`provider preflight phase ${phaseLabel} did not pass live handshake`);
      }
      const phaseViolations = preflightViolationStrings(phase.violations);
      if (phaseViolations.length > 0) {
        violations.push(`provider preflight phase ${phaseLabel} has violation(s): ${phaseViolations.join("; ")}`);
      }
      if (!isRecord(phase.handshake)) {
        violations.push(`provider preflight phase ${phaseLabel} handshake evidence must be a record`);
        return;
      }
      const handshake = recordValue(phase.handshake);
      if (handshake.ok !== true) {
        violations.push(`provider preflight phase ${phaseLabel} handshake did not pass`);
      }
      if (handshake.mode !== "live") {
        violations.push(`provider preflight phase ${phaseLabel} must use live handshake evidence`);
      }
      if (handshake.generator !== LIVE_HANDSHAKE_GENERATOR) {
        violations.push(`provider preflight phase ${phaseLabel} handshake generator is invalid`);
      }
      if (handshake.sentinelVerified !== true) {
        violations.push(`provider preflight phase ${phaseLabel} sentinel was not verified`);
      }
      if (!stringValue(handshake.command)) {
        violations.push(`provider preflight phase ${phaseLabel} handshake command is missing`);
      }
      if ((phase.transport !== "acp" && phase.transport !== "claude-cli")
        || handshake.transport !== phase.transport) {
        violations.push(`provider preflight phase ${phaseLabel} handshake transport is missing or inconsistent`);
      }
      if (!providerHandshakeControlPlaneVerified(handshake, {
        phase: stringValue(phase.phase),
        role: stringValue(phase.role),
        agent: stringValue(phase.agent),
        providerKey: stringValue(phase.providerKey),
        transport: phase.transport as "acp" | "claude-cli",
        command: stringValue(handshake.command || phase.command),
        projectId: stringValue(handshake.projectId),
        jobId: stringValue(handshake.jobId),
        correlationNonce: stringValue(handshake.correlationNonce),
        outputPath: stringValue(phase.outputPath),
        outputBytes: numericValue(phase.outputBytes),
        outputSha256: stringValue(phase.outputSha256),
        outputContent: handshake,
        artifactBaseDir,
        artifactPathRewrite,
      })) {
        violations.push(`provider preflight phase ${phaseLabel} control-plane safety proof is missing or invalid`);
      }
      if (hasUnexpectedProviderHandshakeEvidence(handshake)) {
        violations.push(`provider preflight phase ${phaseLabel} handshake evidence must not retain launch arguments, environment, raw output, or provider streams`);
      }
    });
    const configuredAgents = recordValue(manifestRecord.agents || reportManifest.agents);
    const expectedRoutes = phaseProviderRoute({
      planner: stringValue(configuredAgents.planner),
      executor: stringValue(configuredAgents.executor),
      verifier: stringValue(configuredAgents.verifier),
      adversarial_verifier: stringValue(configuredAgents.adversarial_verifier),
    });
    for (const expected of expectedRoutes) {
      const matching = preflightPhases.find((phaseValue) => {
        const phase = recordValue(phaseValue);
        return phase.phase === expected.phase
          && phase.role === expected.role
          && phase.agent === expected.agent;
      });
      if (!expected.agent || !matching) {
        violations.push(`provider preflight is missing configured route ${expected.phase}/${expected.role}/${expected.agent || "(missing agent)"}`);
      }
    }
  }
  const residualProcesses = numericValue(recordValue(reportRecord.summary).residualProcesses);
  if (residualProcesses > 0) {
    violations.push(`batch has ${residualProcesses} residual process(es) after cleanup`);
  }
  const workerCleanup = workerCleanupEvidenceValue(manifestRecord.workerCleanup);
  const reportWorkerCleanup = workerCleanupEvidenceValue(reportManifest.workerCleanup);
  if (!stableJsonEqual(reportWorkerCleanup, workerCleanup)) {
    violations.push("report worker cleanup copy is inconsistent with source manifest");
  }
  if (isRecord(reportRecord.sourceManifest)
    && !stableJsonEqual(workerCleanupEvidenceValue(sourceManifest.workerCleanup), workerCleanup)) {
    violations.push("report source manifest worker cleanup is inconsistent with source manifest");
  }
  if (!workerCleanup.residualScanOk) {
    violations.push(`batch residual process scan failed: ${workerCleanup.residualScanFailures.join(", ") || "unverified"}`);
  }
  if (recordValue(reportRecord.summary).residualScanOk !== workerCleanup.residualScanOk) {
    violations.push("batch residual process scan summary is inconsistent");
  }
  if (strictLiveReleaseEvidence) {
    if (workerCleanup.residualScanOk !== true) {
      violations.push("live batch worker residual scan must be verified");
    }
    if (workerCleanup.residualProcesses !== 0) {
      violations.push("live batch worker cleanup must have zero residual processes");
    }
    if (workerCleanup.forcedKills !== 0) {
      violations.push("live batch worker cleanup must have zero forced kills");
    }
  }

  for (const assignment of assignments) {
    const assignmentId = assignmentIdValue(assignment);
    const instanceId = assignmentInstanceId(assignment);
    const terminalState = assignmentId ? terminalStatesByAssignmentId.get(assignmentId) : null;
    if (!assignmentId) {
      violations.push(`assignment ${instanceId || "(unknown)"} is missing assignmentId`);
    } else if (!terminalState) {
      violations.push(`assignment ${instanceId || assignmentId} is missing terminal state`);
    } else if (!TERMINAL_STATUSES.has(stringValue(terminalState.status))) {
      violations.push(`assignment ${instanceId || assignmentId} has non-terminal status`);
    }
    if (instanceId && !jobIds.has(instanceId)) {
      violations.push(`missing report job for ${instanceId}`);
    }
  }
  for (const job of jobs) {
    const instanceId = reportJobInstanceId(job);
    if (instanceId && !manifestIds.has(instanceId)) {
      violations.push(`report job is not in manifest: ${instanceId}`);
    }
    const jobRecord = recordValue(job);
    if (!TERMINAL_STATUSES.has(stringValue(jobRecord.status))) {
      violations.push(`report job ${instanceId || "(unknown)"} has non-terminal status`);
    }
    if (stringValue(jobRecord.failureKind) === "batch_wait_timeout") {
      violations.push(`report job ${instanceId || "(unknown)"} has synthetic batch timeout terminal state`);
    }
    const assignmentId = stringValue(jobRecord.assignmentId);
    const assignment = assignmentsById.get(assignmentId);
    const terminalState = terminalStatesByAssignmentId.get(assignmentId);
    const requiredAttempts = assignmentAttemptCount(assignment, terminalState);
    const attempts = recordValue(jobRecord.attempts);
    const attemptAuthority = attemptAuthorityViolation(assignment, terminalState, jobRecord);
    if (attemptAuthority) {
      violations.push(`report job ${instanceId || "(unknown)"} has ${attemptAuthority}`);
    }
    if (requiredAttempts > 0 && numericValue(attempts.lineageCount || attempts.count) < requiredAttempts) {
      violations.push(`attempt lineage incomplete for ${instanceId || "(unknown)"}`);
    }
    const blockedEvents = blockedEventsValue(jobRecord.blockedEvents);
    const hardConstraintAttempts = numericValue(blockedEvents.webToolAttempts)
      + numericValue(blockedEvents.readOnlyMutationAttempts)
      + numericValue(blockedEvents.broadTestCommandAttempts);
    if (hardConstraintAttempts > 0) {
      violations.push(`job ${instanceId || "(unknown)"} has ${hardConstraintAttempts} hard-constraint attempt(s)`);
    }
    if (requiresScorerEvidence(jobRecord) && !hasRequiredScorerEvidence(jobRecord)) {
      violations.push(`job ${instanceId || "(unknown)"} requires scorer evidence`);
    }
    for (const violation of arrayValue(recordValue(jobRecord.evidenceValidation).violations)) {
      violations.push(`job ${instanceId || "(unknown)"} ${String(violation)}`);
    }
    if (jobRecord.status !== "completed") continue;
    if (strictLiveReleaseEvidence) {
      const jobPreflight = arrayValue(recordValue(recordValue(jobRecord.providerRoute).actual).preflight);
      if (!stableJsonEqual(jobPreflight, providerPreflightPhases)) {
        violations.push(`job ${instanceId || "(unknown)"} provider preflight copy diverges from manifest providerPreflight.phases`);
      }
      if (stringValue(jobRecord.failureKind)) {
        violations.push(`completed live job ${instanceId || "(unknown)"} retains failure kind`);
      }
      violations.push(...codeGraphCleanupProofViolations({
        proofValue: recordValue(jobRecord.cleanup).codegraph,
        assignment,
        terminalState,
        job: jobRecord,
        instanceId,
      }));
      const phaseEvidence = recordValue(jobRecord.phaseEvidence);
      for (const phase of ["prepare_task", "plan", "execute", "verify", "adversarial_verify"]) {
        const phaseRecord = recordValue(phaseEvidence[phase]);
        if (phaseRecord.ok !== true) {
          violations.push(`completed live job ${instanceId || "(unknown)"} is missing successful ${phase} evidence`);
          continue;
        }
        if (numericValue(phaseRecord.retryCount) > 0 || arrayValue(phaseRecord.retryFailureKinds).length > 0) {
          violations.push(`completed live job ${instanceId || "(unknown)"} has ${phase} retry failure evidence`);
        }
        if (!hasAuditablePhaseArtifact(phase, phaseRecord)) {
          violations.push(`completed live job ${instanceId || "(unknown)"} has unauditable ${phase} artifact evidence`);
        }
      }
    }
    if (!hasPatchEvidence(jobRecord)) {
      violations.push(`completed job ${instanceId || "(unknown)"} is missing patch evidence`);
    }
    if (!hasRegressionEvidence(jobRecord)) {
      violations.push(`completed job ${instanceId || "(unknown)"} is missing regression evidence`);
    }
    if (hasRewrittenOracleTestEvidence(jobRecord)) {
      violations.push(`completed job ${instanceId || "(unknown)"} has rewritten oracle test evidence without passing external scorer/oracle`);
    }
    if (hasInvalidFixtureOnlyRegression(jobRecord)) {
      violations.push(`completed job ${instanceId || "(unknown)"} has fixture/fake/snapshot-only changes without regression justification`);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

function aggregatePhaseMetric(jobs: LooseRecord[], metric: string) {
  const totals: Record<string, number> = {};
  for (const job of jobs) {
    for (const [phase, phaseValue] of Object.entries(recordValue(recordValue(job).phaseEvidence))) {
      totals[phase] = (totals[phase] || 0) + numericValue(recordValue(phaseValue)[metric]);
    }
  }
  return totals;
}

function aggregatePhaseMax(jobs: LooseRecord[], metric: string) {
  const totals: Record<string, number> = {};
  for (const job of jobs) {
    for (const [phase, phaseValue] of Object.entries(recordValue(recordValue(job).phaseEvidence))) {
      const key = `${phase}Max`;
      totals[key] = Math.max(totals[key] || 0, numericValue(recordValue(phaseValue)[metric]));
    }
  }
  return totals;
}

function failureKindFromPhaseEvidence(phaseEvidenceValue: unknown) {
  const phaseEvidence = recordValue(phaseEvidenceValue);
  const preferredPhases = [
    "prepare_task",
    "plan",
    "execute",
    "review",
    "verify",
    "adversarial_verify",
    "remediate",
  ];
  let firstKind = "";
  for (const phase of preferredPhases) {
    const kind = stringValue(recordValue(phaseEvidence[phase]).failureKind);
    if (kind && !firstKind) firstKind = kind;
    const hardKind = hardConstraintFailureKindFromText(kind);
    if (hardKind) return hardKind;
  }
  for (const value of Object.values(phaseEvidence)) {
    const kind = stringValue(recordValue(value).failureKind);
    if (kind && !firstKind) firstKind = kind;
    const hardKind = hardConstraintFailureKindFromText(kind);
    if (hardKind) return hardKind;
  }
  return firstKind;
}

function reportFailureKind(terminalState: LooseRecord, evidence: LooseRecord) {
  const terminalKind = stringValue(terminalState.failureKind || terminalState.failureReason);
  const evidenceKind = stringValue(evidence.failureKind, failureKindFromPhaseEvidence(evidence.phaseEvidence));
  if (stringValue(terminalState.status) === "completed") {
    return hardConstraintFailureKindFromText(terminalKind)
      || hardConstraintFailureKindFromText(evidenceKind);
  }
  return preferredFailureKind(terminalKind, evidenceKind);
}

export function buildSweBenchBatchReport({
  manifest,
  evidenceByAssignmentId = {},
  scorerRequired = false,
  generatedAt = new Date().toISOString(),
}: {
  manifest: unknown;
  evidenceByAssignmentId?: Record<string, unknown>;
  scorerRequired?: boolean;
  generatedAt?: string;
}): SweBenchBatchReport {
  const manifestRecord = recordValue(manifest);
  const sourceManifest = JSON.parse(JSON.stringify(manifestRecord)) as LooseRecord;
  const assignments = arrayValue(manifestRecord.assignments);
  const agents = recordValue(manifestRecord.agents);
  const providerPreflightSource = manifestRecord.providerPreflight;
  const providerPreflight = recordValue(providerPreflightSource);
  const workerCleanup = workerCleanupEvidenceValue(manifestRecord.workerCleanup);
  const terminalStates = arrayValue(manifestRecord.terminalStates);
  const statesByAssignmentId = terminalStateMap(terminalStates);
  const stateCounts = terminalStateCounts(terminalStates);
  const jobs = assignments.map((assignment, index) => {
    const assignmentRecord = recordValue(assignment);
    const record = recordValue(assignmentRecord.record);
    const assignmentId = assignmentIdValue(assignment);
    const terminalState = recordValue(statesByAssignmentId.get(assignmentId));
    const evidence = recordValue(evidenceByAssignmentId[assignmentId]);
    const attemptCount = assignmentAttemptCount(assignment, terminalState);
    const blockedEvents = blockedEventsValue(evidence.blockedEvents);
    const cleanup = cleanupEvidenceValue(evidence.cleanup);
    const phaseEvidence = recordValue(evidence.phaseEvidence);
    const patch = {
      path: null,
      sha256: null,
      bytes: 0,
      changedFiles: [],
      changedFileCount: 0,
      applyStatus: "not_run",
      ...recordValue(evidence.patch),
    };
    const patchKind = scorerPatchKind(patch);
    const scorerEvidence = recordValue(evidence.scorer);
    const scorerExempt = scorerRequired && patchKind === "test_only_patch" && scorerEvidence.completed !== true;
    const scorer = {
      required: scorerRequired && (!scorerExempt || scorerEvidence.completed === true),
      completed: false,
      resolved: false,
      unresolved: false,
      failed: false,
      patchKind,
      sourceChangedFiles: sourceChangedFilesFromPatch(patch),
      exempt: scorerExempt,
      exemptionReason: scorerExempt ? "source_patch_absent" : null,
      logPath: null,
      ...scorerEvidence,
    };
    const regressionEvidence: LooseRecord = {
      status: "unknown",
      canonicalCommandsRun: [],
      canonicalCommandsMissing: [],
      ...recordValue(evidence.regressionEvidence),
    };
    regressionEvidence.oracleIntegrity = {
      ...oracleIntegrityEvidence({
        patch,
        scorer,
        regressionEvidence,
      }),
      ...recordValue(regressionEvidence.oracleIntegrity),
    };
    return {
      index,
      benchmarkInstanceId: assignmentInstanceId(assignment),
      assignmentId,
      jobId: stringValue(evidence.jobId || terminalState.jobId) || null,
      status: stringValue(terminalState.status, "unknown"),
      failureKind: reportFailureKind(terminalState, evidence),
      providerRoute: {
        expected: agents,
        actual: {
          preflight: arrayValue(providerPreflight.phases),
        },
      },
      attempts: {
        count: attemptCount,
        lineageCount: attemptCount,
      },
      blockedEvents,
      cleanup,
      evidenceValidation: {
        violations: [],
        ...recordValue(evidence.evidenceValidation),
      },
      phaseEvidence,
      patch,
      scorer,
      regressionEvidence,
      record: {
        benchmarkInstanceId: record.benchmarkInstanceId,
        representativeRepository: record.representativeRepository,
        baseCommit: record.baseCommit,
        datasetRowRef: record.datasetRowRef,
      },
    };
  });
  const report: SweBenchBatchReport = {
    schemaVersion: 1,
    generatedAt,
    sourceManifest,
    manifest: {
      hash: stableJsonSha256(sourceManifest),
      dataset: manifestRecord.dataset,
      split: manifestRecord.split,
      count: manifestRecord.count,
      assignmentCount: assignments.length,
      planMode: manifestRecord.planMode,
      agents,
      providerPreflight: providerPreflightSource ?? null,
      workerCleanup,
    },
    summary: {
      totalJobs: jobs.length,
      terminalJobs: terminalStates.length,
      terminalStates: stateCounts,
      providerPreflightOk: providerPreflight.ok ?? null,
      phaseDurationsMs: aggregatePhaseMax(jobs, "durationMs"),
      phaseRetryCounts: aggregatePhaseMetric(jobs, "retryCount"),
      structuredOutputBytes: aggregatePhaseMetric(jobs, "structuredOutputBytes"),
      toolEventCounts: aggregatePhaseMetric(jobs, "toolEvents"),
      terminalCommandCounts: aggregatePhaseMetric(jobs, "terminalCommands"),
      auditUpdateEvents: aggregatePhaseMetric(jobs, "auditUpdateEvents"),
      cleanupEvents: workerCleanup.workerCleanupEvents
        + jobs.reduce((sum, job) => sum + cleanupEventCount(recordValue(job).cleanup), 0),
      forcedKills: workerCleanup.forcedKills
        + jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).cleanup).forcedKills), 0),
      residualProcesses: workerCleanup.residualProcesses
        + jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).cleanup).residualProcesses), 0),
      residualScanOk: workerCleanup.residualScanOk,
      webToolAttempts: jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).blockedEvents).webToolAttempts), 0),
      webToolBlocked: jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).blockedEvents).webToolBlocked), 0),
      readOnlyMutationAttempts: jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).blockedEvents).readOnlyMutationAttempts), 0),
      broadTestCommandAttempts: jobs.reduce((sum, job) => sum + numericValue(recordValue(recordValue(job).blockedEvents).broadTestCommandAttempts), 0),
      emptyDiffJobs: 0,
      sourcePatchJobs: jobs.filter((job) => hasSourcePatchEvidence(recordValue(job))).length,
      scorerRequired: jobs.filter((job) => recordValue(job.scorer).required === true).length,
      scorerCompleted: jobs.filter((job) => recordValue(job.scorer).completed === true).length,
      scorerResolved: jobs.filter((job) => recordValue(job.scorer).resolved === true).length,
      scorerUnresolved: jobs.filter((job) => recordValue(job.scorer).unresolved === true).length,
      scorerFailed: jobs.filter((job) => recordValue(job.scorer).failed === true).length,
      scorerExempted: jobs.filter((job) => recordValue(job.scorer).exempt === true).length,
    },
    jobs,
    validation: {
      valid: true,
      violations: [],
    },
  };
  report.validation = validateSweBenchBatchReport({ manifest, report });
  return report;
}

export async function writeSweBenchBatchOutputs({
  manifest,
  manifestPath,
  reportPath,
  hubRoot = null,
  scorerRequired = false,
  scorerEvidencePath = null,
}: {
  manifest: unknown;
  manifestPath: string;
  reportPath: string;
  hubRoot?: string | null;
  scorerRequired?: boolean;
  scorerEvidencePath?: string | null;
}) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeJsonAtomic(manifestPath, manifest);
  const runtimeEvidence = hubRoot
    ? await collectSweBenchBatchEvidence({ hubRoot, manifest })
    : { byAssignmentId: {} };
  const scorerEvidence = scorerEvidencePath
    ? await loadSweBenchScorerEvidenceByAssignmentId({ manifest, scorerEvidencePath })
    : {};
  const report = buildSweBenchBatchReport({
    manifest,
    evidenceByAssignmentId: mergeEvidenceMaps(runtimeEvidence.byAssignmentId, scorerEvidence),
    scorerRequired,
  });
  await writeJsonAtomic(reportPath, report);
  return {
    manifestPath,
    reportPath,
    report,
  };
}

export async function writePreflightFailureOutputs({
  options,
  providerPreflight,
  startedAt = new Date().toISOString(),
}: {
  options: QueueOptions;
  providerPreflight: unknown;
  startedAt?: string;
}) {
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    dataset: DATASET,
    split: DATASET_SPLIT,
    count: 0,
    planMode: options.planMode,
    providerPreflightMode: options.providerPreflightMode,
    agents: options.agents,
    hubRoot: options.hubRoot,
    cpbRoot: options.cpbRoot,
    sourceRoot: options.sourceRoot,
    workerIds: buildWorkerIds(options),
    timeoutMs: options.timeoutMs,
    waitTimeoutMs: options.waitTimeoutMs,
    providerPreflight,
    workers: [],
    workerCleanup: emptyWorkerCleanupEvidence(),
    dryRun: options.dryRun,
    waited: options.wait,
    terminalStates: [],
    assignments: [],
  };
  return writeSweBenchBatchOutputs({
    manifest,
    manifestPath: options.outputPath,
    reportPath: options.reportPath,
    hubRoot: options.hubRoot,
  });
}

export function preflightFailureMessage(providerPreflight: unknown) {
  const preflight = recordValue(providerPreflight);
  const failureKind = normalizedHandshakeFailureKind(preflight.failureKind) || "provider_unavailable";
  const violations = preflightViolationStrings(preflight.violations);
  return `${failureKind}: ${violations.join("; ") || "provider_unavailable"}`;
}

export function buildBatchAssignmentInput({
  record,
  row,
  sourcePath,
  agents,
  planMode,
}: {
  record: SweBenchBatchRecord;
  row: LooseRecord;
  sourcePath: string;
  agents: ProductValidationAgents;
  planMode: ProductValidationPlanMode;
}): AssignmentInput {
  const entryId = safeId(record.benchmarkInstanceId);
  const projectId = safeId(`swebench-${record.benchmarkInstanceId}`);
  const jobId = `job-${entryId}`;
  const task = buildTask(row, record);
  const productValidation = {
    validationMode: "swe-bench-verified",
    benchmarkInstanceId: record.benchmarkInstanceId,
    datasetRowRef: record.datasetRowRef,
    planMode,
    agents,
    adversarialRequired: true,
  };
  return {
    entryId,
    projectId,
    task,
    sourcePath,
    workflow: "standard",
    planMode,
    sourceContext: {
      benchmarkDataset: DATASET,
      benchmarkInstanceId: record.benchmarkInstanceId,
      benchmarkRepository: record.representativeRepository,
      benchmarkBaseCommit: record.baseCommit,
      issueNumber: null,
      productValidation,
    },
    metadata: {
      autoFinalize: true,
      finalizeMode: "dry-run",
      agents,
      productValidation,
    },
  };
}

export function buildManagedWorkerEnv({
  repoRoot,
  hubRoot,
  cpbRoot,
  phaseAgents,
  timeoutMs,
}: {
  repoRoot: string;
  hubRoot: string;
  cpbRoot: string;
  phaseAgents: ProductValidationAgents;
  timeoutMs: number;
}) {
  return {
    CPB_ROOT: cpbRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_EXECUTOR_ROOT: repoRoot,
    CPB_PROJECT_ROOTS: path.dirname(hubRoot),
    CPB_WORKER_DISPATCH_ENABLED: "0",
    CPB_ACP_USE_MANAGED_POOL: "0",
    CPB_ACP_PERSISTENT_PROCESS: "0",
    CPB_DYNAMIC_VERIFIER_AGENT: phaseAgents.verifier,
    CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1",
    CPB_WORKER_EXIT_ON_IDLE: "1",
    CPB_WORKER_IDLE_EXIT_MS: process.env.CPB_WORKER_IDLE_EXIT_MS || "60000",
    CPB_ACP_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_IDLE_TIMEOUT_MS: process.env.CPB_ACP_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
    CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS: process.env.CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
    CPB_ACP_PHASE_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_POOL_TIMEOUT_MS: String(timeoutMs),
  };
}

function normalizedArgv(argv: string[]) {
  return argv.length > 0 && argv[0].startsWith("--") ? argv : argv.slice(2);
}

export function defaultBatchWaitTimeoutMs({
  count,
  startWorkers,
  timeoutMs,
}: {
  count: number;
  startWorkers: number;
  timeoutMs: number;
}) {
  if (startWorkers <= 0) return timeoutMs;
  const waves = Math.max(1, Math.ceil(count / startWorkers));
  const phaseBudgetMultiplier = 4;
  return timeoutMs * waves * phaseBudgetMultiplier;
}

export function resolveBatchQueueOptions(argv: string[]): QueueOptions {
  const args = normalizedArgv(argv);
  const tmpRoot = path.join(os.tmpdir(), `cpb-swebench-batch-${Date.now()}`);
  const hubRoot = path.resolve(argValue(args, "--hub-root") || path.join(tmpRoot, "hub"));
  const hubRootExplicit = argValue(args, "--hub-root") !== null;
  const cpbRoot = path.resolve(argValue(args, "--cpb-root") || path.join(tmpRoot, "cpb"));
  const sourceRoot = path.resolve(argValue(args, "--source-root") || path.join(tmpRoot, "sources"));
  const outputPath = path.resolve(argValue(args, "--output") || path.join(hubRoot, "swebench-batch-queue-manifest.json"));
  const agents = resolveProductValidationAgents(args);
  const count = positiveInt(argValue(args, "--count"), 50, "--count");
  const workerCount = positiveInt(argValue(args, "--worker-count"), 1, "--worker-count");
  const startWorkers = positiveInt(argValue(args, "--start-workers"), 0, "--start-workers");
  const timeoutMs = positiveInt(argValue(args, "--timeout-ms"), 1_200_000, "--timeout-ms");
  const dryRun = hasFlag(args, "--dry-run");
  const providerPreflightMode = parseProviderPreflightMode(
    argValue(args, "--provider-preflight") || process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT || null,
  ) || (dryRun ? "structural" : "live");
  const waitTimeoutOverride = argValue(args, "--wait-timeout-ms");
  return {
    count,
    offset: Number.parseInt(argValue(args, "--offset") || "0", 10),
    pageSize: positiveInt(argValue(args, "--page-size"), DEFAULT_PAGE_SIZE, "--page-size"),
    planMode: parsePlanMode(argValue(args, "--plan-mode")),
    providerPreflightMode,
    agents,
    hubRoot,
    cpbRoot,
    sourceRoot,
    outputPath,
    reportPath: path.resolve(argValue(args, "--report-output") || path.join(path.dirname(outputPath), "swebench-batch-report.json")),
    workerCount: Math.max(workerCount, startWorkers || 0, 1),
    workerPrefix: argValue(args, "--worker-prefix") || "w-swebench",
    timeoutMs,
    waitTimeoutMs: waitTimeoutOverride
      ? positiveInt(waitTimeoutOverride, 1_200_000, "--wait-timeout-ms")
      : defaultBatchWaitTimeoutMs({ count, startWorkers, timeoutMs }),
    notify: !hasFlag(args, "--no-notify"),
    notifyTitle: argValue(args, "--notify-title") || "CPB SWE-bench batch",
    skipCodegraph: hasFlag(args, "--skip-codegraph"),
    excludeExisting: !hasFlag(args, "--include-existing"),
    excludePaths: (argValue(args, "--exclude-paths") || "docs/product/cpb-flagship-product-validation.json,docs/product/evidence")
      .split(",")
      .map((item) => path.resolve(item.trim()))
      .filter(Boolean),
    startWorkers,
    wait: hasFlag(args, "--wait"),
    dryRun,
    rebuildReport: hasFlag(args, "--rebuild-report"),
    hubRootExplicit,
    scorerRequired: hasFlag(args, "--scorer-required"),
    scorerEvidencePath: argValue(args, "--scorer-evidence")
      ? path.resolve(String(argValue(args, "--scorer-evidence")))
      : null,
  };
}

type CommandResult = { stdout: string; stderr: string; code: number | null };
type CommandRunOptions = {
  env?: Record<string, string | undefined>;
  input?: string;
  signal?: AbortSignal;
};
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  options?: CommandRunOptions,
) => Promise<CommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  const result = await runCommandTree(command, args, {
    cwd,
    env: options.env || process.env,
    input: options.input || "",
    timeoutMs,
    signal: options.signal,
  });
  if (result.aborted) {
    throw Object.assign(
      new Error(`${command} ${args.join(" ")} aborted`),
      {
        name: "AbortError",
        code: "ABORT_ERR",
        cleanupVerified: result.cleanupVerified,
        ...(result.error ? { cause: result.error } : {}),
      },
    );
  }
  if (result.timedOut) {
    const cleanupCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    throw Object.assign(
      new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms${result.stderr ? `\n${result.stderr}` : ""}`),
      {
        code: result.cleanupVerified ? "COMMAND_TIMEOUT" : cleanupCode || "COMMAND_CLEANUP_UNVERIFIED",
        cleanupVerified: result.cleanupVerified,
        ...(result.error ? { cause: result.error } : {}),
      },
    );
  }
  if (result.error) throw result.error;
  return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
}

async function runProductionProviderProbe({
  input,
  prompt,
  repoRoot,
  timeoutMs,
  env,
  signal,
}: {
  input: ProviderPreflightPhaseInput;
  prompt: string;
  repoRoot: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<CommandResult> {
  const runtimeWorkspace = await createTemporaryWorkspace({
    prefix: "cpb-provider-live-preflight-",
    env,
  });
  const runtimeRoot = runtimeWorkspace.rootPath;
  let pool: AcpPool | null = null;
  let operationError: unknown = null;
  let result: CommandResult;
  try {
    pool = new AcpPool({
      cpbRoot: path.join(runtimeRoot, "cpb"),
      hubRoot: path.join(runtimeRoot, "hub"),
      env,
      persistentProcesses: false,
    });
    const execution = await pool.execute(input.agent, prompt, repoRoot, timeoutMs, {
      bypass: true,
      projectId: input.projectId,
      jobId: input.jobId,
      phase: input.phase,
      role: input.role,
      poolScope: "provider_live_preflight",
      controlPlane: true,
      dataRoot: path.join(runtimeRoot, "runtime"),
      env,
      signal,
    });
    result = { code: 0, stdout: stringValue(execution.output), stderr: "" };
  } catch (error) {
    operationError = error;
    result = {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
  const poolStop = pool
    ? Promise.resolve().then(() => pool?.stop())
    : Promise.resolve();
  const cleanupSteps = [
    ...(pool
      ? [{ label: "provider preflight ACP pool", run: () => poolStop }]
      : []),
    {
      label: "provider preflight runtime workspace",
      run: async () => {
        await poolStop.catch(() => undefined);
        return await runtimeWorkspace.cleanup();
      },
    },
  ];
  if (operationError !== null) {
    await runCleanupSteps(operationError, cleanupSteps);
  } else {
    await runRequiredCleanupSteps(cleanupSteps);
  }
  return result;
}

async function readAuditEvents(auditFile: string) {
  try {
    const raw = await readFile(auditFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return recordValue(JSON.parse(line));
        } catch {
          return {};
        }
      })
      .filter((event) => stringValue(event.event));
  } catch {
    return [];
  }
}

function rawAuditEventCount(raw: string) {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean).length;
}

const RAW_AUDIT_FORBIDDEN_FIELDS = new Set(["args", "env", "stdout", "stderr", "prompt", "input", "message", "rawOutput"]);

function rawAuditSecretPattern(value: string) {
  return containsSensitivePreflightOutput(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/i.test(value);
}

function containsForbiddenRawAuditKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsForbiddenRawAuditKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    RAW_AUDIT_FORBIDDEN_FIELDS.has(key)
      || /^raw/i.test(key)
      || containsForbiddenRawAuditKey(nested)
  ));
}

function strictParseRawAuditEvents(raw: string) {
  const events: LooseRecord[] = [];
  const violations: string[] = [];
  raw.split(/\r?\n/).forEach((line, lineIndex) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      violations.push(`raw audit line ${lineIndex + 1} is malformed JSON`);
      return;
    }
    if (!isRecord(parsed)) {
      violations.push(`raw audit line ${lineIndex + 1} must be an object`);
      return;
    }
    if (containsForbiddenRawAuditKey(parsed)) {
      violations.push(`raw audit line ${lineIndex + 1} contains forbidden raw provider fields`);
    }
    if (rawAuditSecretPattern(line)) {
      violations.push(`raw audit line ${lineIndex + 1} contains sensitive material`);
    }
    events.push(parsed);
  });
  return { events, violations };
}

function redactedHash(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text ? createHash("sha256").update(text).digest("hex") : null;
}

function eventTimestamp(value: LooseRecord, fallbackIndex: number) {
  const candidate = stringValue(value.ts || value.timestamp || value.time);
  if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(Date.parse(candidate)).toISOString();
  return "";
}

function eventStringValue(event: LooseRecord, keys: string[]) {
  for (const key of keys) {
    const direct = stringValue(event[key]);
    if (direct) return direct;
    const metadata = recordValue(event.metadata);
    const nested = stringValue(metadata[key]);
    if (nested) return nested;
  }
  return "";
}

function policyStringArray(value: unknown) {
  return sortedStringValues(value);
}

function projectPolicySummary(value: unknown, transport: "acp" | "claude-cli") {
  const policy = recordValue(value);
  if (transport === "acp") {
    const toolPolicy = recordValue(policy.toolPolicy);
    return {
      terminalPolicy: stringValue(policy.terminalPolicy),
      permissionRequests: stringValue(policy.permissionRequests),
      webToolsDisabled: policy.webToolsDisabled === true,
      toolPolicy: {
        allow: policyStringArray(toolPolicy.allow),
        deny: policyStringArray(toolPolicy.deny),
      },
    };
  }
  const settings = recordValue(policy.settings);
  const permissions = recordValue(settings.permissions);
  return {
    terminalPolicy: stringValue(policy.terminalPolicy),
    permissionRequests: stringValue(policy.permissionRequests),
    webToolsDisabled: policy.webToolsDisabled === true,
    tools: policyStringArray(policy.tools),
    mcpServers: policyStringArray(policy.mcpServers),
    slashCommandsDisabled: policy.slashCommandsDisabled === true,
    settings: {
      permissions: {
        allow: policyStringArray(permissions.allow),
        deny: policyStringArray(permissions.deny),
      },
      strictMcpConfig: settings.strictMcpConfig === true,
    },
  };
}

function auditEventKind(value: LooseRecord) {
  const event = stringValue(value.event);
  if (event === "agent_launch") return "launch";
  if (["session_new", "session_reuse", "session_resume"].includes(event)) return "session";
  if (event === "prompt_usage") return "prompt";
  if (event === "tool_call") return "tool";
  if (event === "terminal_launch") return "terminal";
  return "other";
}

function safeAuditProjection(event: LooseRecord, index: number, input: ProviderPreflightPhaseInput) {
  const kind = auditEventKind(event);
  const sessionValue = event.sessionId || event.session_id || event.session;
  const promptValue = event.prompt || event.input || event.message;
  const projection: LooseRecord = {
    index,
    ts: eventTimestamp(event, index),
    event: stringValue(event.event, "unknown"),
    kind,
  };
  if (stringValue(event.agent)) projection.agent = stringValue(event.agent);
  if (stringValue(event.phase)) projection.phase = stringValue(event.phase);
  if (stringValue(event.role)) projection.role = stringValue(event.role);
  const projectId = eventStringValue(event, ["projectId", "project_id", "project", "CPB_ACP_PROJECT"]);
  const jobId = eventStringValue(event, ["jobId", "job_id", "CPB_ACP_JOB_ID"]);
  const nonce = eventStringValue(event, ["correlationNonce", "correlation_nonce", "CPB_PROVIDER_PREFLIGHT_NONCE"]);
  if (projectId) projection.projectId = projectId;
  if (jobId) projection.jobId = jobId;
  if (nonce) projection.correlationNonce = nonce;
  const sessionHash = redactedHash(sessionValue);
  if (sessionHash) projection.sessionHash = sessionHash;
  const promptHash = redactedHash(promptValue);
  if (promptHash) projection.promptHash = promptHash;
  if (kind === "tool") projection.toolName = stringValue(event.tool || event.toolName || event.name, "unknown");
  if (kind === "terminal") projection.terminalIdHash = redactedHash(event.terminalId || event.terminal_id || event.id);
  if (kind === "launch" && isRecord(event.livePreflightPolicy)) {
    projection.policySummary = projectPolicySummary(event.livePreflightPolicy, input.transport);
  }
  return projection;
}

function buildControlPlaneEvidenceFromAuditProjection(projections: LooseRecord[], input: ProviderPreflightPhaseInput) {
  const sameJob = (event: LooseRecord) => event.agent === input.agent
    && event.phase === input.phase
    && event.role === input.role
    && event.projectId === input.projectId
    && event.jobId === input.jobId
    && event.correlationNonce === input.correlationNonce;
  const launch = projections.find((event) => event.event === "agent_launch" && sameJob(event));
  const session = projections.find((event) => ["session_new", "session_reuse", "session_resume", "prompt_usage"].includes(stringValue(event.event)) && sameJob(event));
  const toolCallCount = projections.filter((event) => event.event === "tool_call" && sameJob(event)).length;
  const terminalLaunchCount = projections.filter((event) => event.event === "terminal_launch" && sameJob(event)).length;
  const policySummary = recordValue(launch?.policySummary);
  const evidence = {
    transport: input.transport,
    phase: input.phase,
    role: input.role,
    agent: input.agent,
    providerKey: input.providerKey,
    agentLaunchObserved: Boolean(launch),
    sessionObserved: Boolean(session),
    policyVerified: controlPlaneEvidenceValid({
      transport: input.transport,
      phase: input.phase,
      role: input.role,
      agent: input.agent,
      providerKey: input.providerKey,
      agentLaunchObserved: Boolean(launch),
      sessionObserved: Boolean(session),
      policyVerified: true,
      toolCallCount,
      terminalLaunchCount,
      policySummary,
    }, input),
    toolCallCount,
    terminalLaunchCount,
    policySummary,
  };
  return evidence;
}

function buildControlPlaneEvidenceFromAudit(events: LooseRecord[], input: ProviderPreflightPhaseInput) {
  const evidence = buildControlPlaneEvidenceFromAuditProjection(
    events.map((event, index) => safeAuditProjection(event, index, input)),
    input,
  );
  return {
    evidence,
    sha256: stableJsonSha256(evidence),
  };
}

function assertClosedKeys(value: LooseRecord, allowed: Set<string>) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

type PreflightArtifactContext = {
  outputPath: string;
  artifactBaseDir?: string;
  artifactPathRewrite?: { from: string; to: string };
};

function resolvePreflightArtifactPath(value: string, context: PreflightArtifactContext) {
  const rewrite = context.artifactPathRewrite;
  if (rewrite && !path.isAbsolute(value) && value.startsWith(`${rewrite.from}/`)) {
    return path.resolve(
      stringValue(context.artifactBaseDir, process.cwd()),
      rewrite.to,
      value.slice(rewrite.from.length + 1),
    );
  }
  return path.isAbsolute(value)
    ? value
    : path.resolve(stringValue(context.artifactBaseDir, process.cwd()), value);
}

function readContainedRegularArtifact(
  artifactPath: string,
  context: PreflightArtifactContext,
  label: string,
) {
  if (!artifactPath) throw new Error(`${label} path is missing`);
  const resolvedPath = resolvePreflightArtifactPath(artifactPath, context);
  const outputResolvedPath = resolvePreflightArtifactPath(context.outputPath, context);
  const rootPath = stringValue(context.artifactBaseDir)
    ? path.resolve(stringValue(context.artifactBaseDir))
    : path.dirname(outputResolvedPath);
  // Platform aliases such as macOS `/tmp -> /private/tmp` are valid roots.
  // Confinement is enforced against the canonical root below, while the
  // artifact itself must still be a non-symlink regular file.
  const rootReal = realpathSync(rootPath);
  const rootEntry = lstatSync(rootReal);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(`${label} root must resolve to an ordinary directory`);
  }
  const entry = lstatSync(resolvedPath);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  const fileReal = realpathSync(resolvedPath);
  const relative = path.relative(rootReal, fileReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the artifact root`);
  }
  return { raw: readFileSync(fileReal), resolvedPath: fileReal };
}

const CONTROL_PLANE_AUDIT_FIELDS = new Set([
  "schemaVersion",
  "generator",
  "generatedAt",
  "nonce",
  "jobIdentity",
  "route",
  "rawStream",
  "events",
  "summary",
  "summarySha256",
]);

const CONTROL_PLANE_AUDIT_REF_FIELDS = new Set(["path", "bytes", "sha256", "rawPath", "rawBytes", "rawSha256", "summarySha256"]);
const CONTROL_PLANE_AUDIT_ROUTE_FIELDS = new Set(["phase", "role", "agent", "providerKey", "transport", "command"]);
const CONTROL_PLANE_AUDIT_JOB_FIELDS = new Set([
  "projectId",
  "jobId",
  "correlationNonce",
  "outputPathSha256",
  "promptSha256",
  "sentinelSha256",
]);
const CONTROL_PLANE_AUDIT_RAW_FIELDS = new Set(["path", "bytes", "sha256", "eventCount"]);
const CONTROL_PLANE_AUDIT_EVENT_FIELDS = new Set([
  "index",
  "ts",
  "event",
  "kind",
  "agent",
  "phase",
  "role",
  "projectId",
  "jobId",
  "correlationNonce",
  "sessionHash",
  "promptHash",
  "toolName",
  "terminalIdHash",
  "policySummary",
]);

function auditArtifactValidationViolations(
  artifact: unknown,
  expected: ProviderPreflightPhaseInput,
  expectedSummary: unknown,
  rawAuditPath: string,
) {
  const violations: string[] = [];
  if (!isRecord(artifact)) return ["control-plane audit artifact must be a JSON object"];
  if (assertClosedKeys(artifact, CONTROL_PLANE_AUDIT_FIELDS).length > 0) {
    violations.push("control-plane audit artifact schema is not closed");
  }
  if (artifact.schemaVersion !== 1) violations.push("control-plane audit artifact schemaVersion must be 1");
  if (artifact.generator !== CONTROL_PLANE_AUDIT_GENERATOR) violations.push("control-plane audit artifact generator is invalid");
  if (!/^[a-f0-9]{32}$/.test(stringValue(artifact.nonce)) || artifact.nonce !== expected.correlationNonce) {
    violations.push("control-plane audit artifact nonce is invalid");
  }
  const route = recordValue(artifact.route);
  if (assertClosedKeys(route, CONTROL_PLANE_AUDIT_ROUTE_FIELDS).length > 0) {
    violations.push("control-plane audit artifact route schema is not closed");
  }
  for (const key of ["phase", "role", "agent", "providerKey", "transport"]) {
    if (route[key] !== expected[key as keyof ProviderPreflightPhaseInput]) {
      violations.push(`control-plane audit artifact route ${key} does not match handshake`);
    }
  }
  if (stringValue(expected.command) && route.command !== expected.command) {
    violations.push("control-plane audit artifact route command does not match handshake");
  }
  const jobIdentity = recordValue(artifact.jobIdentity);
  if (assertClosedKeys(jobIdentity, CONTROL_PLANE_AUDIT_JOB_FIELDS).length > 0) {
    violations.push("control-plane audit artifact job identity schema is not closed");
  }
  if (jobIdentity.projectId !== expected.projectId
    || jobIdentity.jobId !== expected.jobId
    || jobIdentity.correlationNonce !== expected.correlationNonce
    || !/^[a-f0-9]{32}$/.test(stringValue(jobIdentity.correlationNonce))
    || jobIdentity.promptSha256 !== createHash("sha256").update(liveProviderPreflightPrompt()).digest("hex")
    || jobIdentity.sentinelSha256 !== createHash("sha256").update(LIVE_PROVIDER_PREFLIGHT_SENTINEL).digest("hex")
    || !stringValue(expected.outputPath)
    || jobIdentity.outputPathSha256 !== createHash("sha256").update(stringValue(expected.outputPath)).digest("hex")) {
    violations.push("control-plane audit artifact job identity is incomplete");
  }
  const rawStream = recordValue(artifact.rawStream);
  if (assertClosedKeys(rawStream, CONTROL_PLANE_AUDIT_RAW_FIELDS).length > 0) {
    violations.push("control-plane audit artifact raw stream schema is not closed");
  }
  if (!stringValue(rawStream.path) || numericValue(rawStream.bytes) <= 0 || !/^[a-f0-9]{64}$/.test(stringValue(rawStream.sha256))) {
    violations.push("control-plane audit artifact raw stream binding is invalid");
  }
  const events = arrayValue(artifact.events).map(recordValue);
  if (events.length !== numericValue(rawStream.eventCount) || events.length === 0) {
    violations.push("control-plane audit artifact event count does not match raw stream");
  }
  let previousMs = -Infinity;
  let launchMs = Number.POSITIVE_INFINITY;
  let sessionOrPromptObserved = false;
  const observedSessionHashes = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (assertClosedKeys(event, CONTROL_PLANE_AUDIT_EVENT_FIELDS).length > 0) {
      violations.push("control-plane audit artifact event projection schema is not closed");
    }
    if (event.index !== index) violations.push("control-plane audit artifact event index sequence is invalid");
    for (const key of ["phase", "role", "agent", "projectId", "jobId", "correlationNonce"]) {
      const expectedValue = key === "projectId" ? expected.projectId
        : key === "jobId" ? expected.jobId
          : key === "correlationNonce" ? expected.correlationNonce
            : expected[key as keyof ProviderPreflightPhaseInput];
      if (event[key] !== expectedValue) {
        violations.push(`control-plane audit artifact event ${key} does not match job route`);
      }
    }
    const eventMs = Date.parse(stringValue(event.ts));
    if (!Number.isFinite(eventMs) || eventMs < previousMs) {
      violations.push("control-plane audit artifact event timestamps are invalid or out of order");
    }
    if (event.kind === "launch") launchMs = Math.min(launchMs, eventMs);
    if (event.kind === "session" || event.kind === "prompt") {
      sessionOrPromptObserved = true;
      const sessionHash = stringValue(event.sessionHash);
      if (!sessionHash) {
        violations.push("control-plane audit artifact session hash is missing");
      } else {
        observedSessionHashes.add(sessionHash);
      }
      if (!Number.isFinite(eventMs) || eventMs <= launchMs) {
        violations.push("control-plane audit artifact session or prompt event did not follow launch");
      }
    }
    previousMs = eventMs;
  }
  if (!Number.isFinite(launchMs) || !sessionOrPromptObserved) {
    violations.push("control-plane audit artifact launch/session correlation is incomplete");
  }
  if (observedSessionHashes.size > 1) {
    violations.push("control-plane audit artifact session continuity is inconsistent");
  }
  let rawProjections: LooseRecord[] = [];
  try {
    const raw = readFileSync(rawAuditPath);
    if (raw.byteLength !== numericValue(rawStream.bytes)
      || createHash("sha256").update(raw).digest("hex") !== stringValue(rawStream.sha256)) {
      violations.push("control-plane audit artifact raw stream bytes or hash do not match");
    }
    const parsedRaw = strictParseRawAuditEvents(raw.toString("utf8"));
    violations.push(...parsedRaw.violations);
    rawProjections = parsedRaw.events.map((event, index) => safeAuditProjection(event, index, expected));
    if (!stableJsonEqual(rawProjections, events)) {
      violations.push("control-plane audit artifact projection does not match raw audit replay");
    }
  } catch {
    violations.push("control-plane audit artifact raw stream could not be read and replayed");
  }
  const recomputedSummary = buildControlPlaneEvidenceFromAuditProjection(rawProjections, expected);
  if (!stableJsonEqual(recomputedSummary, expectedSummary)
    || !stableJsonEqual(artifact.summary, expectedSummary)
    || artifact.summarySha256 !== stableJsonSha256(recomputedSummary)) {
    violations.push("control-plane audit artifact summary is not independently reproducible");
  }
  return Array.from(new Set(violations));
}

export function controlPlaneAuditReferenceValid(refValue: unknown, expectedSummary: unknown, expected: {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  transport: "acp" | "claude-cli";
  command?: string;
  projectId?: string;
  jobId?: string;
  correlationNonce?: string;
  outputPath: string;
  outputBytes?: number;
  outputSha256?: string;
  outputContent?: unknown;
  artifactBaseDir?: string;
  artifactPathRewrite?: { from: string; to: string };
}) {
  const violations: string[] = [];
  if (!isRecord(refValue)) return { valid: false, violations: ["control-plane audit artifact reference is missing"] };
  if (assertClosedKeys(refValue, CONTROL_PLANE_AUDIT_REF_FIELDS).length > 0) {
    violations.push("control-plane audit artifact reference schema is not closed");
  }
  const artifactPath = stringValue(refValue.path);
  const expectedBytes = numericValue(refValue.bytes);
  const expectedSha = stringValue(refValue.sha256);
  const expectedRawPath = stringValue(refValue.rawPath);
  const expectedRawBytes = numericValue(refValue.rawBytes);
  const expectedRawSha = stringValue(refValue.rawSha256);
  const expectedSummarySha = stringValue(refValue.summarySha256);
  if (!stringValue(expected.outputPath)
    || !artifactPath
    || !expectedRawPath
    || expectedBytes <= 0
    || expectedRawBytes <= 0
    || !/^[a-f0-9]{64}$/.test(expectedSha)
    || !/^[a-f0-9]{64}$/.test(expectedRawSha)
    || expectedSummarySha !== stableJsonSha256(expectedSummary)) {
    return { valid: false, violations: ["control-plane audit artifact reference binding is invalid"] };
  }
  try {
    const artifactContext: PreflightArtifactContext = {
      outputPath: expected.outputPath,
      artifactBaseDir: expected.artifactBaseDir,
      artifactPathRewrite: expected.artifactPathRewrite,
    };
    const auditFile = readContainedRegularArtifact(
      artifactPath,
      artifactContext,
      "control-plane audit artifact",
    );
    const raw = auditFile.raw;
    if (raw.byteLength !== expectedBytes || createHash("sha256").update(raw).digest("hex") !== expectedSha) {
      return { valid: false, violations: ["control-plane audit artifact bytes or hash do not match"] };
    }
    const rawFile = readContainedRegularArtifact(
      expectedRawPath,
      artifactContext,
      "control-plane raw audit stream",
    );
    const rawAudit = rawFile.raw;
    if (rawAudit.byteLength !== expectedRawBytes || createHash("sha256").update(rawAudit).digest("hex") !== expectedRawSha) {
      return { valid: false, violations: ["control-plane raw audit stream bytes or hash do not match"] };
    }
    const outputIdentitySupplied = expected.outputBytes !== undefined
      || expected.outputSha256 !== undefined
      || expected.outputContent !== undefined;
    if (outputIdentitySupplied) {
      const outputBytes = numericValue(expected.outputBytes);
      const outputSha256 = stringValue(expected.outputSha256);
      if (outputBytes <= 0 || !/^[a-f0-9]{64}$/.test(outputSha256) || expected.outputContent === undefined) {
        violations.push("provider preflight output artifact reference binding is invalid");
      } else {
        const outputFile = readContainedRegularArtifact(
          expected.outputPath,
          artifactContext,
          "provider preflight output artifact",
        );
        if (outputFile.raw.byteLength !== outputBytes
          || createHash("sha256").update(outputFile.raw).digest("hex") !== outputSha256) {
          violations.push("provider preflight output artifact bytes or hash do not match");
        }
        const outputValue = JSON.parse(outputFile.raw.toString("utf8")) as unknown;
        if (!stableJsonEqual(outputValue, expected.outputContent)) {
          violations.push("provider preflight output artifact does not match retained handshake");
        }
      }
    }
    const artifact = JSON.parse(raw.toString("utf8")) as unknown;
    const artifactRecord = recordValue(artifact);
    const rawStream = recordValue(artifactRecord.rawStream);
    if (rawStream.path !== path.basename(expectedRawPath)
      || numericValue(rawStream.bytes) !== expectedRawBytes
      || stringValue(rawStream.sha256) !== expectedRawSha) {
      violations.push("control-plane audit artifact raw stream binding does not match handshake reference");
    }
    violations.push(...auditArtifactValidationViolations(artifact, {
      phase: expected.phase,
      role: expected.role,
      agent: expected.agent,
      providerKey: expected.providerKey,
      transport: expected.transport,
      command: stringValue(expected.command),
      projectId: stringValue(expected.projectId),
      jobId: stringValue(expected.jobId),
      correlationNonce: stringValue(expected.correlationNonce),
      artifactBaseDir: expected.artifactBaseDir,
      artifactPathRewrite: expected.artifactPathRewrite,
      args: [],
      outputPath: expected.outputPath,
      env: {},
      denyRules: [],
    }, expectedSummary, rawFile.resolvedPath));
  } catch (error) {
    violations.push(error instanceof Error
      ? error.message
      : "control-plane audit artifact could not be read and replayed");
  }
  return { valid: violations.length === 0, violations };
}

export async function writeControlPlaneAuditArtifact({
  auditFile,
  events,
  input,
  outputPath,
  signal,
  retentionStageHook,
  remove = rm,
}: {
  auditFile: string;
  events: LooseRecord[];
  input: ProviderPreflightPhaseInput;
  outputPath: string;
  signal?: AbortSignal;
  retentionStageHook?: (stage: "afterRawArtifactWrite" | "afterAuditArtifactWrite") => void | Promise<void>;
  remove?: CleanupRemove;
}) {
  const auditDirectory = path.join(path.dirname(outputPath), "control-plane-audit");
  const rawArtifactPath = path.join(
    auditDirectory,
    `${safeId(input.phase)}-${safeId(input.agent)}-${input.correlationNonce}.raw.jsonl`,
  );
  const artifactPath = path.join(
    auditDirectory,
    `${safeId(input.phase)}-${safeId(input.agent)}-${input.correlationNonce}.json`,
  );
  try {
    throwIfAborted(signal, "provider live preflight aborted before audit artifact retention");
    const raw = await readFile(auditFile, "utf8").catch(() => "");
    throwIfAborted(signal, "provider live preflight aborted before audit artifact projection");
    const projections = events.map((event, index) => safeAuditProjection(event, index, input));
    const summary = buildControlPlaneEvidenceFromAuditProjection(projections, input);
    await mkdir(auditDirectory, { recursive: true });
    throwIfAborted(signal, "provider live preflight aborted before raw audit artifact write");
    await writeFile(rawArtifactPath, raw, "utf8");
    await retentionStageHook?.("afterRawArtifactWrite");
    throwIfAborted(signal, "provider live preflight aborted after raw audit artifact write");
    const rawArtifact = await readFile(rawArtifactPath);
    const artifact = {
      schemaVersion: 1,
      generator: CONTROL_PLANE_AUDIT_GENERATOR,
      generatedAt: new Date().toISOString(),
      nonce: input.correlationNonce,
      jobIdentity: {
        projectId: input.projectId,
        jobId: input.jobId,
        correlationNonce: input.correlationNonce,
        outputPathSha256: createHash("sha256").update(outputPath).digest("hex"),
        promptSha256: createHash("sha256").update(liveProviderPreflightPrompt()).digest("hex"),
        sentinelSha256: createHash("sha256").update(LIVE_PROVIDER_PREFLIGHT_SENTINEL).digest("hex"),
      },
      route: {
        phase: input.phase,
        role: input.role,
        agent: input.agent,
        providerKey: input.providerKey,
        transport: input.transport,
        command: input.command,
      },
      rawStream: {
        path: path.basename(rawArtifactPath),
        bytes: rawArtifact.byteLength,
        sha256: createHash("sha256").update(rawArtifact).digest("hex"),
        eventCount: rawAuditEventCount(raw),
      },
      events: projections,
      summary,
      summarySha256: stableJsonSha256(summary),
    };
    throwIfAborted(signal, "provider live preflight aborted before audit artifact write");
    await writeJsonAtomic(artifactPath, artifact);
    await retentionStageHook?.("afterAuditArtifactWrite");
    throwIfAborted(signal, "provider live preflight aborted after audit artifact write");
    const artifactRaw = await readFile(artifactPath);
    return {
      path: artifactPath,
      bytes: artifactRaw.byteLength,
      sha256: createHash("sha256").update(artifactRaw).digest("hex"),
      rawPath: rawArtifactPath,
      rawBytes: rawArtifact.byteLength,
      rawSha256: createHash("sha256").update(rawArtifact).digest("hex"),
      summarySha256: stableJsonSha256(summary),
      summary,
    };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      await runCleanupSteps(error, [
        { label: "control-plane audit artifact", run: () => remove(artifactPath, { force: true }) },
        { label: "control-plane raw audit artifact", run: () => remove(rawArtifactPath, { force: true }) },
      ]);
    }
    throw error;
  }
}

export async function liveProviderPreflightHandshake(
  rawInput: ProviderPreflightPhaseInput,
  {
    repoRoot = REPO_ROOT,
    distRoot = DIST_ROOT,
    timeoutMs = Number(process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS || DEFAULT_LIVE_PROVIDER_PREFLIGHT_TIMEOUT_MS),
    runner = null,
    signal = rawInput.signal,
    remove = rm,
    stageHook,
  }: {
    repoRoot?: string;
    distRoot?: string;
    timeoutMs?: number;
    runner?: CommandRunner | null;
    signal?: AbortSignal;
    remove?: CleanupRemove;
    stageHook?: (stage: "afterAuditRetention" | "afterOutputWrite") => void | Promise<void>;
  } = {},
) {
  throwIfAborted(signal, "provider live preflight aborted before start");
  const normalizedNonce = stringValue(rawInput.correlationNonce, randomBytes(16).toString("hex"));
  const input: ProviderPreflightPhaseInput & { correlationNonce: string; projectId: string; jobId: string } = {
    ...rawInput,
    correlationNonce: normalizedNonce,
    projectId: stringValue(rawInput.projectId, "cpb-provider-live-preflight"),
    jobId: stringValue(
      rawInput.jobId,
      `provider-preflight-${safeId(rawInput.role)}-${safeId(rawInput.agent)}-${normalizedNonce}`,
    ),
  };
  const acpClient = path.join(distRoot, "server", "services", "acp", "acp-client.js");
  const auditWorkspace = await createTemporaryWorkspace({
    prefix: "cpb-provider-live-preflight-audit-",
  });
  const auditRoot = auditWorkspace.rootPath;
  const auditFile = path.join(auditRoot, "audit.jsonl");
  const prompt = liveProviderPreflightPrompt();
  const env = {
    ...process.env,
    ...stringEnvRecord(input.env),
    CPB_ACP_TERMINAL: "deny",
    CPB_ACP_PERMISSION: "reject",
    CPB_ACP_DISABLE_WEB_TOOLS: "1",
    CPB_ACP_AUDIT_FILE: auditFile,
    CPB_ACP_PROJECT: input.projectId,
    CPB_ACP_JOB_ID: input.jobId,
    CPB_ACP_PHASE: input.phase,
    CPB_ACP_ROLE: input.role,
    CPB_PROVIDER_PREFLIGHT_NONCE: input.correlationNonce,
    CPB_ACP_DENY_TOOLS: REQUIRED_ACP_PREFLIGHT_DENY_TOOLS.join(","),
    CPB_ACP_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_IDLE_TIMEOUT_MS: String(timeoutMs),
  };
  let outputWritten = false;
  let retainedAuditArtifacts: { path: string; rawPath: string } | null = null;
  let success = false;
  try {
    throwIfAborted(signal, "provider live preflight aborted before launch");
    const result = runner
      ? await runner(process.execPath, [
        acpClient,
        "--agent",
        input.agent,
        "--cwd",
        repoRoot,
      ], repoRoot, timeoutMs, {
        env,
        input: prompt,
        signal,
      })
      : await runProductionProviderProbe({ input, prompt, repoRoot, timeoutMs, env, signal });
    throwIfAborted(signal, "provider live preflight aborted after probe");
    const stdout = result.stdout.trim();
    const sensitiveStderr = containsSensitivePreflightOutput(result.stderr);
    const auditEvents = await readAuditEvents(auditFile);
    throwIfAborted(signal, "provider live preflight aborted before audit retention");
    const controlPlane = buildControlPlaneEvidenceFromAudit(auditEvents, input);
    const controlPlaneAudit = await writeControlPlaneAuditArtifact({
      auditFile,
      events: auditEvents,
      input,
      outputPath: input.outputPath,
      signal,
      remove,
    });
    retainedAuditArtifacts = { path: controlPlaneAudit.path, rawPath: controlPlaneAudit.rawPath };
    await stageHook?.("afterAuditRetention");
    throwIfAborted(signal, "provider live preflight aborted after audit retention");
    const controlPlaneAuditRef = {
      path: controlPlaneAudit.path,
      bytes: controlPlaneAudit.bytes,
      sha256: controlPlaneAudit.sha256,
      rawPath: controlPlaneAudit.rawPath,
      rawBytes: controlPlaneAudit.rawBytes,
      rawSha256: controlPlaneAudit.rawSha256,
      summarySha256: controlPlaneAudit.summarySha256,
    };
    const sentinelVerified = stdout === LIVE_PROVIDER_PREFLIGHT_SENTINEL;
    const controlPlaneVerified = controlPlaneEvidenceValid(controlPlane.evidence, input)
      && controlPlane.sha256 === stableJsonSha256(controlPlane.evidence)
      && controlPlaneAuditReferenceValid(controlPlaneAuditRef, controlPlane.evidence, {
        phase: input.phase,
        role: input.role,
        agent: input.agent,
        providerKey: input.providerKey,
        transport: input.transport,
        command: input.command,
        projectId: input.projectId,
        jobId: input.jobId,
        correlationNonce: input.correlationNonce,
        outputPath: input.outputPath,
        artifactBaseDir: input.artifactBaseDir || path.dirname(input.outputPath),
      }).valid;
    const ok = result.code === 0
      && sentinelVerified
      && !sensitiveStderr
      && controlPlaneVerified;
    const failureKind = ok ? null : livePreflightFailureKind(`${result.stderr}\n${result.stdout}`);
    const failureReason = ok
      ? null
      : sensitiveStderr
        ? "provider emitted sensitive stderr; redacted"
        : result.code !== 0 || !sentinelVerified
          ? sanitizeLivePreflightReason(
            result.code === 0 && !sentinelVerified
              ? `unexpected preflight sentinel: ${stdout || "(empty)"}`
              : result.stderr || result.stdout || `exited ${result.code}`,
          )
          : "provider control-plane safety proof is missing or invalid";
    const output = {
      ok,
      mode: "live",
      generator: LIVE_HANDSHAKE_GENERATOR,
      sentinelVerified,
      phase: input.phase,
      role: input.role,
      agent: input.agent,
      providerKey: input.providerKey,
      transport: input.transport,
      command: input.command,
      projectId: input.projectId,
      jobId: input.jobId,
      correlationNonce: input.correlationNonce,
      controlPlaneEvidence: controlPlane.evidence,
      controlPlaneEvidenceSha256: controlPlane.sha256,
      controlPlaneAudit: controlPlaneAuditRef,
      ...(failureKind ? { failureKind } : {}),
      ...(failureReason ? { error: failureReason } : {}),
    };
    throwIfAborted(signal, "provider live preflight aborted before output retention");
    await mkdir(path.dirname(input.outputPath), { recursive: true });
    throwIfAborted(signal, "provider live preflight aborted before output write");
    await writeJsonAtomic(input.outputPath, output);
    outputWritten = true;
    await stageHook?.("afterOutputWrite");
    throwIfAborted(signal, "provider live preflight aborted after output write");
    const outputFile = readContainedRegularArtifact(input.outputPath, {
      outputPath: input.outputPath,
      artifactBaseDir: input.artifactBaseDir || path.dirname(input.outputPath),
    }, "provider preflight output artifact");
    const outputValue = JSON.parse(outputFile.raw.toString("utf8")) as unknown;
    if (!stableJsonEqual(outputValue, output)) {
      throw new Error("provider preflight output artifact does not match retained handshake");
    }
    if (controlPlaneVerified && !controlPlaneAuditReferenceValid(controlPlaneAuditRef, controlPlane.evidence, {
      phase: input.phase,
      role: input.role,
      agent: input.agent,
      providerKey: input.providerKey,
      transport: input.transport,
      command: input.command,
      projectId: input.projectId,
      jobId: input.jobId,
      correlationNonce: input.correlationNonce,
      outputPath: input.outputPath,
      outputBytes: outputFile.raw.byteLength,
      outputSha256: createHash("sha256").update(outputFile.raw).digest("hex"),
      outputContent: output,
      artifactBaseDir: input.artifactBaseDir || path.dirname(input.outputPath),
    }).valid) {
      throw new Error("provider preflight output artifact binding could not be verified");
    }
    success = true;
    return output;
  } catch (error) {
    await runCleanupSteps(error, [
      ...(retainedAuditArtifacts?.path
        ? [{ label: "retained control-plane audit artifact", run: () => remove(retainedAuditArtifacts.path, { force: true }) }]
        : []),
      ...(retainedAuditArtifacts?.rawPath
        ? [{ label: "retained raw control-plane audit artifact", run: () => remove(retainedAuditArtifacts.rawPath, { force: true }) }]
        : []),
      ...(outputWritten && !success
        ? [{ label: "provider preflight output artifact", run: () => remove(input.outputPath, { force: true }) }]
        : []),
      { label: "provider preflight temporary audit workspace", run: () => auditWorkspace.cleanup() },
    ]);
    throw error;
  } finally {
    if (success) {
      await runRequiredCleanupSteps([
        { label: "provider preflight temporary audit workspace", run: () => auditWorkspace.cleanup() },
      ]);
    }
  }
}

function containsSensitivePreflightOutput(text: string) {
  return /\b(?:authorization|api[_-]?key|auth[_-]?token|access[_-]?token|secret)\b\s*[:=]\s*\S+/i.test(text)
    || /\bbearer\s+\S+/i.test(text);
}

function sanitizeLivePreflightReason(text: string) {
  const compact = text
    .replace(/\bauthorization\b\s*[:=]\s*(?:bearer\s+)?\S+/gi, "Authorization: [redacted]")
    .replace(/\b(?:api[_-]?key|auth[_-]?token|access[_-]?token|secret)\b\s*[:=]\s*\S+/gi, "[redacted-sensitive-field]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/gi, "[redacted-token]")
    .replace(/\bbearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_./+=-]{32,}/g, "[redacted-long-token]")
    .replace(/\s+/g, " ")
    .trim();
  return compact.slice(0, 300) || "provider_unavailable";
}

function livePreflightFailureKind(text: string) {
  if (/\b(?:429|529)\b|rate.?limit|usage limit|使用上限|限额|quota/i.test(text)) {
    return "agent_rate_limited";
  }
  if (/unauthorized|invalid api key|invalid token|authentication failed|forbidden/i.test(text)) {
    return "agent_unavailable";
  }
  return "provider_unavailable";
}

async function runRequired(command: string, args: string[], cwd: string, timeoutMs?: number, signal?: AbortSignal) {
  const result = await runCommand(command, args, cwd, timeoutMs, { signal });
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function delay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortErrorForSignal(signal) : batchAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function scopedProcessPids(
  scopePaths: string[],
  {
    currentPid = process.pid,
    processTable,
  }: {
    currentPid?: number;
    processTable?: string;
  } = {},
) {
  if (process.platform === "win32") throw new Error("residual_scan_unsupported_platform");
  const scopes = [...new Set(scopePaths.filter((scope) => path.isAbsolute(scope) && scope.length > 1))];
  if (scopes.length === 0) return [];
  let table = processTable;
  if (table === undefined) {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("residual_scan_process_table_unavailable");
    }
    table = result.stdout;
  }

  const processes: Array<{ pid: number; ppid: number; command: string }> = [];
  const parentByPid = new Map<number, number>();
  for (const line of table.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    processes.push({ pid, ppid, command: match[3] });
    parentByPid.set(pid, ppid);
  }

  const protectedPids = new Set<number>();
  let protectedPid = currentPid;
  while (Number.isSafeInteger(protectedPid) && protectedPid > 0 && !protectedPids.has(protectedPid)) {
    protectedPids.add(protectedPid);
    protectedPid = parentByPid.get(protectedPid) ?? 0;
  }

  return processes
    .filter(({ pid, command }) => (
      !protectedPids.has(pid)
      && scopes.some((scope) => command.includes(scope))
    ))
    .map(({ pid }) => pid);
}

type DiscoveredProcess = number | ProcessIdentity;

function processIdentityLike(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<ProcessIdentity>;
  const capturedAt = typeof identity.capturedAt === "string" ? identity.capturedAt : "";
  const capturedAtMs = Date.parse(capturedAt);
  return Number.isSafeInteger(identity.pid)
    && Number(identity.pid) > 0
    && typeof identity.birthId === "string"
    && identity.birthId.length > 0
    && typeof identity.incarnation === "string"
    && identity.incarnation.length > 0
    && Number.isFinite(capturedAtMs)
    && new Date(capturedAtMs).toISOString() === capturedAt
    && identity.incarnation === `${identity.pid}:${identity.birthId}`
    && identity.birthIdPrecision === "exact"
    && (identity.processGroupId === undefined
      || (Number.isSafeInteger(identity.processGroupId) && Number(identity.processGroupId) > 0));
}

export async function stopStartedWorkers(
  workers: StartedWorker[],
  {
    reason = "batch_wait_completed",
    graceMs = 5_000,
    forceVerifyMs = 1_000,
    discoverResidualPids,
    captureIdentity = (pid) => captureProcessIdentity(pid, { strict: true }),
    identityAlive = (identity) => isProcessIdentityAlive(identity),
    killTreeFn = killTree,
  }: {
    reason?: string;
    graceMs?: number;
    forceVerifyMs?: number;
    discoverResidualPids?: () => DiscoveredProcess[];
    captureIdentity?: (pid: number) => ProcessIdentity | null;
    identityAlive?: (identity: ProcessIdentity) => boolean;
    killTreeFn?: (pid: number, graceMs?: number, options?: KillTreeOptions) => Promise<void>;
  } = {},
): Promise<WorkerCleanupEvidence> {
  const invalidWorkers = workers.filter((worker) => (
    worker.pid !== null
    && worker.pid !== undefined
    && (!Number.isSafeInteger(worker.pid) || Number(worker.pid) <= 0)
  ));
  const trackedWorkers = workers.filter((worker): worker is StartedWorker & { pid: number } => (
    Number.isSafeInteger(worker.pid) && Number(worker.pid) > 0
  ));
  const cleanup: WorkerCleanupEvidence = {
    ...emptyWorkerCleanupEvidence(),
    reasons: reason ? [reason] : [],
    workerIds: trackedWorkers.map((worker) => worker.workerId),
    pids: [],
  };
  const identities = new Map<string, ProcessIdentity>();
  const attempted = new Set<string>();
  const unresolved = new Set<string>();
  const spawnedPids = new Set(trackedWorkers.map((worker) => worker.pid));
  const unownedSpawnPids = new Set<number>();
  const markFailure = (failure: string) => {
    cleanup.residualScanOk = false;
    cleanup.residualScanFailures = [...new Set([...cleanup.residualScanFailures, failure])];
  };
  for (const worker of invalidWorkers) {
    unresolved.add(`worker:${worker.workerId}:invalid-pid`);
    markFailure("worker_pid_invalid");
  }
  const addIdentity = (identity: ProcessIdentity, failure = "process_identity_invalid") => {
    if (!processIdentityLike(identity) || identity.pid === process.pid) {
      markFailure(failure);
      if (Number.isSafeInteger(identity?.pid) && Number(identity.pid) > 0) unresolved.add(`pid:${identity.pid}`);
      return;
    }
    identities.set(identity.incarnation, identity);
  };

  for (const worker of trackedWorkers) {
    if (!worker.processIdentity || !processIdentityLike(worker.processIdentity)) {
      unownedSpawnPids.add(worker.pid);
      unresolved.add(`pid:${worker.pid}`);
      markFailure(worker.processIdentity ? "process_identity_invalid" : "process_identity_unavailable");
      continue;
    }
    if (worker.processIdentity.pid !== worker.pid) {
      unownedSpawnPids.add(worker.pid);
      unresolved.add(`pid:${worker.pid}`);
      markFailure("process_identity_mismatch");
      continue;
    }
    addIdentity(worker.processIdentity);
  }

  const scan = () => {
    if (!discoverResidualPids) {
      markFailure("scoped_residual_scan_unconfigured");
      return;
    }
    let discovered: DiscoveredProcess[];
    try {
      discovered = discoverResidualPids();
    } catch {
      markFailure("scoped_residual_scan_failed");
      return;
    }
    for (const value of discovered) {
      if (processIdentityLike(value)) {
        if (spawnedPids.has(value.pid)) {
          const capturedAtSpawn = [...identities.values()].find((identity) => identity.pid === value.pid);
          if (!capturedAtSpawn || capturedAtSpawn.incarnation !== value.incarnation) {
            unresolved.add(`pid:${value.pid}`);
            markFailure("residual_spawn_identity_mismatch");
            continue;
          }
        }
        addIdentity(value, "residual_identity_invalid");
        continue;
      }
      if (!Number.isSafeInteger(value) || Number(value) <= 0 || value === process.pid) {
        markFailure("residual_identity_invalid");
        continue;
      }
      if (spawnedPids.has(Number(value))) {
        if (unownedSpawnPids.has(Number(value))) {
          unresolved.add(`pid:${value}`);
          markFailure("residual_spawn_identity_unowned");
        }
        continue;
      }
      try {
        const identity = captureIdentity(Number(value));
        if (identity) addIdentity(identity, "residual_identity_invalid");
        else {
          unresolved.add(`pid:${value}`);
          markFailure("residual_identity_unavailable");
        }
      } catch {
        unresolved.add(`pid:${value}`);
        markFailure("residual_identity_unavailable");
      }
    }
  };

  const identityIsAlive = (identity: ProcessIdentity) => {
    try {
      return identityAlive(identity);
    } catch {
      markFailure("process_identity_liveness_failed");
      unresolved.add(identity.incarnation);
      return true;
    }
  };
  const stopNewIdentities = async () => {
    for (const identity of identities.values()) {
      if (attempted.has(identity.incarnation)) continue;
      attempted.add(identity.incarnation);
      if (!identityIsAlive(identity)) continue;
      cleanup.forcedKills += 1;
      try {
        await killTreeFn(identity.pid, graceMs, {
          requireDescendantScan: true,
          expectedRootIdentity: identity,
          forceVerifyMs,
        });
      } catch (error) {
        const code = stringValue(recordValue(error).code, "unknown").toLowerCase();
        markFailure(`identity_cleanup_${code}`);
      }
    }
  };

  scan();
  cleanup.workerCleanupEvents = trackedWorkers.length > 0 || identities.size > 0 ? 1 : 0;
  await stopNewIdentities();
  scan();
  await stopNewIdentities();
  scan();

  cleanup.pids = [...new Set([
    ...trackedWorkers.map((worker) => worker.pid),
    ...[...identities.values()].map((identity) => identity.pid),
  ])];
  cleanup.residualProcesses = [...identities.values()].filter(identityIsAlive).length + unresolved.size;
  return cleanup;
}

export async function runRequiredWithRetries(
  command: string,
  args: string[],
  cwd: string,
  {
    timeoutMs,
    attempts = 3,
    retryDelayMs = 2_000,
    runner = runCommand,
    signal,
  }: {
    timeoutMs?: number;
    attempts?: number;
    retryDelayMs?: number;
    runner?: CommandRunner;
    signal?: AbortSignal;
  } = {},
) {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      const result = await runner(command, args, cwd, timeoutMs, { signal });
      if (result.code === 0) return result;
      lastError = new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (signal?.aborted) throw abortErrorForSignal(signal);
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await delay(retryDelayMs, signal);
  }
  throw new Error(`${command} ${args.join(" ")} failed after ${attempts} attempts\n${lastError?.message || ""}`);
}

async function fetchDatasetRows(offset: number, length: number, signal?: AbortSignal) {
  const url = buildDatasetRowsUrl({ offset, length });
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return await response.json() as LooseRecord;
}

function selectedRowsFromPage(payload: LooseRecord, excluded: Set<string>, limit: number): SelectedRow[] {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const selected: SelectedRow[] = [];
  for (const item of rows) {
    const rowItem = isRecord(item) ? item : {};
    if (!isRecord(rowItem.row)) continue;
    const rowIndex = Number.isFinite(rowItem.row_idx) ? Number(rowItem.row_idx) : selected.length;
    const record = recordFromDatasetRow(rowItem.row, rowIndex);
    if (excluded.has(record.benchmarkInstanceId)) continue;
    selected.push({ rowIndex, row: rowItem.row, record });
    if (selected.length >= limit) break;
  }
  return selected;
}

async function discoverRows(options: QueueOptions, excluded: Set<string>, signal?: AbortSignal) {
  const selected: SelectedRow[] = [];
  let offset = options.offset;
  while (selected.length < options.count) {
    throwIfAborted(signal);
    const payload = await fetchDatasetRows(offset, options.pageSize, signal);
    const pageRows = Array.isArray(payload.rows) ? payload.rows : [];
    if (pageRows.length === 0) break;
    selected.push(...selectedRowsFromPage(payload, excluded, options.count - selected.length));
    offset += options.pageSize;
  }
  if (selected.length < options.count) {
    throw new Error(`only selected ${selected.length}/${options.count} SWE-bench rows`);
  }
  return selected;
}

function collectInstanceIds(value: unknown, ids: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectInstanceIds(item, ids);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "benchmarkInstanceId" || key === "instanceId") && typeof nested === "string" && nested.includes("__")) {
      ids.add(nested);
    } else if (typeof nested === "object" && nested !== null) {
      collectInstanceIds(nested, ids);
    }
  }
}

async function collectExistingInstanceIds(pathsToScan: string[], signal?: AbortSignal) {
  const ids = new Set<string>();
  async function scan(targetPath: string) {
    throwIfAborted(signal);
    const stats = await stat(targetPath).catch(() => null);
    if (!stats) return;
    if (stats.isDirectory()) {
      const entries = await readdir(targetPath);
      await Promise.all(entries.map((entry) => scan(path.join(targetPath, entry))));
      return;
    }
    if (!targetPath.endsWith(".json")) return;
    try {
      collectInstanceIds(JSON.parse(await readFile(targetPath, "utf8")), ids);
    } catch {
      // Ignore malformed/non-JSON evidence files.
    }
  }
  await Promise.all(pathsToScan.map(scan));
  throwIfAborted(signal);
  return ids;
}

async function cloneAtCommit({ repo, baseCommit, targetDir, signal }: { repo: string; baseCommit: string; targetDir: string; signal?: AbortSignal }) {
  throwIfAborted(signal);
  const originUrl = `https://github.com/${repo}.git`;
  if (await pathExists(path.join(targetDir, ".git"))) {
    const head = await runCommand("git", ["rev-parse", "HEAD"], targetDir, undefined, { signal });
    if (head.code === 0) {
      if (head.stdout.trim() === baseCommit) return;
      throw new Error(`existing source path ${targetDir} is not at expected commit ${baseCommit}`);
    }
    const remote = await runCommand("git", ["remote", "get-url", "origin"], targetDir, undefined, { signal });
    if (remote.code !== 0) await runRequired("git", ["remote", "add", "origin", originUrl], targetDir, undefined, signal);
    else if (remote.stdout.trim() !== originUrl) await runRequired("git", ["remote", "set-url", "origin", originUrl], targetDir, undefined, signal);
    await runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, { timeoutMs: 600_000, signal });
    await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir, undefined, signal);
    return;
  }
  if (await pathExists(targetDir)) {
    throw new Error(`source path already exists and is not a git repository: ${targetDir}`);
  }
  await mkdir(targetDir, { recursive: true });
  throwIfAborted(signal);
  await runRequired("git", ["init"], targetDir, undefined, signal);
  await runRequired("git", ["remote", "add", "origin", originUrl], targetDir, undefined, signal);
  await runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, { timeoutMs: 600_000, signal });
  await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir, undefined, signal);
}

async function initCodeGraph(sourcePath: string, signal?: AbortSignal) {
  const init = await runRequired("codegraph", ["init", sourcePath], REPO_ROOT, 600_000, signal);
  const statusResult = await runRequired("codegraph", ["status", sourcePath], REPO_ROOT, 120_000, signal);
  return {
    init: { code: init.code, stdoutTail: init.stdout.slice(-2000), stderrTail: init.stderr.slice(-2000) },
    statusCommand: { code: statusResult.code, stdoutTail: statusResult.stdout.slice(-2000), stderrTail: statusResult.stderr.slice(-2000) },
  };
}

function workerIdFor(index: number, options: QueueOptions) {
  if (options.workerCount === 1) return `${options.workerPrefix}-01`;
  return `${options.workerPrefix}-${String((index % options.workerCount) + 1).padStart(2, "0")}`;
}

type BatchAssignmentTransactionHooks = {
  afterRegister?: () => void | Promise<void>;
  afterEnqueue?: () => void | Promise<void>;
  concurrentDuringRollback?: () => void | Promise<void>;
};

export async function queueBatchAssignmentAtomically({
  hubRoot,
  workerId,
  input,
  sourcePath,
  metadata,
  skipCodeGraphGate = false,
  signal,
  hooks = {},
}: {
  hubRoot: string;
  workerId: string;
  input: AssignmentInput;
  sourcePath: string;
  metadata: NonNullable<Parameters<typeof registerProject>[1]>;
  skipCodeGraphGate?: boolean;
  signal?: AbortSignal;
  hooks?: BatchAssignmentTransactionHooks;
}) {
  throwIfAborted(signal);
  const assignmentStore = new AssignmentStore(hubRoot);
  const workerStore = new WorkerStore(hubRoot);
  await Promise.all([assignmentStore.init(), workerStore.init()]);
  let projectReceipt: Awaited<ReturnType<typeof registerProjectWithReceipt>>["receipt"] | null = null;
  let assignmentReceipt: Awaited<ReturnType<AssignmentStore["enqueueWithReceipt"]>> | null = null;
  let inboxReceipt: Awaited<ReturnType<WorkerStore["writeInboxWithReceipt"]>> | null = null;
  let committed = false;
  let originalError: unknown = null;
  const rollback = async () => {
    const errors: unknown[] = [];
    await hooks.concurrentDuringRollback?.();
    if (inboxReceipt) {
      try {
        await workerStore.compensateInboxReceipt(inboxReceipt);
      } catch (error) {
        errors.push(error);
      }
    }
    if (assignmentReceipt) {
      try {
        await assignmentStore.compensateEnqueueReceipt(assignmentReceipt);
      } catch (error) {
        errors.push(error);
      }
    }
    if (projectReceipt) {
      try {
        await compensateProjectRegistration(hubRoot, projectReceipt);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        originalError ? [originalError, ...errors] : errors,
        "SWE-bench batch enqueue transaction rollback failed",
      );
    }
  };
  try {
    const project = await registerProjectWithReceipt(hubRoot, {
      id: input.projectId,
      name: input.projectId,
      sourcePath,
      metadata,
      skipCodeGraphGate,
    });
    projectReceipt = project.receipt;
    if (project.commitWarnings.length > 0) {
      const warning = project.commitWarnings[0];
      throw Object.assign(
        new Error(warning.message),
        {
          name: "HubRegistryCommitWarning",
          code: warning.code,
          cause: warning,
          commitWarnings: project.commitWarnings,
          projectReceipt,
        },
      );
    }
    await hooks.afterRegister?.();
    throwIfAborted(signal);
    assignmentReceipt = await assignmentStore.enqueueWithReceipt(input, { workerId, orchestratorEpoch: 1 });
    const inboxPayload = {
      ...assignmentReceipt.assignment,
      ...assignmentReceipt.attempt,
      workerId,
      status: "assigned",
      sourcePath: input.sourcePath,
      task: input.task,
      workflow: input.workflow,
      planMode: input.planMode,
      sourceContext: input.sourceContext,
      metadata: input.metadata,
    };
    inboxReceipt = await workerStore.writeInboxWithReceipt(workerId, inboxPayload);
    await hooks.afterEnqueue?.();
    throwIfAborted(signal);
    committed = true;
    return {
      assignment: assignmentReceipt.assignment,
      attempt: assignmentReceipt.attempt,
      inboxBackend: inboxReceipt.backend,
      inboxRef: inboxReceipt.ref,
      inboxPath: inboxReceipt.path ?? null,
    };
  } catch (error) {
    originalError = error;
    if (!committed && (projectReceipt || assignmentReceipt || inboxReceipt)) {
      await rollback();
    }
    throw error;
  }
}

function buildWorkerIds(options: QueueOptions) {
  return Array.from({ length: options.workerCount }, (_unused, index) => workerIdFor(index, options));
}

async function startWorkers(options: QueueOptions) {
  const workerIds = buildWorkerIds(options).slice(0, options.startWorkers);
  const workerScript = path.join(DIST_ROOT, "runtime", "worker", "managed-worker.js");
  const started: StartedWorker[] = [];
  try {
    for (const workerId of workerIds) {
      const child = spawn(process.execPath, [
        workerScript,
        "--worker-id", workerId,
        "--hub-root", options.hubRoot,
        "--cpb-root", options.cpbRoot,
      ], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ...buildManagedWorkerEnv({
            repoRoot: REPO_ROOT,
            hubRoot: options.hubRoot,
            cpbRoot: options.cpbRoot,
            phaseAgents: options.agents,
            timeoutMs: options.timeoutMs,
          }),
        },
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid || null;
      const worker: StartedWorker = { workerId, pid, processIdentity: null };
      started.push(worker);
      try {
        worker.processIdentity = pid ? captureSpawnProcessIdentity(child) : null;
      } finally {
        child.unref();
      }
      if (!pid || !processIdentityLike(worker.processIdentity)) {
        throw Object.assign(
          new Error(`managed worker process identity unavailable: ${workerId}`),
          { code: "MANAGED_WORKER_PROCESS_IDENTITY_UNAVAILABLE", worker },
        );
      }
    }
    return started;
  } catch (error) {
    await runCleanupSteps(error, [{
      label: "managed_worker_processes",
      run: async () => {
        const cleanup = await stopStartedWorkers(started, {
          reason: "managed_worker_start_failed",
          discoverResidualPids: () => scopedProcessPids([
            options.hubRoot,
            options.cpbRoot,
            options.sourceRoot,
          ]),
        });
        assertWorkerCleanupComplete(cleanup, "managed worker", "MANAGED_WORKER");
      },
    }]);
    throw error;
  }
}

function quotaDelegateChildFailure(child: ReturnType<SpawnLike>) {
  return new Promise<Error>((resolve) => {
    if (typeof child.once !== "function") return;
    let settled = false;
    const settle = (error: Error) => {
      if (settled) return;
      settled = true;
      resolve(error);
    };
    child.once("error", (error) => {
      settle(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, closeSignal) => {
      settle(Object.assign(
        new Error(
          `quota delegate exited before readiness (code=${String(code)}, signal=${String(closeSignal)})`,
        ),
        { code: "QUOTA_DELEGATE_EARLY_EXIT", exitCode: code, signal: closeSignal },
      ));
    });
  });
}

async function raceQuotaDelegateStartup<T>(work: Promise<T>, childFailure: Promise<Error>): Promise<T> {
  const outcome = await Promise.race([
    work.then(
      (value) => ({ kind: "value" as const, value }),
      (error) => ({ kind: "error" as const, error }),
    ),
    childFailure.then((error) => ({ kind: "error" as const, error })),
  ]);
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}

function assertWorkerCleanupComplete(
  cleanup: WorkerCleanupEvidence,
  label: string,
  codePrefix: string,
) {
  if (cleanup.residualScanOk !== true) {
    throw Object.assign(
      new Error(`${label} cleanup could not verify the residual process set`),
      {
        code: `${codePrefix}_CLEANUP_UNVERIFIED`,
        cleanup,
      },
    );
  }
  if (cleanup.residualProcesses > 0) {
    throw Object.assign(
      new Error(`${label} cleanup left ${cleanup.residualProcesses} residual process(es)`),
      {
        code: `${codePrefix}_CLEANUP_RESIDUAL`,
        cleanup,
      },
    );
  }
}

function assertQuotaDelegateCleanupComplete(cleanup: WorkerCleanupEvidence) {
  assertWorkerCleanupComplete(cleanup, "quota delegate", "QUOTA_DELEGATE");
}

export async function startQuotaDelegate({
  hubRoot,
  cpbRoot,
  repoRoot = REPO_ROOT,
  distRoot = DIST_ROOT,
  env = process.env,
  spawnImpl = spawn as SpawnLike,
  isDelegateAliveFn = isDelegateAlive,
  waitForDelegateIncarnationFn = waitForDelegateIncarnation,
  captureProcessIdentityFn = (pid: number) => captureProcessIdentity(pid, { strict: true }),
  ownerToken = randomBytes(16).toString("hex"),
  readyTimeoutMs = 5_000,
  readyPollMs = 50,
  signal,
  stopSpawnedFn = async (worker: StartedWorker) => {
    return stopStartedWorkers([worker], {
      reason: "quota_delegate_start_failed",
      discoverResidualPids: () => scopedProcessPids([hubRoot, cpbRoot, repoRoot]),
    });
  },
}: {
  hubRoot: string;
  cpbRoot: string;
  repoRoot?: string;
  distRoot?: string;
  env?: Record<string, string | undefined>;
  spawnImpl?: SpawnLike;
  isDelegateAliveFn?: (hubRoot: string) => Promise<boolean> | boolean;
  waitForDelegateIncarnationFn?: (
    hubRoot: string,
    expected: ProcessIdentity | QuotaDelegateLockReceipt,
    timeoutMs?: number,
  ) => Promise<QuotaDelegateLockReceipt | null>;
  captureProcessIdentityFn?: (pid: number) => ProcessIdentity | null;
  ownerToken?: string;
  readyTimeoutMs?: number;
  readyPollMs?: number;
  signal?: AbortSignal;
  stopSpawnedFn?: (worker: StartedWorker) => Promise<WorkerCleanupEvidence>;
}): Promise<StartedWorker | null> {
  throwIfAborted(signal);
  if (await isDelegateAliveFn(hubRoot)) return null;
  throwIfAborted(signal);
  const delegateScript = path.join(distRoot, "server", "services", "quota-delegate.js");
  const child = spawnImpl(process.execPath, [
    delegateScript,
    "--hub-root",
    hubRoot,
    "--owner-token",
    ownerToken,
  ], {
    cwd: repoRoot,
    env: {
      ...env,
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_DELEGATE_OWNER_TOKEN: ownerToken,
    },
    detached: true,
    stdio: "ignore",
  });
  const started: StartedWorker = {
    workerId: "quota-delegate",
    pid: child.pid || null,
    processIdentity: null,
    ownerToken,
  };
  const childFailure = quotaDelegateChildFailure(child);
  const startupAbort = new AbortController();
  const forwardAbort = () => startupAbort.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  void childFailure.then((error) => startupAbort.abort(error));

  try {
    if (!started.pid) {
      throw Object.assign(
        new Error("quota delegate spawn did not return a process id"),
        { code: "QUOTA_DELEGATE_PROCESS_IDENTITY_UNAVAILABLE" },
      );
    }
    let processIdentity: ProcessIdentity | null = null;
    let captureError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const candidate = captureProcessIdentityFn(started.pid);
        if (processIdentityLike(candidate) && candidate.pid === started.pid) {
          processIdentity = candidate;
          break;
        }
      } catch (error) {
        captureError = error;
        if (stringValue(recordValue(error).code) !== "PROCESS_IDENTITY_UNAVAILABLE") throw error;
      }
    }
    if (!processIdentityLike(processIdentity) || processIdentity.pid !== started.pid) {
      throw Object.assign(
        new Error("quota delegate process identity unavailable after spawn"),
        {
          code: "QUOTA_DELEGATE_PROCESS_IDENTITY_UNAVAILABLE",
          pid: started.pid,
          ...(captureError ? { cause: captureError } : {}),
        },
      );
    }
    started.processIdentity = processIdentity;
    const expectedReceipt: QuotaDelegateLockReceipt = {
      pid: started.pid,
      hubRoot,
      startedAt: new Date().toISOString(),
      ownerToken,
      generation: randomUUID(),
      processIdentity: started.processIdentity,
      incarnation: started.processIdentity.incarnation,
    };
    if (typeof child.unref === "function") child.unref();
    const deadline = Date.now() + Math.max(0, readyTimeoutMs);
    while (Date.now() <= deadline) {
      throwIfAborted(signal);
      const remaining = Math.max(1, deadline - Date.now());
      const pollWindow = Math.min(Math.max(readyPollMs, 25), 250, remaining);
      const receipt = await raceQuotaDelegateStartup(
        Promise.resolve().then(() => waitForDelegateIncarnationFn(hubRoot, expectedReceipt, pollWindow)),
        childFailure,
      );
      if (receipt) {
        throwIfAborted(signal);
        return started;
      }
      await raceQuotaDelegateStartup(delay(Math.max(0, Math.min(readyPollMs, remaining)), startupAbort.signal), childFailure);
    }
    throw new Error(`quota delegate did not become ready for hub ${hubRoot}`);
  } catch (error) {
    await runCleanupSteps(error, [{
      label: "quota_delegate_process",
      run: async () => {
        const cleanup = await stopSpawnedFn(started);
        assertQuotaDelegateCleanupComplete(cleanup);
      },
    }]);
    throw error;
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function batchWaitTerminalizationError(code: string, message: string, cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code },
  );
}

function exactTimedOutAttemptIdentity(
  requestedAssignmentId: string,
  state: AssignmentRecord,
  attempt: AssignmentAttempt,
) {
  const attemptNumber = Number(attempt.attempt);
  const activeAttempt = Number(state.activeAttempt);
  const attemptToken = typeof attempt.attemptToken === "string" ? attempt.attemptToken : "";
  const orchestratorEpoch = attempt.orchestratorEpoch;
  if (!requestedAssignmentId
    || state.assignmentId !== requestedAssignmentId
    || attempt.assignmentId !== requestedAssignmentId
    || !Number.isSafeInteger(attemptNumber) || attemptNumber <= 0
    || !Number.isSafeInteger(activeAttempt) || activeAttempt !== attemptNumber
    || !attemptToken
    || (orchestratorEpoch !== undefined
      && (!Number.isSafeInteger(orchestratorEpoch) || orchestratorEpoch < 0))) {
    throw batchWaitTerminalizationError(
      "BATCH_WAIT_ATTEMPT_IDENTITY_INVALID",
      `cannot terminalize timed-out assignment with incomplete or stale identity: ${requestedAssignmentId}`,
    );
  }
  return {
    assignmentId: requestedAssignmentId,
    attempt: attemptNumber,
    attemptToken,
    ...(orchestratorEpoch !== undefined ? { orchestratorEpoch } : {}),
  };
}

export async function waitForAssignments(
  hubRoot: string,
  assignments: AssignmentRecord[],
  {
    intervalMs = 15_000,
    timeoutMs = 0,
    reason = "batch_wait_timeout",
    signal,
  }: {
    intervalMs?: number;
    timeoutMs?: number;
    reason?: string;
    signal?: AbortSignal;
  } = {},
) {
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  while (true) {
    throwIfAborted(signal);
    const states = await Promise.all(assignments.map((assignment) => store.getAssignment(String(assignment.assignmentId))));
    throwIfAborted(signal);
    const done = states.every((state) => state?.status && TERMINAL_STATUSES.has(String(state.status)));
    if (done) return states;
    if (deadline > 0 && Date.now() >= deadline) {
      return Promise.all(states.map(async (state, index) => {
        const requestedAssignmentId = String(assignments[index]?.assignmentId || "");
        if (!state) {
          throw batchWaitTerminalizationError(
            "BATCH_WAIT_ASSIGNMENT_NOT_FOUND",
            `timed-out assignment is missing from persisted state: ${requestedAssignmentId}`,
          );
        }
        if (state.status && TERMINAL_STATUSES.has(String(state.status))) return state;
        const attempt = await store.getActiveAttempt(requestedAssignmentId);
        if (!attempt) {
          throw batchWaitTerminalizationError(
            "BATCH_WAIT_ACTIVE_ATTEMPT_NOT_FOUND",
            `timed-out assignment has no active attempt: ${requestedAssignmentId}`,
          );
        }
        const identity = exactTimedOutAttemptIdentity(requestedAssignmentId, state, attempt);
        const syntheticWritten = await store.writeSyntheticFailure(identity.assignmentId, identity.attempt, {
          ...identity,
          entryId: state.entryId,
          projectId: state.projectId,
          workerId: attempt.workerId ?? state.workerId,
          status: "failed",
          failureKind: reason,
          error: `${reason}: assignment did not reach a terminal state before batch wait timeout`,
          finishedAt: new Date().toISOString(),
          diagnostics: {
            reason,
            previousStatus: state.status || null,
            activeAttempt: state.activeAttempt || null,
          },
        });
        const persisted = await store.getAssignment(identity.assignmentId);
        if (!persisted?.status || !TERMINAL_STATUSES.has(String(persisted.status))) {
          throw batchWaitTerminalizationError(
            "BATCH_WAIT_TERMINALIZATION_CONFLICT",
            `timed-out assignment did not persist a terminal state: ${identity.assignmentId}`,
          );
        }
        if (syntheticWritten !== false
          && (persisted.status !== "failed" || Number(persisted.activeAttempt) !== identity.attempt)) {
          throw batchWaitTerminalizationError(
            "BATCH_WAIT_TERMINALIZATION_CONFLICT",
            `timed-out assignment terminal state no longer matches the synthetic failure identity: ${identity.assignmentId}`,
          );
        }
        return persisted;
      }));
    }
    await delay(intervalMs, signal);
  }
}

export function buildNotificationCommand({
  platform = process.platform,
  title,
  message,
}: {
  platform?: NodeJS.Platform;
  title: string;
  message: string;
}) {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    };
  }
  if (platform === "linux") {
    return { command: "notify-send", args: [title, message] };
  }
  return null;
}

async function notify(title: string, message: string, enabled: boolean, signal?: AbortSignal) {
  if (!enabled) return;
  throwIfAborted(signal);
  const notification = buildNotificationCommand({ title, message });
  if (!notification) return;
  await runCommand(notification.command, notification.args, REPO_ROOT, 30_000, { signal }).catch(() => null);
}

function printUsage() {
  console.log(`Usage: node dist/scripts/queue-swebench-batch.js [options]

Options:
  --count <n>             Number of SWE-bench Verified rows to queue. Defaults to 50.
  --offset <n>            Dataset row offset to start searching from. Defaults to 0.
  --include-existing      Do not exclude instance ids already found in product evidence JSON.
  --hub-root <path>       CPB hub root. Defaults to a temporary batch directory.
  --cpb-root <path>       CPB runtime root. Defaults to a temporary batch directory.
  --source-root <path>    Source checkout root. Defaults to a temporary batch directory.
  --worker-count <n>      Number of worker inboxes to distribute across. Defaults to 1.
  --worker-prefix <name>  Worker id prefix. Defaults to w-swebench.
  --plan-mode <mode>      full or light. Defaults to full.
  --provider-preflight <m> live or structural. Defaults to live for real runs and structural for dry-run.
  --planner-agent <n>     Planner agent. Defaults to codex.
  --executor-agent <n>    Executor agent. Defaults to claude-glm.
  --verifier-agent <n>    Verifier agent. Defaults to claude-mimo.
  --adversarial-agent <n> Adversarial verifier agent. Defaults to claude-mimo.
  --agent <n>             Single-agent override for controlled comparisons.
  --skip-codegraph        Skip source CodeGraph initialization during environment setup.
  --start-workers <n>     Start n detached managed workers after queueing.
  --wait                  Wait for queued assignments to reach terminal status.
  --wait-timeout-ms <ms>  Batch wait timeout. Defaults to a worker-count-scaled full workflow window.
  --dry-run               Discover rows and write manifest without clone/queue side effects.
  --rebuild-report        Rebuild report from --output manifest without queueing new work.
  --scorer-evidence <p>   Merge official SWE-bench scorer aggregate/summary JSON into the report.
  --scorer-required       Mark scorer evidence required for completed patch jobs.
  --output <path>         Manifest output path. Defaults under hub root.
  --report-output <path>  Report output path. Defaults next to manifest.
  --no-notify             Disable desktop notification.
`);
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }
  const options = resolveBatchQueueOptions(process.argv);
  if (options.rebuildReport) {
    const manifest = await readJsonFile(options.outputPath);
    if (!manifest) throw new Error(`failed to read manifest for report rebuild: ${options.outputPath}`);
    const manifestHubRoot = stringValue(recordValue(manifest).hubRoot);
    const outputs = await writeSweBenchBatchOutputs({
      manifest,
      manifestPath: options.outputPath,
      reportPath: options.reportPath,
      hubRoot: options.hubRootExplicit ? options.hubRoot : manifestHubRoot || options.hubRoot,
      scorerRequired: options.scorerRequired,
      scorerEvidencePath: options.scorerEvidencePath,
    });
    await notify(options.notifyTitle, `Rebuilt SWE-bench batch report: ${outputs.reportPath}`, options.notify);
    console.log(`Rebuilt SWE-bench batch report: ${outputs.reportPath}`);
    return;
  }
  const providerPreflightAbort = new AbortController();
  const abortProviderPreflight = (signal: NodeJS.Signals) => {
    if (!providerPreflightAbort.signal.aborted) {
      providerPreflightAbort.abort(batchAbortError(
        `provider preflight aborted by ${signal}`,
        signal === "SIGINT" ? 130 : 143,
      ));
    }
  };
  process.once("SIGINT", abortProviderPreflight);
  process.once("SIGTERM", abortProviderPreflight);
  try {
  const providerPreflight = await runSweBenchProviderPreflight({
      agents: options.agents,
      handshake: options.providerPreflightMode === "live" ? liveProviderPreflightHandshake : null,
      artifactRoot: path.join(
        path.dirname(options.reportPath),
        "provider-preflight-artifacts",
        `${Date.now()}-${randomBytes(8).toString("hex")}`,
      ),
      signal: providerPreflightAbort.signal,
    });
  if (!providerPreflight.ok) {
    throwIfAborted(providerPreflightAbort.signal, preflightFailureMessage(providerPreflight));
    await writePreflightFailureOutputs({ options, providerPreflight });
    throw new Error(preflightFailureMessage(providerPreflight));
  }
  throwIfAborted(providerPreflightAbort.signal);
  const excluded = options.excludeExisting
    ? await collectExistingInstanceIds(options.excludePaths, providerPreflightAbort.signal)
    : new Set<string>();
  const selected = await discoverRows(options, excluded, providerPreflightAbort.signal);
  const assignments: Array<LooseRecord> = [];
  const startedAt = new Date().toISOString();

  await mkdir(options.sourceRoot, { recursive: true });
  await mkdir(options.cpbRoot, { recursive: true });
  await mkdir(options.hubRoot, { recursive: true });
  throwIfAborted(providerPreflightAbort.signal);

  for (let index = 0; index < selected.length; index += 1) {
    const { rowIndex, row, record } = selected[index];
    const workerId = workerIdFor(index, options);
    const sourcePath = path.join(options.sourceRoot, safeId(record.benchmarkInstanceId));
    const input = buildBatchAssignmentInput({
      record,
      row,
      sourcePath,
      agents: options.agents,
      planMode: options.planMode,
    });

    let codegraph: unknown = null;
    let queued: LooseRecord | null = null;
    if (!options.dryRun) {
      throwIfAborted(providerPreflightAbort.signal);
      await cloneAtCommit({
        repo: record.representativeRepository,
        baseCommit: record.baseCommit,
        targetDir: sourcePath,
        signal: providerPreflightAbort.signal,
      });
      codegraph = options.skipCodegraph ? null : await initCodeGraph(sourcePath, providerPreflightAbort.signal);
      throwIfAborted(providerPreflightAbort.signal);
      const enqueue = await queueBatchAssignmentAtomically({
        hubRoot: options.hubRoot,
        workerId,
        input,
        sourcePath,
        metadata: {
          productValidation: true,
          benchmarkDataset: DATASET,
          benchmarkInstanceId: record.benchmarkInstanceId,
          batchQueuedAt: startedAt,
        },
        signal: providerPreflightAbort.signal,
      });
      queued = {
        assignmentId: enqueue.assignment.assignmentId,
        attempt: enqueue.attempt.attempt,
          attemptToken: enqueue.attempt.attemptToken,
          orchestratorEpoch: enqueue.attempt.orchestratorEpoch,
          inboxBackend: enqueue.inboxBackend,
          inboxRef: enqueue.inboxRef,
          inboxPath: enqueue.inboxPath,
        };
    }

    assignments.push({
      rowIndex,
      workerId,
      projectId: input.projectId,
      entryId: input.entryId,
      sourcePath,
      record,
      queued,
      codegraph,
    });
    console.log(`[${index + 1}/${selected.length}] ${record.benchmarkInstanceId} -> ${workerId}${options.dryRun ? " (dry-run)" : ""}`);
  }

  let quotaDelegate: StartedWorker | null = null;
  const workers = options.startWorkers > 0 && !options.dryRun ? await (async () => {
    try {
      throwIfAborted(providerPreflightAbort.signal);
      quotaDelegate = await startQuotaDelegate({
        hubRoot: options.hubRoot,
        cpbRoot: options.cpbRoot,
        signal: providerPreflightAbort.signal,
      });
      throwIfAborted(providerPreflightAbort.signal);
      return startWorkers(options);
    } catch (error) {
      if (quotaDelegate) {
        const startedDelegate = quotaDelegate;
        quotaDelegate = null;
        await runCleanupSteps(error, [{
          label: "quota_delegate_process",
          run: async () => {
            const cleanup = await stopStartedWorkers([startedDelegate], {
              reason: "batch_aborted_before_worker_start",
              discoverResidualPids: () => scopedProcessPids([
                options.hubRoot,
                options.cpbRoot,
                options.sourceRoot,
              ]),
            });
            assertQuotaDelegateCleanupComplete(cleanup);
          },
        }]);
      }
      throw error;
    }
  })() : [];
  let workerCleanup = emptyWorkerCleanupEvidence();
  let terminalStates: unknown[] | null = null;
  let cleanupPromise: Promise<WorkerCleanupEvidence> | null = null;
  const cleanupStartedProcesses = (reason: string) => {
    if (!cleanupPromise) {
      const cleanupTargets = [...(quotaDelegate ? [quotaDelegate] : []), ...workers];
      cleanupPromise = cleanupTargets.length > 0
        ? stopStartedWorkers(cleanupTargets, {
          reason,
          discoverResidualPids: () => scopedProcessPids([
            options.hubRoot,
            options.cpbRoot,
            options.sourceRoot,
          ]),
        })
        : Promise.resolve(emptyWorkerCleanupEvidence());
    }
    return cleanupPromise;
  };
  let waitError: unknown = null;
  try {
    throwIfAborted(providerPreflightAbort.signal);
    if (options.wait && !options.dryRun) {
      const queuedAssignments = assignments
        .map((assignment) => {
          const queued = recordValue(assignment.queued);
          return queued.assignmentId ? { assignmentId: queued.assignmentId } : null;
        })
        .filter(Boolean) as AssignmentRecord[];
      terminalStates = await waitForAssignments(options.hubRoot, queuedAssignments, {
        timeoutMs: options.waitTimeoutMs,
        reason: "batch_wait_timeout",
        signal: providerPreflightAbort.signal,
      });
    }
    throwIfAborted(providerPreflightAbort.signal);
  } catch (error) {
    waitError = error;
  }
  const cleanupNeeded = (options.wait || providerPreflightAbort.signal.aborted)
    && (workers.length > 0 || quotaDelegate);
  const finishStartedProcessCleanup = async () => {
    workerCleanup = await cleanupStartedProcesses(
      providerPreflightAbort.signal.aborted ? "batch_aborted" : "batch_wait_completed",
    );
    assertWorkerCleanupComplete(workerCleanup, "batch worker", "BATCH_WORKER");
  };
  if (waitError) {
    if (cleanupNeeded) {
      await runCleanupSteps(waitError, [{
        label: "batch_started_processes",
        run: finishStartedProcessCleanup,
      }]);
    }
    throw waitError;
  }
  if (cleanupNeeded) {
    await finishStartedProcessCleanup();
  }

  throwIfAborted(providerPreflightAbort.signal);
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    dataset: DATASET,
    split: DATASET_SPLIT,
    count: assignments.length,
    planMode: options.planMode,
    providerPreflightMode: options.providerPreflightMode,
    agents: options.agents,
    hubRoot: options.hubRoot,
    cpbRoot: options.cpbRoot,
    sourceRoot: options.sourceRoot,
    workerIds: buildWorkerIds(options),
    timeoutMs: options.timeoutMs,
    waitTimeoutMs: options.waitTimeoutMs,
    providerPreflight,
    workers,
    workerCleanup,
    dryRun: options.dryRun,
    waited: options.wait,
    terminalStates,
    assignments,
  };

  const outputs = await writeSweBenchBatchOutputs({
    manifest,
    manifestPath: options.outputPath,
    reportPath: options.reportPath,
    hubRoot: options.hubRoot,
    scorerRequired: options.scorerRequired,
    scorerEvidencePath: options.scorerEvidencePath,
  });
  throwIfAborted(providerPreflightAbort.signal);
  const completion = options.wait && terminalStates
    ? `Completed ${terminalStates.length} SWE-bench assignments`
    : `Queued ${assignments.length} SWE-bench assignments`;
  await notify(
    options.notifyTitle,
    `${completion}. Manifest: ${outputs.manifestPath}. Report: ${outputs.reportPath}`,
    options.notify,
    providerPreflightAbort.signal,
  );
  console.log(`Wrote SWE-bench batch queue manifest: ${outputs.manifestPath}`);
  console.log(`Wrote SWE-bench batch report: ${outputs.reportPath}`);
  console.log(completion);
  } catch (error) {
    if (providerPreflightAbort.signal.aborted) {
      throw combineAbortAndOperationError(providerPreflightAbort.signal, error);
    }
    throw error;
  } finally {
    process.off("SIGINT", abortProviderPreflight);
    process.off("SIGTERM", abortProviderPreflight);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    let options: QueueOptions | null = null;
    try {
      options = resolveBatchQueueOptions(process.argv);
    } catch {
      // Argument parsing itself may be the failure; fall back to default title.
    }
    if (!isAbortError(error)) {
      await notify(
        options?.notifyTitle || "CPB SWE-bench batch",
        `SWE-bench batch queue failed: ${message}`,
        options?.notify ?? true,
      ).catch(() => null);
    }
    process.exitCode = abortExitCode(error) || 1;
  });
}
