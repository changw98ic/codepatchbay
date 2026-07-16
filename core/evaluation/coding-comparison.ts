import { createHash } from "node:crypto";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";

export const CODING_COMPARISON_SCHEMA_VERSION = 1;
export const CODING_COMPARISON_LANES = ["native_codex", "cpb_codex", "cpb_smart"] as const;

export type CodingComparisonLane = typeof CODING_COMPARISON_LANES[number];

export type CodingComparisonCheck = {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
};

export type CodingComparisonTask = {
  id: string;
  repository: string;
  base: string;
  task: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  timeoutMs: number;
  checks: CodingComparisonCheck[];
};

export type CodingComparisonManifest = {
  schemaVersion: 1;
  tasks: CodingComparisonTask[];
};

export type LaneMetrics = {
  correct: boolean;
  firstPass: boolean;
  repairCount: number;
  toolCalls: number | null;
  failedToolCalls: number | null;
  solverElapsedMs: number;
  evaluationElapsedMs: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  tokenCoverage: number;
};

export type CodingComparisonLaneResult = {
  lane: CodingComparisonLane;
  taskId: string;
  inputFingerprint: string;
  evaluationFingerprint: string;
  permissionFingerprint: string;
  baseSha: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  status: string;
  metrics: LaneMetrics;
  [key: string]: unknown;
};

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "tasks"]);
const TASK_KEYS = new Set([
  "id",
  "repository",
  "base",
  "task",
  "model",
  "reasoningEffort",
  "timeoutMs",
  "checks",
]);
const CHECK_KEYS = new Set(["id", "command", "args", "cwd", "timeoutMs"]);
const FORBIDDEN_ORACLE_KEYS = /^(?:fail_?to_?pass|pass_?to_?pass|gold_?patch|expected_?patch|official_?answer|oracle|reference_?patch)$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function assertKnownKeys(value: LooseRecord, allowed: Set<string>, field: string) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_ORACLE_KEYS.test(key)) {
      throw new Error(`${field} contains forbidden solver-oracle field ${JSON.stringify(key)}`);
    }
    if (!allowed.has(key)) throw new Error(`${field} contains unknown field ${JSON.stringify(key)}`);
  }
}

function relativeCwd(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const cwd = text(value, field).replace(/\\/g, "/");
  if (cwd.startsWith("/") || cwd === ".." || cwd.startsWith("../") || cwd.includes("/../")) {
    throw new Error(`${field} must remain inside the lane worktree`);
  }
  return cwd;
}

