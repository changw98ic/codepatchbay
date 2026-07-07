#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { hasAgent, loadRegistry, resolveAgentCommand } from "../core/agents/registry.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { envForAgent, providerKeyForAgent } from "../server/services/acp/acp-pool.js";
import { isDelegateAlive } from "../server/services/quota-delegate-client.js";
import { getProviderAdapter } from "../server/services/provider-adapters.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";
import { AssignmentStore, type AssignmentRecord } from "../shared/orchestrator/assignment-store.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import {
  buildSweBenchAcceptanceChecklist,
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
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const HARD_CONSTRAINT_FAILURE_KINDS = new Set([
  "web_tool_denied",
  "read_only_mutation_denied",
  "broad_test_command_denied",
  "swebench_execute_no_edit_progress",
  "whole_filesystem_search_denied",
  "tool_budget_exceeded",
]);

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
};

type SpawnLike = (
  command: string,
  args: string[],
  options: LooseRecord,
) => {
  pid?: number | null;
  unref?: () => void;
};

type WorkerCleanupEvidence = {
  workerCleanupEvents: number;
  forcedKills: number;
  residualProcesses: number;
  reasons: string[];
  workerIds: string[];
  pids: number[];
};

type ProviderPreflightPhaseInput = {
  phase: string;
  role: string;
  agent: string;
  providerKey: string;
  command: string;
  args: string[];
  outputPath: string;
  env: LooseRecord;
  denyRules: string[];
};

type ProviderPreflightHandshake = (input: ProviderPreflightPhaseInput) => Promise<unknown> | unknown;

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

