import { FailureKind } from "../contracts/failure.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import { PhaseResult } from "../../shared/types.js";
import { PhaseContext } from "./run-phase.js";
import { ProviderAgents } from "./provider-handoff.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type RetryContext = {
  agent?: string | null;
  appendEvent?: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: (event: LooseRecord) => Promise<unknown> | unknown;
};

type RetryState = {
  phase: string;
  role: string;
  nodeId: string;
  dagNode: LooseRecord;
  project: string;
  task: string;
  jobId: string;
  job: LooseRecord;
  workflow?: string;
  planMode?: string;
  cpbRoot: string;
  dataRoot?: string | null;
  sourcePath?: string | null;
  phaseSourceContext?: LooseRecord;
  pool?: LooseRecord | null;
  state: LooseRecord;
  phaseResults: LooseRecord[];
  attemptId?: string | null;
  phaseTimeout: number;
  phaseAgents: ProviderAgents;
  result: PhaseResult;
};

type RetryDeps = {
  phaseRetryMax?: number;
  phaseFeedbackRetryMax?: number;
  phaseQualityRepairMax?: number;
  retryableKinds?: Set<string>;
  feedbackRetryKinds?: Set<string>;
  retryBaseDelayMs?: () => number;
  delay?: (ms: number) => Promise<void>;
  now?: () => string;
  runPhase?: (ctx: PhaseContext) => Promise<PhaseResult>;
};

const DEFAULT_PHASE_RETRY_MAX = Number(process.env.CPB_PHASE_RETRY_MAX || 2);
const DEFAULT_PHASE_RETRY_BASE_DELAY_MS = Number(process.env.CPB_PHASE_RETRY_BASE_DELAY_MS || 30_000);
const DEFAULT_PHASE_RETRYABLE_KINDS = new Set<string>([
  FailureKind.AGENT_SPAWN_ERROR,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.TIMEOUT,
  FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT,
  FailureKind.RUNTIME_INTERRUPTED,
]);
const DEFAULT_PHASE_FEEDBACK_RETRY_MAX = Number(process.env.CPB_PHASE_FEEDBACK_RETRY_MAX || 1);
const DEFAULT_PHASE_QUALITY_REPAIR_MAX = Number(process.env.CPB_PHASE_QUALITY_REPAIR_MAX || 2);
const DEFAULT_PHASE_FEEDBACK_RETRY_KINDS = new Set<string>([
  FailureKind.ARTIFACT_INVALID,
  FailureKind.AGENT_CONTRACT_INVALID,
]);
const CROSS_PHASE_REPAIR_KINDS = new Set<string>([
  FailureKind.VERIFICATION_FAILED,
]);
const HARD_CONSTRAINT_DENIED_KINDS = new Set<string>([
  FailureKind.WEB_TOOL_DENIED,
  FailureKind.READ_ONLY_MUTATION_DENIED,
  FailureKind.BROAD_TEST_COMMAND_DENIED,
  FailureKind.SWEBENCH_EXECUTE_TERMINAL_DENIED,
  FailureKind.SWEBENCH_EXECUTE_NO_EDIT_PROGRESS,
  FailureKind.EXECUTE_NO_EDIT_PROGRESS,
  FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED,
  FailureKind.TOOL_BUDGET_EXCEEDED,
]);

function numericEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function defaultRetryBaseDelayMs() {
  return numericEnv("CPB_PHASE_RETRY_BASE_DELAY_MS", DEFAULT_PHASE_RETRY_BASE_DELAY_MS);
}

function stringValue(value: unknown): string {
  return String(value || "");
}