function validateCheck(raw: unknown, taskIndex: number, checkIndex: number): CodingComparisonCheck {
  if (!isRecord(raw)) throw new Error(`tasks[${taskIndex}].checks[${checkIndex}] must be an object`);
  const field = `tasks[${taskIndex}].checks[${checkIndex}]`;
  assertKnownKeys(raw, CHECK_KEYS, field);
  const id = text(raw.id, `${field}.id`);
  if (!SAFE_ID.test(id)) throw new Error(`${field}.id is unsafe`);
  const command = text(raw.command, `${field}.command`);
  if (!Array.isArray(raw.args) || raw.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${field}.args must be an array of strings`);
  }
  return {
    id,
    command,
    args: raw.args.map(String),
    ...(raw.cwd === undefined ? {} : { cwd: relativeCwd(raw.cwd, `${field}.cwd`) }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: positiveInteger(raw.timeoutMs, `${field}.timeoutMs`) }),
  };
}

function validateTask(raw: unknown, index: number): CodingComparisonTask {
  if (!isRecord(raw)) throw new Error(`tasks[${index}] must be an object`);
  const field = `tasks[${index}]`;
  assertKnownKeys(raw, TASK_KEYS, field);
  const id = text(raw.id, `${field}.id`);
  if (!SAFE_ID.test(id)) throw new Error(`${field}.id is unsafe`);
  const effort = text(raw.reasoningEffort, `${field}.reasoningEffort`).toLowerCase();
  if (!REASONING_EFFORTS.has(effort)) throw new Error(`${field}.reasoningEffort is invalid`);
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new Error(`${field}.checks must contain at least one post-terminal evaluator check`);
  }
  const checks = raw.checks.map((check, checkIndex) => validateCheck(check, index, checkIndex));
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error(`${field}.checks contains duplicate ids`);
  }
  return {
    id,
    repository: text(raw.repository, `${field}.repository`),
    base: text(raw.base, `${field}.base`),
    task: text(raw.task, `${field}.task`),
    model: text(raw.model, `${field}.model`),
    reasoningEffort: effort as CodingComparisonTask["reasoningEffort"],
    timeoutMs: positiveInteger(raw.timeoutMs, `${field}.timeoutMs`),
    checks,
  };
}

export function validateCodingComparisonManifest(raw: unknown): CodingComparisonManifest {
  if (!isRecord(raw)) throw new Error("comparison manifest must be an object");
  assertKnownKeys(raw, TOP_LEVEL_KEYS, "manifest");
  if (raw.schemaVersion !== CODING_COMPARISON_SCHEMA_VERSION) {
    throw new Error(`comparison manifest schemaVersion must be ${CODING_COMPARISON_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error("comparison manifest tasks must be a non-empty array");
  }
  const tasks = raw.tasks.map(validateTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("comparison manifest contains duplicate task ids");
  }
  return { schemaVersion: CODING_COMPARISON_SCHEMA_VERSION, tasks };
}

function digest(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function codingComparisonInputFingerprint(task: CodingComparisonTask, baseSha: string) {
  return digest({
    task: task.task,
    baseSha,
    model: task.model,
    reasoningEffort: task.reasoningEffort,
    timeoutMs: task.timeoutMs,
  });
}

export function codingComparisonEvaluationFingerprint(task: CodingComparisonTask) {
  return digest(task.checks.map((check) => ({
    id: check.id,
    command: check.command,
    args: check.args,
    cwd: check.cwd || ".",
    timeoutMs: check.timeoutMs || null,
  })));
}

export function codingComparisonPermissionFingerprint() {
  return digest({
    approvalPolicy: "never",
    profile: "headless",
    maximumWorktreeAccess: "workspace-write",
    tools: ["codegraph", "file-edit", "terminal"],
    uiTools: false,
    evaluatorVisibleDuringSolve: false,
  });
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function usageCandidate(value: unknown): LooseRecord | null {
  if (!isRecord(value)) return null;
  const inputTokens = finiteOrNull(value.inputTokens ?? value.input_tokens);
  const cachedInputTokens = finiteOrNull(value.cachedInputTokens ?? value.cached_input_tokens);
  const outputTokens = finiteOrNull(value.outputTokens ?? value.output_tokens);
  const reasoningOutputTokens = finiteOrNull(value.reasoningOutputTokens ?? value.reasoning_output_tokens);
  const totalTokens = finiteOrNull(value.totalTokens ?? value.total_tokens);
  if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens].every((entry) => entry === null)) {
    return null;
  }
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

function collectUsageCandidates(value: unknown, output: LooseRecord[], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  const candidate = usageCandidate(value);
  if (candidate) output.push(candidate);
  if (Array.isArray(value)) {
    for (const entry of value) collectUsageCandidates(entry, output, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectUsageCandidates(entry, output, depth + 1);
  }
}

export function extractCodingComparisonTelemetry(...values: unknown[]) {
  const usageCandidates: LooseRecord[] = [];
  for (const value of values) collectUsageCandidates(value, usageCandidates);
  const usage = usageCandidates.sort((left, right) => (
    Number(right.totalTokens ?? -1) - Number(left.totalTokens ?? -1)
  ))[0] || {};
  const tokenFields = ["inputTokens", "outputTokens", "totalTokens"];
  return {
    inputTokens: finiteOrNull(usage.inputTokens),
    cachedInputTokens: finiteOrNull(usage.cachedInputTokens),
    outputTokens: finiteOrNull(usage.outputTokens),
    reasoningOutputTokens: finiteOrNull(usage.reasoningOutputTokens),
    totalTokens: finiteOrNull(usage.totalTokens),
    tokenCoverage: tokenFields.filter((field) => finiteOrNull(usage[field]) !== null).length / tokenFields.length,
  };
}

function nativeToolIdentity(event: LooseRecord, lineNumber: number) {
  const payload = recordValue(event.payload);
  const item = recordValue(event.item || payload.item || payload);
  const type = String(item.type || event.type || "");
  if (!/(?:tool|command|file_change|mcp|function_call|custom_tool_call)/i.test(type)) return null;
  return String(item.id || item.call_id || item.callId || event.id || event.call_id || `${type}:${lineNumber}`);
}

export function parseNativeCodexJsonl(raw: string) {
  const usageCandidates: LooseRecord[] = [];
  const tools = new Map<string, { failed: boolean }>();
  let finalOutput = "";
  let malformedLines = 0;
  for (const [lineIndex, line] of String(raw || "").split("\n").entries()) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    collectUsageCandidates(event, usageCandidates);
    const record = recordValue(event);
    const payload = recordValue(record.payload);
    const item = recordValue(record.item || payload.item || payload);
    const identity = nativeToolIdentity(record, lineIndex + 1);
    if (identity) {
      const status = String(item.status || record.status || "").toLowerCase();
      const exitCode = finiteOrNull(item.exit_code ?? item.exitCode ?? record.exit_code ?? record.exitCode);
      const prior = tools.get(identity) || { failed: false };
      prior.failed = prior.failed || status === "failed" || status === "error" || (exitCode !== null && exitCode !== 0);
      tools.set(identity, prior);
    }
    const message = item.text || item.message || payload.last_agent_message || record.last_agent_message;
    if (typeof message === "string" && message.trim()) finalOutput = message.trim();
  }
  const usage = extractCodingComparisonTelemetry(...usageCandidates);
  return {
    ...usage,
    toolCalls: malformedLines === 0 ? tools.size : null,
    failedToolCalls: malformedLines === 0 ? [...tools.values()].filter((tool) => tool.failed).length : null,
    finalOutput: finalOutput || null,
    malformedLines,
  };
}

function aggregateLane(results: CodingComparisonLaneResult[], lane: CodingComparisonLane) {
  const selected = results.filter((result) => result.lane === lane);
  const sum = (selector: (metrics: LaneMetrics) => number) => selected.reduce((total, result) => total + selector(result.metrics), 0);
  const knownToolResults = selected.filter((result) => result.metrics.toolCalls !== null);
  return {
    lane,
    tasks: selected.length,
    correct: sum((metrics) => Number(metrics.correct)),
    correctRate: selected.length > 0 ? sum((metrics) => Number(metrics.correct)) / selected.length : null,
    firstPass: sum((metrics) => Number(metrics.firstPass)),
    firstPassRate: selected.length > 0 ? sum((metrics) => Number(metrics.firstPass)) / selected.length : null,
    repairCount: sum((metrics) => metrics.repairCount),
    toolCalls: knownToolResults.length > 0 ? sum((metrics) => metrics.toolCalls || 0) : null,
    failedToolCalls: knownToolResults.length > 0 ? sum((metrics) => metrics.failedToolCalls || 0) : null,
    solverElapsedMs: sum((metrics) => metrics.solverElapsedMs),
    tokenCoverage: selected.length > 0 ? sum((metrics) => metrics.tokenCoverage) / selected.length : 0,
  };
}

export function classifyCpbCodexDelta(nativeResult: CodingComparisonLaneResult, cpbResult: CodingComparisonLaneResult) {
  if (nativeResult.metrics.correct && !cpbResult.metrics.correct) return "cpb_codex_regression";
  if (!nativeResult.metrics.correct && cpbResult.metrics.correct) return "cpb_codex_advantage";
  if (nativeResult.metrics.correct && cpbResult.metrics.correct) return "correctness_parity";
  return "both_failed";
}

export function buildCodingComparisonSummary(results: CodingComparisonLaneResult[]) {
  const byTask: LooseRecord[] = [];
  const taskIds = [...new Set(results.map((result) => result.taskId))];
  for (const taskId of taskIds) {
    const taskResults = results.filter((result) => result.taskId === taskId);
    const native = taskResults.find((result) => result.lane === "native_codex");
    const cpb = taskResults.find((result) => result.lane === "cpb_codex");
    const smart = taskResults.find((result) => result.lane === "cpb_smart");
    const fingerprints = new Set(taskResults.map((result) => result.inputFingerprint));
    const evaluationFingerprints = new Set(taskResults.map((result) => result.evaluationFingerprint));
    const permissionFingerprints = new Set(taskResults.map((result) => result.permissionFingerprint));
    const bases = new Set(taskResults.map((result) => result.baseSha));
    byTask.push({
      taskId,
      complete: Boolean(native && cpb && smart),
      fairness: {
        sameInput: fingerprints.size === 1,
        sameEvaluation: evaluationFingerprints.size === 1,
        samePermissionContract: permissionFingerprints.size === 1,
        sameBase: bases.size === 1,
      },
      cpbCodexDelta: native && cpb ? classifyCpbCodexDelta(native, cpb) : "incomplete",
      smartCorrect: smart?.metrics.correct ?? null,
    });
  }
  return {
    schemaVersion: CODING_COMPARISON_SCHEMA_VERSION,
    lanes: CODING_COMPARISON_LANES.map((lane) => aggregateLane(results, lane)),
    byTask,
    cpbCodexRegressions: byTask.filter((task) => task.cpbCodexDelta === "cpb_codex_regression").map((task) => task.taskId),
    fairnessComplete: byTask.every((task) => (
      task.complete === true
      && recordValue(task.fairness).sameInput === true
      && recordValue(task.fairness).sameEvaluation === true
      && recordValue(task.fairness).samePermissionContract === true
      && recordValue(task.fairness).sameBase === true
    )),
  };
}