export async function runSweBenchProviderPreflight({
  agents,
  env = process.env,
  handshake = null,
  generatedAt = new Date().toISOString(),
}: {
  agents: ProductValidationAgents;
  env?: LooseRecord;
  handshake?: ProviderPreflightHandshake | null;
  generatedAt?: string;
}) {
  await loadRegistry("");
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
    const providerKey = providerKeyForAgent(route.agent, envRecord);
    const phaseViolations: string[] = [];
    const registered = hasAgent(route.agent);
    const commandInfo = registered ? recordValue(resolveAgentCommand(route.agent)) : {};
    const command = stringValue(commandInfo.command);
    const args = arrayValue(commandInfo.args).map(String);
    const outputPath = path.join(
      os.tmpdir(),
      `cpb-swebench-provider-preflight-${safeId(route.phase)}-${safeId(route.agent)}.json`,
    );
    let resolvedEnv: LooseRecord = {};
    let handshakeResult: LooseRecord = {};
    let handshakeOk = false;

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
        phaseViolations.push(`${route.role} provider env invalid for ${route.agent}/${providerKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (phaseViolations.length === 0) {
      if (handshake) {
        try {
          handshakeResult = recordValue(await handshake({
            phase: route.phase,
            role: route.role,
            agent: route.agent,
            providerKey,
            command,
            args,
            outputPath,
            env: resolvedEnv,
            denyRules,
          }));
          handshakeOk = handshakeResult.ok === true
            && handshakeResult.wroteStructuredOutput !== false
            && handshakeResult.denyRulesHonored !== false;
          if (!handshakeOk) {
            const detail = stringValue(handshakeResult.error || handshakeResult.reason || handshakeResult.stderr);
            phaseViolations.push(`${route.role} provider ${providerKey} failed structured handshake${detail ? `: ${detail}` : ""}`);
            const failureKind = stringValue(handshakeResult.failureKind);
            if (failureKind) failureKinds.push(failureKind);
          }
        } catch (error) {
          handshakeResult = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          phaseViolations.push(`${route.role} provider ${providerKey} handshake failed: ${stringValue(handshakeResult.error)}`);
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
      registered,
      command: command || null,
      commandSource: optionalStringValue(commandInfo.source),
      args,
      envKeysPresent: presentProviderEnvKeys(providerKey, env),
      activeVariant: optionalStringValue(resolvedEnv.CPB_ACTIVE_CLAUDE_VARIANT),
      model: optionalStringValue(resolvedEnv.ANTHROPIC_MODEL),
      adapter: {
        timezone: optionalStringValue(adapter.timezone),
        quotaPolicy: recordValue(adapter.quotaPolicy),
      },
      outputPath,
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

function sha256Json(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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
    numericValue(assignmentRecord.attempts),
    numericValue(state.attempts),
  );
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

function emptyWorkerCleanupEvidence(): WorkerCleanupEvidence {
  return {
    workerCleanupEvents: 0,
    forcedKills: 0,
    residualProcesses: 0,
    reasons: [],
    workerIds: [],
    pids: [],
  };
}

function workerCleanupEvidenceValue(value: unknown): WorkerCleanupEvidence {
  const record = recordValue(value);
  return {
    workerCleanupEvents: numericValue(record.workerCleanupEvents),
    forcedKills: numericValue(record.forcedKills),
    residualProcesses: numericValue(record.residualProcesses),
    reasons: arrayValue(record.reasons).map(String).filter(Boolean),
    workerIds: arrayValue(record.workerIds).map(String).filter(Boolean),
    pids: arrayValue(record.pids).map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0),
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
    ...recordValue(phaseEvidence[phase]),
  };
  phaseEvidence[phase] = current;
  evidence.phaseEvidence = phaseEvidence;
  return current;
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

async function readJsonFile(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    return raw.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return recordValue(JSON.parse(line));
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
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
  for (const event of await readJsonlFile(eventFile)) {
    const eventName = stringValue(event.type || event.event);
    const phaseName = stringValue(event.phase);
    if (!phaseName) continue;
    if (eventName === "phase_retry") {
      const phaseEvidence = phaseEvidenceEntry(evidence, phaseName);
      phaseEvidence.retryCount = numericValue(phaseEvidence.retryCount) + 1;
      const retryFailureKind = stringValue(event.failureKind || event.kind);
      phaseEvidence.failureKind = preferredFailureKind(phaseEvidence.failureKind, retryFailureKind);
      setFailureKind(evidence, retryFailureKind);
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
    phaseEvidence.ok = phaseResult.ok === true || phaseResult.status === "passed"
      ? true
      : phaseResult.ok === false || phaseResult.status === "failed"
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
    phaseEvidence.failureKind = preferredFailureKind(
      phaseEvidence.failureKind,
      phaseResult.failureKind || failure.kind || failure.failureKind,
    );
    setFailureKind(evidence, phaseEvidence.failureKind);
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
  for (const event of await readJsonlFile(filePath)) {
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
      const jobId = stringValue(recordValue(result.jobResult).jobId || result.jobId || terminalState.jobId);
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

export function validateSweBenchBatchReport({
  manifest,
  report,
}: {
  manifest: unknown;
  report: unknown;
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
  const providerPreflight = recordValue(recordValue(reportRecord.manifest).providerPreflight || manifestRecord.providerPreflight);
  if (providerPreflight.ok === false) {
    violations.push(`provider preflight failed: ${arrayValue(providerPreflight.violations).join("; ") || "provider_unavailable"}`);
  }
  const residualProcesses = numericValue(recordValue(reportRecord.summary).residualProcesses);
  if (residualProcesses > 0) {
    violations.push(`batch has ${residualProcesses} residual process(es) after cleanup`);
  }

  for (const assignment of assignments) {
    const instanceId = assignmentInstanceId(assignment);
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
    const assignmentId = stringValue(jobRecord.assignmentId);
    const assignment = assignmentsById.get(assignmentId);
    const requiredAttempts = assignmentAttemptCount(assignment, terminalStatesByAssignmentId.get(assignmentId));
    const attempts = recordValue(jobRecord.attempts);
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
    if (jobRecord.status !== "completed") continue;
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
  const assignments = arrayValue(manifestRecord.assignments);
  const agents = recordValue(manifestRecord.agents);
  const providerPreflight = recordValue(manifestRecord.providerPreflight);
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
    manifest: {
      hash: sha256Json(manifestRecord),
      dataset: manifestRecord.dataset,
      split: manifestRecord.split,
      count: manifestRecord.count,
      assignmentCount: assignments.length,
      planMode: manifestRecord.planMode,
      agents,
      providerPreflight,
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
  const failureKind = stringValue(preflight.failureKind, "provider_unavailable");
  const violations = arrayValue(preflight.violations).map(String).filter(Boolean);
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
  const acceptanceChecklist = buildSweBenchAcceptanceChecklist(row, record, { jobId, projectId, task });
  const verificationCommands = deriveSweBenchVerificationCommands(row, record);
  const canonicalCommands = [
    ...verificationCommands.failToPass,
    ...verificationCommands.passToPass,
  ];
  const diagnosticCommands = deriveSweBenchDiagnosticCommands(row, record);
  const productValidation = {
    validationMode: "swe-bench-verified",
    benchmarkInstanceId: record.benchmarkInstanceId,
    datasetRowRef: record.datasetRowRef,
    planMode,
    agents,
    canonicalCommands,
    diagnosticCommands,
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
      acceptanceChecklist,
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
    CPB_CODEGRAPH_INDEX_ONLY_OK: "1",
    CPB_WORKER_DISPATCH_ENABLED: "0",
    CPB_ACP_USE_MANAGED_POOL: "0",
    CPB_ACP_PERSISTENT_PROCESS: "0",
    CPB_ACP_DISABLE_WEB_TOOLS: process.env.CPB_ACP_DISABLE_WEB_TOOLS || "1",
    CPB_CHECKLIST_DECOMPOSE: "1",
    CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_MAX || "2",
    CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS: process.env.CPB_CHECKLIST_DECOMPOSE_RETRY_BASE_DELAY_MS || "1000",
    CPB_PHASE_RETRY_MAX: process.env.CPB_PHASE_RETRY_MAX || "3",
    CPB_PHASE_FEEDBACK_RETRY_MAX: process.env.CPB_PHASE_FEEDBACK_RETRY_MAX || "1",
    CPB_PHASE_RETRY_BASE_DELAY_MS: process.env.CPB_PHASE_RETRY_BASE_DELAY_MS || "1000",
    CPB_DYNAMIC_VERIFIER_AGENT: phaseAgents.verifier,
    CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1",
    CPB_WORKER_EXIT_ON_IDLE: "1",
    CPB_WORKER_IDLE_EXIT_MS: process.env.CPB_WORKER_IDLE_EXIT_MS || "60000",
    CPB_ACP_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_IDLE_TIMEOUT_MS: process.env.CPB_ACP_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
    CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS: process.env.CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS || String(Math.min(timeoutMs, 600_000)),
    CPB_ACP_SWEBENCH_EXECUTE_NO_EDIT_TOOL_LIMIT: process.env.CPB_ACP_SWEBENCH_EXECUTE_NO_EDIT_TOOL_LIMIT || "5",
    CPB_ACP_PHASE_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_POOL_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_TOOL_CALL_BUDGET_PLAN: process.env.CPB_ACP_TOOL_CALL_BUDGET_PLAN || "40",
    CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: process.env.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE || "40",
    CPB_ACP_TOOL_CALL_BUDGET_VERIFY: process.env.CPB_ACP_TOOL_CALL_BUDGET_VERIFY || "80",
    CPB_ACP_TOOL_CALL_BUDGET_ADVERSARIAL_VERIFY: process.env.CPB_ACP_TOOL_CALL_BUDGET_ADVERSARIAL_VERIFY || "80",
    CPB_ACP_TOOL_EVENT_BUDGET_PLAN: process.env.CPB_ACP_TOOL_EVENT_BUDGET_PLAN || "160",
    CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: process.env.CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE || "120",
    CPB_ACP_TOOL_EVENT_BUDGET_VERIFY: process.env.CPB_ACP_TOOL_EVENT_BUDGET_VERIFY || "240",
    CPB_ACP_TOOL_EVENT_BUDGET_ADVERSARIAL_VERIFY: process.env.CPB_ACP_TOOL_EVENT_BUDGET_ADVERSARIAL_VERIFY || "240",
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
};
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  options?: CommandRunOptions,
) => Promise<CommandResult>;

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  options: CommandRunOptions = {},
): Promise<CommandResult> {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(options.input || "");
  });
}

export async function liveProviderPreflightHandshake(
  input: ProviderPreflightPhaseInput,
  {
    repoRoot = REPO_ROOT,
    distRoot = DIST_ROOT,
    timeoutMs = Number(process.env.CPB_SWEBENCH_PROVIDER_PREFLIGHT_TIMEOUT_MS || DEFAULT_LIVE_PROVIDER_PREFLIGHT_TIMEOUT_MS),
    runner = runCommand,
  }: {
    repoRoot?: string;
    distRoot?: string;
    timeoutMs?: number;
    runner?: CommandRunner;
  } = {},
) {
  const acpClient = path.join(distRoot, "server", "services", "acp", "acp-client.js");
  const prompt = [
    "CPB provider live preflight.",
    "Do not call tools. Do not inspect files. Reply exactly with: CPB_PROVIDER_PREFLIGHT_OK",
  ].join("\n");
  const env = {
    ...process.env,
    ...stringEnvRecord(input.env),
    CPB_ACP_TERMINAL: "deny",
    CPB_ACP_PERMISSION: "reject",
    CPB_ACP_DISABLE_WEB_TOOLS: "1",
    CPB_ACP_TIMEOUT_MS: String(timeoutMs),
    CPB_ACP_IDLE_TIMEOUT_MS: String(timeoutMs),
  };
  const result = await runner(process.execPath, [
    acpClient,
    "--agent",
    input.agent,
    "--cwd",
    repoRoot,
  ], repoRoot, timeoutMs, {
    env,
    input: prompt,
  });
  const ok = result.code === 0;
  const failureKind = ok ? null : livePreflightFailureKind(`${result.stderr}\n${result.stdout}`);
  const output = {
    ok,
    mode: "live",
    phase: input.phase,
    role: input.role,
    agent: input.agent,
    providerKey: input.providerKey,
    command: input.command,
    denyRulesHonored: true,
    wroteStructuredOutput: true,
    stdoutTail: result.stdout.slice(-1000),
    stderrTail: result.stderr.slice(-1000),
    ...(failureKind ? { failureKind } : {}),
    ...(ok ? {} : { error: (result.stderr || result.stdout || `exited ${result.code}`).slice(-1000) }),
  };
  await mkdir(path.dirname(input.outputPath), { recursive: true });
  await writeJsonAtomic(input.outputPath, output);
  return output;
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

async function runRequired(command: string, args: string[], cwd: string, timeoutMs?: number) {
  const result = await runCommand(command, args, cwd, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForWorkerPidsExit(
  pids: number[],
  {
    graceMs,
    pollMs,
    processAlive,
  }: {
    graceMs: number;
    pollMs: number;
    processAlive: (pid: number) => boolean;
  },
) {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (pids.some((pid) => processAlive(pid)) && Date.now() < deadline) {
    await delay(Math.max(0, pollMs));
  }
}

export async function stopStartedWorkers(
  workers: StartedWorker[],
  {
    reason = "batch_wait_completed",
    graceMs = 5_000,
    pollMs = 100,
    processAlive = defaultProcessAlive,
    killProcess = (pid: number, signal: "SIGTERM" | "SIGKILL") => {
      process.kill(pid, signal);
    },
  }: {
    reason?: string;
    graceMs?: number;
    pollMs?: number;
    processAlive?: (pid: number) => boolean;
    killProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  } = {},
): Promise<WorkerCleanupEvidence> {
  const liveWorkers = workers.filter((worker): worker is { workerId: string; pid: number } => (
    Number.isInteger(worker.pid) && Number(worker.pid) > 0
  ));
  const cleanup: WorkerCleanupEvidence = {
    ...emptyWorkerCleanupEvidence(),
    reasons: reason ? [reason] : [],
    workerIds: liveWorkers.map((worker) => worker.workerId),
    pids: liveWorkers.map((worker) => worker.pid),
  };
  if (liveWorkers.length === 0) return cleanup;

  cleanup.workerCleanupEvents = 1;
  for (const { pid } of liveWorkers) {
    try {
      if (processAlive(pid)) killProcess(pid, "SIGTERM");
    } catch {
      // The worker may exit between the liveness check and the signal.
    }
  }
  await waitForWorkerPidsExit(cleanup.pids, { graceMs, pollMs, processAlive });

  const survivors = liveWorkers.filter(({ pid }) => processAlive(pid));
  cleanup.forcedKills = survivors.length;
  for (const { pid } of survivors) {
    try {
      killProcess(pid, "SIGKILL");
    } catch {
      // Already gone is the desired state.
    }
  }
  await waitForWorkerPidsExit(cleanup.pids, { graceMs: Math.min(graceMs, 5_000), pollMs, processAlive });
  cleanup.residualProcesses = cleanup.pids.filter((pid) => processAlive(pid)).length;
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
  }: {
    timeoutMs?: number;
    attempts?: number;
    retryDelayMs?: number;
    runner?: CommandRunner;
  } = {},
) {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runner(command, args, cwd, timeoutMs);
      if (result.code === 0) return result;
      lastError = new Error(`${command} ${args.join(" ")} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < attempts) await delay(retryDelayMs);
  }
  throw new Error(`${command} ${args.join(" ")} failed after ${attempts} attempts\n${lastError?.message || ""}`);
}