function defaultDelay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function reportProgress(ctx: RetryContext, event: LooseRecord, now: () => string) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: now(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

async function appendRuntimeEvent(
  ctx: RetryContext,
  cpbRoot: string,
  project: string,
  jobId: string,
  event: LooseRecord,
) {
  if (typeof ctx.appendEvent !== "function") return;
  await ctx.appendEvent(cpbRoot, project, jobId, event);
}

function phaseTimeouts(phaseTimeout: number) {
  return {
    plan: phaseTimeout,
    execute: phaseTimeout,
    verify: phaseTimeout,
    adversarial_verify: phaseTimeout,
    review: phaseTimeout,
    remediate: phaseTimeout,
  };
}

function phaseInput(ctx: RetryContext, n: RetryState, sourceContext: LooseRecord) {
  return {
    phase: n.phase,
    role: n.role,
    nodeId: n.nodeId,
    dagNode: n.dagNode,
    project: n.project,
    task: n.task,
    jobId: n.jobId,
    job: n.job,
    workflow: n.workflow,
    planMode: n.planMode,
    cpbRoot: n.cpbRoot,
    dataRoot: n.dataRoot,
    sourcePath: n.sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
    sourceContext,
    pool: n.pool,
    state: n.state,
    previousResults: n.phaseResults,
    agent: ctx.agent,
    agents: n.phaseAgents,
    attemptId: n.attemptId,
    timeouts: phaseTimeouts(n.phaseTimeout),
  };
}

function qualityRepairInstruction(failureKind: string, reason: string, phase = "") {
  if (failureKind === FailureKind.WEB_TOOL_DENIED) {
    return "Do not use web search, browsers, live GitHub, or network lookups. Continue from the local checkout and provided context only.";
  }
  if (failureKind === FailureKind.READ_ONLY_MUTATION_DENIED) {
    return "This phase is read-only. Do not edit files or run mutating terminal commands; produce the phase answer from existing evidence only.";
  }
  if (failureKind === FailureKind.BROAD_TEST_COMMAND_DENIED) {
    if (phase === "plan") {
      return "This is the plan phase: do not run tests, python -c probes, heredoc scripts, temporary diagnostics, or transformed verification commands. Plan from CodeGraph, file reads, static code inspection, task text, and listed benchmark tests only.";
    }
    if (phase === "execute") {
      return "This is the execute phase: do not run tests, python -c probes, ad hoc scripts, temporary diagnostics, or transformed verification commands. Continue with bounded file inspection, source/test edits, and the structured execution result; leave canonical and diagnostic command execution to verify.";
    }
    return "Use only the exact canonical or explicitly listed diagnostic command allowed for this phase. Do not broaden, wrap, pipe, tail, split, shorten, or invent test commands.";
  }
  if (failureKind === FailureKind.SWEBENCH_EXECUTE_TERMINAL_DENIED) {
    return "This is the SWE-bench execute phase: do not use terminal or shell commands. Inspect the files named by the plan first with bounded read/search tools, then make the planned source/test edits or report a concrete blocker in the structured execution result.";
  }
  if (failureKind === FailureKind.SWEBENCH_EXECUTE_NO_EDIT_PROGRESS) {
    return "This is the SWE-bench execute phase: Stop re-reading and searching. Use the plan plus the files already inspected, make the planned source/test edit now, or report a concrete blocker in the structured execution result.";
  }
  if (failureKind === FailureKind.EXECUTE_NO_EDIT_PROGRESS) {
    return "This is the execute phase: Stop re-reading and searching. Use the plan plus the files already inspected, make the planned source/test edit now, or report a concrete blocker in the structured execution result.";
  }
  if (failureKind === FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED) {
    return "Do not scan the whole filesystem. Restrict inspection to the project checkout, assigned worktree, and explicitly provided paths.";
  }
  if (failureKind === FailureKind.TOOL_BUDGET_EXCEEDED) {
    return "Reduce tool use immediately. Use the current context, make the smallest necessary inspection, and return the required structured result.";
  }
  if (failureKind === FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT) {
    return "This is the plan phase: reuse the carry-forward static evidence from the timed-out attempt. Do not restart broad exploration; complete the Bounded Handoff now or report a concrete blocker.";
  }
  return `Correct the intercepted behavior and rerun the same phase without repeating this failure: ${reason}`;
}

function retryContextFromFailure(result: PhaseResult, attempt: number, retryClass: string, phase = "") {
  const cause = recordValue(result.failure?.cause);
  const failureKind = stringValue(result.failure?.kind);
  const failureReason = stringValue(result.failure?.reason);
  const handoffCarryForward = recordValue(cause.handoffCarryForward);
  return {
    failureKind,
    failureReason,
    previousOutput: stringValue(result.failure?.stderrSnippet || cause.rawOutput || ""),
    attempt,
    retryClass,
    instruction: qualityRepairInstruction(failureKind, failureReason, phase),
    ...(Object.keys(handoffCarryForward).length > 0 ? { handoffCarryForward } : {}),
  };
}

function configuredExecuteHardConstraintFallbackAgent() {
  const raw = process.env.CPB_EXECUTE_HARD_CONSTRAINT_FALLBACK_AGENT;
  if (raw === undefined) return "codex";
  const trimmed = raw.trim();
  if (!trimmed || /^(0|false|off|none|null)$/i.test(trimmed)) return "";
  return trimmed;
}

function providerAgentName(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const record = recordValue(raw);
  return stringValue(record.agent || record.name);
}

function selectedAgentForPhase(ctx: RetryContext, n: RetryState): string {
  return providerAgentName(n.phaseAgents?.[n.role]) || stringValue(ctx.agent);
}

function shouldFallbackExecuteHardConstraint(
  ctx: RetryContext,
  n: RetryState,
  result: PhaseResult,
  fallbackAgent: string,
) {
  if (n.phase !== "execute") return false;
  if (!fallbackAgent) return false;
  const failureKind = stringValue(result.failure?.kind);
  if (!HARD_CONSTRAINT_DENIED_KINDS.has(failureKind)) return false;
  return selectedAgentForPhase(ctx, n) !== fallbackAgent;
}

function agentFallbackRetryContext(result: PhaseResult, fallbackAgent: string) {
  const retry = retryContextFromFailure(result, 1, "agent_fallback", "execute");
  return {
    ...retry,
    instruction: `Switch the execute actor to ${fallbackAgent} and satisfy the execution contract without repeating the intercepted behavior. ${retry.instruction}`,
  };
}

export async function runPhaseRetryLoops(ctx: RetryContext, n: RetryState, deps: RetryDeps = {}) {
  const phaseRetryMax = deps.phaseRetryMax ?? DEFAULT_PHASE_RETRY_MAX;
  const phaseFeedbackRetryMax = deps.phaseFeedbackRetryMax ?? DEFAULT_PHASE_FEEDBACK_RETRY_MAX;
  const phaseQualityRepairMax = deps.phaseQualityRepairMax ?? DEFAULT_PHASE_QUALITY_REPAIR_MAX;
  const retryableKinds = deps.retryableKinds || DEFAULT_PHASE_RETRYABLE_KINDS;
  const feedbackRetryKinds = deps.feedbackRetryKinds || DEFAULT_PHASE_FEEDBACK_RETRY_KINDS;
  const retryBaseDelayMs = deps.retryBaseDelayMs || defaultRetryBaseDelayMs;
  const delay = deps.delay || defaultDelay;
  const now = deps.now || (() => new Date().toISOString());
  const phaseSourceContext = n.phaseSourceContext || {};
  let { result } = n;

  const runPhase = deps.runPhase;
  if (!runPhase) {
    throw new Error("runPhase dependency is required for phase retry loops");
  }

  let activeState = n;
  const quotaDelegateFailure = String(recordValue(result.failure?.cause).code || "").startsWith("QUOTA_DELEGATE_");
  const fallbackAgent = configuredExecuteHardConstraintFallbackAgent();
  if (!quotaDelegateFailure && !isPhasePassed(result) && shouldFallbackExecuteHardConstraint(ctx, activeState, result, fallbackAgent)) {
    const fromAgent = selectedAgentForPhase(ctx, activeState) || "unknown";
    const retry = agentFallbackRetryContext(result, fallbackAgent);
    activeState = {
      ...activeState,
      phaseAgents: {
        ...activeState.phaseAgents,
        [activeState.role]: fallbackAgent,
      },
    };
    await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
      type: "phase_agent_fallback",
      jobId: n.jobId,
      project: n.project,
      phase: n.phase,
      role: n.role,
      fromAgent,
      toAgent: fallbackAgent,
      failureKind: retry.failureKind,
      reason: retry.failureReason,
      instruction: retry.instruction,
      ts: now(),
    });
    await reportProgress(ctx, {
      type: "phase_agent_fallback",
      jobId: n.jobId,
      project: n.project,
      phase: n.phase,
      role: n.role,
      fromAgent,
      toAgent: fallbackAgent,
      failureKind: retry.failureKind,
      reason: retry.failureReason,
      instruction: retry.instruction,
    }, now);
    result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
  }

  if (!quotaDelegateFailure && !isPhasePassed(result) && phaseQualityRepairMax > 0) {
    for (let qualityAttempt = 1; qualityAttempt <= phaseQualityRepairMax; qualityAttempt += 1) {
      const failureKind = stringValue(result.failure?.kind);
      if (!HARD_CONSTRAINT_DENIED_KINDS.has(failureKind)) break;
      const retry = retryContextFromFailure(result, qualityAttempt, "quality_interception", n.phase);
      await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
        type: "phase_quality_retry",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        attempt: qualityAttempt,
        maxAttempts: phaseQualityRepairMax,
        failureKind: retry.failureKind,
        reason: retry.failureReason,
        instruction: retry.instruction,
        ts: now(),
      });
      await reportProgress(ctx, {
        type: "phase_quality_retry",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        attempt: qualityAttempt,
        maxAttempts: phaseQualityRepairMax,
        failureKind: retry.failureKind,
        reason: retry.failureReason,
        instruction: retry.instruction,
      }, now);
      result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
      if (isPhasePassed(result)) break;
    }
  }

  if (!quotaDelegateFailure && !isPhasePassed(result) && phaseRetryMax > 0) {
    const failureKind = stringValue(result.failure?.kind);
    const isRetryable = Boolean(result.failure?.retryable) || retryableKinds.has(failureKind);
    if (isRetryable && !HARD_CONSTRAINT_DENIED_KINDS.has(failureKind) && !CROSS_PHASE_REPAIR_KINDS.has(failureKind)) {
      for (let phaseRetry = 1; phaseRetry <= phaseRetryMax; phaseRetry += 1) {
        const retry = failureKind === FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT
          ? retryContextFromFailure(result, phaseRetry, "bounded_handoff_timeout", n.phase)
          : null;
        await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
          type: "phase_retry",
          jobId: n.jobId,
          project: n.project,
          phase: n.phase,
          attempt: phaseRetry,
          maxAttempts: phaseRetryMax,
          failureKind: result.failure?.kind,
          reason: result.failure?.reason,
          carryForward: Boolean(retry?.handoffCarryForward),
          ts: now(),
        });
        await reportProgress(ctx, {
          type: "phase_retry",
          jobId: n.jobId,
          project: n.project,
          phase: n.phase,
          attempt: phaseRetry,
          maxAttempts: phaseRetryMax,
          failureKind: result.failure?.kind,
          reason: result.failure?.reason,
          carryForward: Boolean(retry?.handoffCarryForward),
        }, now);
        await delay(retryBaseDelayMs() * phaseRetry);
        result = await runPhase(phaseInput(ctx, activeState, retry ? { ...phaseSourceContext, retry } : phaseSourceContext));
        if (isPhasePassed(result)) break;
      }
    }
  }

  if (!isPhasePassed(result) && phaseFeedbackRetryMax > 0 && feedbackRetryKinds.has(stringValue(result.failure?.kind))) {
    for (let retryAttempt = 1; retryAttempt <= phaseFeedbackRetryMax; retryAttempt += 1) {
      const cause = recordValue(result.failure?.cause);
      const retry = {
        failureKind: result.failure?.kind,
        failureReason: result.failure?.reason,
        previousOutput: stringValue(result.failure?.stderrSnippet || cause.rawOutput || ""),
        attempt: retryAttempt,
      };
      await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
        type: "phase_feedback_retry",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        attempt: retryAttempt,
        maxAttempts: phaseFeedbackRetryMax,
        failureKind: retry.failureKind,
        reason: retry.failureReason,
        ts: now(),
      });
      await reportProgress(ctx, {
        type: "phase_feedback_retry",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        attempt: retryAttempt,
        maxAttempts: phaseFeedbackRetryMax,
        failureKind: retry.failureKind,
        reason: retry.failureReason,
      }, now);
      result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
      if (isPhasePassed(result)) break;
    }
  }

  return result;
}