async function fetchDatasetRows(offset: number, length: number) {
  const url = buildDatasetRowsUrl({ offset, length });
  const response = await fetch(url);
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

async function discoverRows(options: QueueOptions, excluded: Set<string>) {
  const selected: SelectedRow[] = [];
  let offset = options.offset;
  while (selected.length < options.count) {
    const payload = await fetchDatasetRows(offset, options.pageSize);
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

async function collectExistingInstanceIds(pathsToScan: string[]) {
  const ids = new Set<string>();
  async function scan(targetPath: string) {
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
  return ids;
}

async function cloneAtCommit({ repo, baseCommit, targetDir }: { repo: string; baseCommit: string; targetDir: string }) {
  const originUrl = `https://github.com/${repo}.git`;
  if (await pathExists(path.join(targetDir, ".git"))) {
    const head = await runCommand("git", ["rev-parse", "HEAD"], targetDir);
    if (head.code === 0) {
      if (head.stdout.trim() === baseCommit) return;
      throw new Error(`existing source path ${targetDir} is not at expected commit ${baseCommit}`);
    }
    const remote = await runCommand("git", ["remote", "get-url", "origin"], targetDir);
    if (remote.code !== 0) await runRequired("git", ["remote", "add", "origin", originUrl], targetDir);
    else if (remote.stdout.trim() !== originUrl) await runRequired("git", ["remote", "set-url", "origin", originUrl], targetDir);
    await runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, { timeoutMs: 600_000 });
    await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir);
    return;
  }
  if (await pathExists(targetDir)) {
    throw new Error(`source path already exists and is not a git repository: ${targetDir}`);
  }
  await mkdir(targetDir, { recursive: true });
  await runRequired("git", ["init"], targetDir);
  await runRequired("git", ["remote", "add", "origin", originUrl], targetDir);
  await runRequiredWithRetries("git", ["fetch", "--depth=1", "origin", baseCommit], targetDir, { timeoutMs: 600_000 });
  await runRequired("git", ["checkout", "--detach", "FETCH_HEAD"], targetDir);
}

async function initCodeGraph(sourcePath: string) {
  const init = await runRequired("codegraph", ["init", sourcePath], REPO_ROOT, 600_000);
  const statusResult = await runRequired("codegraph", ["status", sourcePath], REPO_ROOT, 120_000);
  return {
    init: { code: init.code, stdoutTail: init.stdout.slice(-2000), stderrTail: init.stderr.slice(-2000) },
    statusCommand: { code: statusResult.code, stdoutTail: statusResult.stdout.slice(-2000), stderrTail: statusResult.stderr.slice(-2000) },
  };
}

function workerIdFor(index: number, options: QueueOptions) {
  if (options.workerCount === 1) return `${options.workerPrefix}-01`;
  return `${options.workerPrefix}-${String((index % options.workerCount) + 1).padStart(2, "0")}`;
}

async function enqueueAssignment({
  hubRoot,
  workerId,
  input,
}: {
  hubRoot: string;
  workerId: string;
  input: AssignmentInput;
}) {
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry(input);
  const attempt = await store.createAttempt(String(assignment.assignmentId), { workerId, orchestratorEpoch: 1 });
  const inboxPath = path.join(hubRoot, "workers", "inbox", workerId, `${assignment.assignmentId}-attempt-${String(attempt.attempt).padStart(3, "0")}.json`);
  await mkdir(path.dirname(inboxPath), { recursive: true });
  await writeJsonAtomic(inboxPath, {
    ...assignment,
    ...attempt,
    workerId,
    status: "assigned",
    sourcePath: input.sourcePath,
    task: input.task,
    workflow: input.workflow,
    planMode: input.planMode,
    sourceContext: input.sourceContext,
    metadata: input.metadata,
  });
  return { assignment, attempt, inboxPath };
}

function buildWorkerIds(options: QueueOptions) {
  return Array.from({ length: options.workerCount }, (_unused, index) => workerIdFor(index, options));
}

function startWorkers(options: QueueOptions) {
  const workerIds = buildWorkerIds(options).slice(0, options.startWorkers);
  const workerScript = path.join(DIST_ROOT, "runtime", "worker", "managed-worker.js");
  return workerIds.map((workerId) => {
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
    child.unref();
    return { workerId, pid: child.pid || null };
  });
}

export async function startQuotaDelegate({
  hubRoot,
  cpbRoot,
  repoRoot = REPO_ROOT,
  distRoot = DIST_ROOT,
  env = process.env,
  spawnImpl = spawn as SpawnLike,
  isDelegateAliveFn = isDelegateAlive,
  readyTimeoutMs = 5_000,
  readyPollMs = 50,
}: {
  hubRoot: string;
  cpbRoot: string;
  repoRoot?: string;
  distRoot?: string;
  env?: Record<string, string | undefined>;
  spawnImpl?: SpawnLike;
  isDelegateAliveFn?: (hubRoot: string) => Promise<boolean> | boolean;
  readyTimeoutMs?: number;
  readyPollMs?: number;
}): Promise<StartedWorker | null> {
  if (await isDelegateAliveFn(hubRoot)) return null;
  const delegateScript = path.join(distRoot, "server", "services", "quota-delegate.js");
  const child = spawnImpl(process.execPath, [
    delegateScript,
    "--hub-root",
    hubRoot,
  ], {
    cwd: repoRoot,
    env: {
      ...env,
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
    },
    detached: true,
    stdio: "ignore",
  });
  if (typeof child.unref === "function") child.unref();

  const deadline = Date.now() + Math.max(0, readyTimeoutMs);
  while (Date.now() <= deadline) {
    if (await isDelegateAliveFn(hubRoot)) {
      return { workerId: "quota-delegate", pid: child.pid || null };
    }
    await delay(Math.max(0, readyPollMs));
  }

  throw new Error(`quota delegate did not become ready for hub ${hubRoot}`);
}

export async function waitForAssignments(
  hubRoot: string,
  assignments: AssignmentRecord[],
  {
    intervalMs = 15_000,
    timeoutMs = 0,
    reason = "batch_wait_timeout",
  }: {
    intervalMs?: number;
    timeoutMs?: number;
    reason?: string;
  } = {},
) {
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  while (true) {
    const states = await Promise.all(assignments.map((assignment) => store.getAssignment(String(assignment.assignmentId))));
    const done = states.every((state) => state?.status && TERMINAL_STATUSES.has(String(state.status)));
    if (done) return states;
    if (deadline > 0 && Date.now() >= deadline) {
      await Promise.all(states.map(async (state) => {
        if (!state?.assignmentId || (state.status && TERMINAL_STATUSES.has(String(state.status)))) return;
        const attempt = await store.getActiveAttempt(String(state.assignmentId));
        if (!attempt) return;
        await store.writeSyntheticFailure(String(state.assignmentId), Number(attempt.attempt), {
          assignmentId: state.assignmentId,
          attempt: attempt.attempt,
          attemptToken: attempt.attemptToken,
          entryId: state.entryId,
          projectId: state.projectId,
          workerId: state.workerId,
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
      }));
      return Promise.all(assignments.map((assignment) => store.getAssignment(String(assignment.assignmentId))));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
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

async function notify(title: string, message: string, enabled: boolean) {
  if (!enabled) return;
  const notification = buildNotificationCommand({ title, message });
  if (!notification) return;
  await runCommand(notification.command, notification.args, REPO_ROOT, 30_000).catch(() => null);
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
  const providerPreflight = await runSweBenchProviderPreflight({
    agents: options.agents,
    handshake: options.providerPreflightMode === "live" ? liveProviderPreflightHandshake : null,
  });
  if (!providerPreflight.ok) {
    await writePreflightFailureOutputs({ options, providerPreflight });
    throw new Error(preflightFailureMessage(providerPreflight));
  }
  const excluded = options.excludeExisting ? await collectExistingInstanceIds(options.excludePaths) : new Set<string>();
  const selected = await discoverRows(options, excluded);
  const assignments: Array<LooseRecord> = [];
  const startedAt = new Date().toISOString();

  await mkdir(options.sourceRoot, { recursive: true });
  await mkdir(options.cpbRoot, { recursive: true });
  await mkdir(options.hubRoot, { recursive: true });

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
      await cloneAtCommit({
        repo: record.representativeRepository,
        baseCommit: record.baseCommit,
        targetDir: sourcePath,
      });
      codegraph = options.skipCodegraph ? null : await initCodeGraph(sourcePath);
      const previousIndexOnly = process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
      process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = "1";
      try {
        await registerProject(options.hubRoot, {
          id: input.projectId,
          name: input.projectId,
          sourcePath,
          metadata: {
            productValidation: true,
            benchmarkDataset: DATASET,
            benchmarkInstanceId: record.benchmarkInstanceId,
            batchQueuedAt: startedAt,
          },
        });
      } finally {
        if (previousIndexOnly === undefined) delete process.env.CPB_CODEGRAPH_INDEX_ONLY_OK;
        else process.env.CPB_CODEGRAPH_INDEX_ONLY_OK = previousIndexOnly;
      }
      const enqueue = await enqueueAssignment({ hubRoot: options.hubRoot, workerId, input });
      queued = {
        assignmentId: enqueue.assignment.assignmentId,
        attempt: enqueue.attempt.attempt,
        attemptToken: enqueue.attempt.attemptToken,
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
    quotaDelegate = await startQuotaDelegate({
      hubRoot: options.hubRoot,
      cpbRoot: options.cpbRoot,
    });
    return startWorkers(options);
  })() : [];
  let workerCleanup = emptyWorkerCleanupEvidence();
  let terminalStates: unknown[] | null = null;
  let cleanupPromise: Promise<WorkerCleanupEvidence> | null = null;
  const cleanupStartedProcesses = (reason: string) => {
    if (!cleanupPromise) {
      const cleanupTargets = [...(quotaDelegate ? [quotaDelegate] : []), ...workers];
      cleanupPromise = cleanupTargets.length > 0
        ? stopStartedWorkers(cleanupTargets, { reason })
        : Promise.resolve(emptyWorkerCleanupEvidence());
    }
    return cleanupPromise;
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    void (async () => {
      workerCleanup = await cleanupStartedProcesses(`signal_${signal.toLowerCase()}`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
  };
  if (workers.length > 0 || quotaDelegate) {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }
  try {
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
      });
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    if (options.wait && (workers.length > 0 || quotaDelegate)) {
      workerCleanup = await cleanupStartedProcesses("batch_wait_completed");
    }
  }

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
  const completion = options.wait && terminalStates
    ? `Completed ${terminalStates.length} SWE-bench assignments`
    : `Queued ${assignments.length} SWE-bench assignments`;
  await notify(options.notifyTitle, `${completion}. Manifest: ${outputs.manifestPath}. Report: ${outputs.reportPath}`, options.notify);
  console.log(`Wrote SWE-bench batch queue manifest: ${outputs.manifestPath}`);
  console.log(`Wrote SWE-bench batch report: ${outputs.reportPath}`);
  console.log(completion);
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
    await notify(
      options?.notifyTitle || "CPB SWE-bench batch",
      `SWE-bench batch queue failed: ${message}`,
      options?.notify ?? true,
    ).catch(() => null);
    process.exitCode = 1;
  });
}
