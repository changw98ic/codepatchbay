import { FailureKind } from "../contracts/failure.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import { PhaseResult } from "../../shared/types.js";
import { PhaseContext } from "./run-phase.js";
import { ProviderAgents } from "./provider-handoff.js";
import { resolveAllowedAgentNames } from "../agents/outcome-routing.js";
import {
  recoveryInstruction,
  selectFailureRecovery,
  type FailureRecoveryDecision,
} from "../contracts/failure-recovery.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";
import type { RunJobProcessHooks } from "./run-job-ports.js";
import type { AppendEvent, ProgressReporter } from "./run-job-shared.js";

type RetryContext = {
  agent?: string | null;
  appendEvent?: AppendEvent;
  onProgress?: ProgressReporter;
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
  scope?: unknown;
  signal?: AbortSignal;
  processHooks?: RunJobProcessHooks;
  env?: NodeJS.ProcessEnv;
  conversationKey?: string | null;
  phaseTimeout: number;
  phaseAgents: ProviderAgents;
  result: PhaseResult;
};

type RetryDeps = {
  phaseRetryMax?: number;
  phaseFeedbackRetryMax?: number;
  phaseQualityRepairMax?: number;
  phaseRetryTotalMax?: number;
  retryableKinds?: Set<string>;
  feedbackRetryKinds?: Set<string>;
  retryBaseDelayMs?: () => number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => string;
  runPhase?: (ctx: PhaseContext) => Promise<PhaseResult>;
};

const FALLBACK_PHASE_RETRY_MAX = 2;
const FALLBACK_PHASE_RETRY_BASE_DELAY_MS = 30_000;
const DEFAULT_PHASE_RETRYABLE_KINDS = new Set<string>([
  FailureKind.AGENT_SPAWN_ERROR,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.TIMEOUT,
  FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT,
]);
const FALLBACK_PHASE_FEEDBACK_RETRY_MAX = 1;
const FALLBACK_PHASE_QUALITY_REPAIR_MAX = 2;
const FALLBACK_PHASE_RETRY_TOTAL_MAX = 3;
const DEFAULT_PHASE_FEEDBACK_RETRY_KINDS = new Set<string>([
  FailureKind.ARTIFACT_INVALID,
  FailureKind.AGENT_CONTRACT_INVALID,
  FailureKind.VERDICT_INVALID,
]);
const CROSS_PHASE_REPAIR_KINDS = new Set<string>([
  FailureKind.VERIFICATION_FAILED,
]);
const HARD_CONSTRAINT_DENIED_KINDS = new Set<string>([
  FailureKind.WEB_TOOL_DENIED,
  FailureKind.READ_ONLY_MUTATION_DENIED,
  FailureKind.BROAD_TEST_COMMAND_DENIED,
  FailureKind.EXECUTE_NO_EDIT_PROGRESS,
  FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED,
  FailureKind.TOOL_BUDGET_EXCEEDED,
]);

function retryEnv(n: Pick<RetryState, "env">): NodeJS.ProcessEnv {
  return n.env ?? process.env;
}

function numericEnv(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function configuredPhaseRetryMax(env: NodeJS.ProcessEnv) {
  return numericEnv(env, "CPB_PHASE_RETRY_MAX", FALLBACK_PHASE_RETRY_MAX);
}

function configuredRetryBaseDelayMs(env: NodeJS.ProcessEnv) {
  return numericEnv(env, "CPB_PHASE_RETRY_BASE_DELAY_MS", FALLBACK_PHASE_RETRY_BASE_DELAY_MS);
}

function configuredPhaseFeedbackRetryMax(env: NodeJS.ProcessEnv) {
  return numericEnv(env, "CPB_PHASE_FEEDBACK_RETRY_MAX", FALLBACK_PHASE_FEEDBACK_RETRY_MAX);
}

function configuredPhaseQualityRepairMax(env: NodeJS.ProcessEnv) {
  return numericEnv(env, "CPB_PHASE_QUALITY_REPAIR_MAX", FALLBACK_PHASE_QUALITY_REPAIR_MAX);
}

function configuredPhaseRetryTotalMax(env: NodeJS.ProcessEnv) {
  return numericEnv(env, "CPB_PHASE_RETRY_TOTAL_MAX", FALLBACK_PHASE_RETRY_TOTAL_MAX);
}

function stringValue(value: unknown): string {
  return String(value || "");
}

function createAbortError(signal: AbortSignal | undefined, message = "Phase retry backoff aborted") {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error(reason ? String(reason) : message) as Error & { code?: string };
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function defaultDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError(signal, "Phase retry aborted");
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
  const env = retryEnv(n);
  const retry = recordValue(sourceContext.retry);
  const freshConversationKey = retry.forceFreshSession === true
    ? `${n.conversationKey || `${n.project}:${n.jobId}:${n.role}`}:retry:${retry.attempt || 1}:${retry.retryStrategy || "fresh"}`
    : n.conversationKey;
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
    sourcePath: n.sourcePath || env.CPB_PROJECT_PATH_OVERRIDE,
    sourceContext,
    pool: n.pool,
    scope: n.scope,
    signal: n.signal,
    processHooks: n.processHooks,
    env,
    state: n.state,
    previousResults: n.phaseResults,
    agent: ctx.agent,
    agents: n.phaseAgents,
    attemptId: n.attemptId,
    conversationKey: freshConversationKey,
    timeouts: phaseTimeouts(n.phaseTimeout),
    onProgress: ctx.onProgress || null,
  };
}

function qualityRepairInstruction(failureKind: string, reason: string, phase = "") {
  if (failureKind === FailureKind.WEB_TOOL_DENIED) {
    return "Do not use web search, browsers, live GitHub, or network lookups. Continue from the local checkout and provided context only.";
  }
  if (failureKind === FailureKind.READ_ONLY_MUTATION_DENIED) {
    if (phase === "verify" || phase === "adversarial_verify") {
      return [
        "Discard the prior verifier verdict and every piece of evidence produced by the violating session.",
        "Retry in a fresh verifier session against a fresh disposable replay of the frozen candidate.",
        "Keep the candidate byte-for-byte unchanged: do not edit source files or tests and do not write build artifacts into the replay worktree.",
        "Use only non-mutating verification commands or an allowed out-of-tree temporary build.",
        "If executable evidence cannot be obtained without a prohibited write, report verification infrastructure unavailable; never infer a pass from the discarded evidence.",
      ].join(" ");
    }
    return "This phase is read-only. Do not edit files or run mutating terminal commands; produce the phase answer from existing evidence only.";
  }
  if (failureKind === FailureKind.BROAD_TEST_COMMAND_DENIED) {
    if (phase === "plan") {
      return "This is the plan phase: do not run tests, python -c probes, heredoc scripts, temporary diagnostics, or transformed verification commands. Plan from CodeGraph, file reads, static code inspection, task text, and explicitly listed verification targets only.";
    }
    if (phase === "execute") {
      return "This is the execute phase: do not run tests, python -c probes, ad hoc scripts, temporary diagnostics, or transformed verification commands. Continue with bounded file inspection, source/test edits, and the structured execution result; leave canonical and diagnostic command execution to verify.";
    }
    return "Use only the exact canonical or explicitly listed diagnostic command allowed for this phase. Do not broaden, wrap, pipe, tail, split, shorten, or invent test commands.";
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

function retryContextFromFailure(
  result: PhaseResult,
  attempt: number,
  retryClass: string,
  recovery: FailureRecoveryDecision,
  phase = "",
  instructionOverride: string | null = null,
) {
  const cause = recordValue(result.failure?.cause);
  const failureKind = stringValue(result.failure?.kind);
  const failureReason = stringValue(result.failure?.reason);
  const handoffCarryForward = recordValue(cause.handoffCarryForward);
  return {
    failureKind,
    failureReason,
    failureClass: recovery.failureClass,
    failureFingerprint: recovery.failureFingerprint,
    failureEvidence: recovery.failureEvidence,
    retryStrategy: recovery.retryStrategy,
    strategyChanged: recovery.strategyChanged,
    forceFreshSession: recovery.forceFreshSession,
    previousOutput: stringValue(result.failure?.stderrSnippet || cause.rawOutput || ""),
    attempt,
    retryClass,
    instruction: instructionOverride
      || (retryClass === "quality_interception" || retryClass === "bounded_handoff_timeout"
        ? qualityRepairInstruction(failureKind, failureReason, phase)
        : recoveryInstruction(recovery.retryStrategy)),
    ...(Object.keys(handoffCarryForward).length > 0 ? { handoffCarryForward } : {}),
  };
}

function configuredExecuteHardConstraintFallbackAgent(env: NodeJS.ProcessEnv) {
  const raw = env.CPB_EXECUTE_HARD_CONSTRAINT_FALLBACK_AGENT;
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

function agentFallbackRetryContext(result: PhaseResult, fallbackAgent: string, recovery: FailureRecoveryDecision) {
  const failureKind = stringValue(result.failure?.kind);
  const failureReason = stringValue(result.failure?.reason);
  const retry = retryContextFromFailure(
    result,
    1,
    "agent_fallback",
    recovery,
    "execute",
    qualityRepairInstruction(failureKind, failureReason, "execute"),
  );
  return {
    ...retry,
    instruction: `Switch the execute actor to ${fallbackAgent} and satisfy the execution contract without repeating the intercepted behavior. ${retry.instruction}`,
  };
}

export async function runPhaseRetryLoops(ctx: RetryContext, n: RetryState, deps: RetryDeps = {}) {
  throwIfAborted(n.signal);
  const env = retryEnv(n);
  const phaseRetryMax = deps.phaseRetryMax ?? configuredPhaseRetryMax(env);
  const phaseFeedbackRetryMax = deps.phaseFeedbackRetryMax ?? configuredPhaseFeedbackRetryMax(env);
  const phaseQualityRepairMax = deps.phaseQualityRepairMax ?? configuredPhaseQualityRepairMax(env);
  const phaseRetryTotalMax = Math.max(0, deps.phaseRetryTotalMax ?? configuredPhaseRetryTotalMax(env));
  const retryableKinds = deps.retryableKinds || DEFAULT_PHASE_RETRYABLE_KINDS;
  const feedbackRetryKinds = deps.feedbackRetryKinds || DEFAULT_PHASE_FEEDBACK_RETRY_KINDS;
  const retryBaseDelayMs = deps.retryBaseDelayMs || (() => configuredRetryBaseDelayMs(env));
  const delay = deps.delay || defaultDelay;
  const now = deps.now || (() => new Date().toISOString());
  const phaseSourceContext = n.phaseSourceContext || {};
  const allowedAgents = resolveAllowedAgentNames(phaseSourceContext);
  let { result } = n;
  let phaseRetryCount = 0;
  let phaseAgentFallback: LooseRecord | null = null;
  const priorRetry = recordValue(phaseSourceContext.retry);
  let previousFingerprint = typeof priorRetry.failureFingerprint === "string" ? priorRetry.failureFingerprint : null;
  let previousStrategy = typeof priorRetry.retryStrategy === "string" ? priorRetry.retryStrategy : null;

  const runPhase = deps.runPhase;
  if (!runPhase) {
    throw new Error("runPhase dependency is required for phase retry loops");
  }

  const prepareRecovery = async (
    currentResult: PhaseResult,
    attempt: number,
    retryClass: string,
    preferredStrategy: string | null = null,
    instructionOverride: string | null = null,
  ) => {
    if (phaseRetryCount >= phaseRetryTotalMax) {
      await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
        type: "retry_decision",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        role: n.role,
        action: "stop_retry_budget_exhausted",
        retryClass,
        attempt,
        retryCount: phaseRetryCount,
        maxRetries: phaseRetryTotalMax,
        reason: `phase retry budget exhausted (${phaseRetryCount}/${phaseRetryTotalMax})`,
        ts: now(),
      });
      return null;
    }
    const recovery = selectFailureRecovery({
      failure: currentResult.failure,
      previousFingerprint,
      previousStrategy,
      preferredStrategy,
      scope: "phase",
    });
    if (!recovery.retryStrategy || !recovery.strategyChanged) {
      await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
        type: "retry_decision",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        role: n.role,
        action: "stop_repeated_failure",
        retryClass,
        attempt,
        failureKind: currentResult.failure?.kind || null,
        failureClass: recovery.failureClass,
        failureFingerprint: recovery.failureFingerprint,
        retryStrategy: recovery.retryStrategy,
        strategyChanged: recovery.strategyChanged,
        failureEvidence: recovery.failureEvidence,
        reason: recovery.stopReason || "retry strategy did not change",
        ts: now(),
      });
      return null;
    }
    const retry = retryContextFromFailure(
      currentResult,
      attempt,
      retryClass,
      recovery,
      n.phase,
      instructionOverride,
    );
    previousFingerprint = recovery.failureFingerprint;
    previousStrategy = recovery.retryStrategy;
    return { recovery, retry };
  };

  const recoveryFields = (recovery: FailureRecoveryDecision) => ({
    failureClass: recovery.failureClass,
    failureFingerprint: recovery.failureFingerprint,
    retryStrategy: recovery.retryStrategy,
    strategyChanged: recovery.strategyChanged,
    forceFreshSession: recovery.forceFreshSession,
    failureEvidence: recovery.failureEvidence,
  });

  let activeState = n;
  const quotaDelegateFailure = String(recordValue(result.failure?.cause).code || "").startsWith("QUOTA_DELEGATE_");
  const fallbackAgent = configuredExecuteHardConstraintFallbackAgent(env);
  const fallbackAllowed = allowedAgents === null || allowedAgents.includes(fallbackAgent);
  const shouldFallback = !quotaDelegateFailure
    && !isPhasePassed(result)
    && shouldFallbackExecuteHardConstraint(ctx, activeState, result, fallbackAgent);
  if (shouldFallback && !fallbackAllowed) {
    const blockedEvent = {
      type: "phase_agent_fallback_blocked",
      jobId: n.jobId,
      project: n.project,
      phase: n.phase,
      role: n.role,
      fromAgent: selectedAgentForPhase(ctx, activeState) || "unknown",
      blockedAgent: fallbackAgent,
      allowedAgents,
      reason: `fallback agent ${fallbackAgent} is outside allowed agent policy`,
    };
    await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, { ...blockedEvent, ts: now() });
    await reportProgress(ctx, blockedEvent, now);
  }
  if (shouldFallback && fallbackAllowed) {
    const fromAgent = selectedAgentForPhase(ctx, activeState) || "unknown";
    const prepared = await prepareRecovery(result, 1, "agent_fallback", "agent_handoff");
    if (!prepared) return result;
    const retry = agentFallbackRetryContext(result, fallbackAgent, prepared.recovery);
    phaseAgentFallback = {
      applied: true,
      count: 1,
      fromAgent,
      toAgent: fallbackAgent,
      failureKind: retry.failureKind,
      reason: retry.failureReason,
    };
    n.phaseAgents[n.role] = fallbackAgent;
    activeState = {
      ...activeState,
      phaseAgents: n.phaseAgents,
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
      ...recoveryFields(prepared.recovery),
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
      ...recoveryFields(prepared.recovery),
    }, now);
    phaseRetryCount += 1;
    throwIfAborted(n.signal);
    result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
  }

  if (!quotaDelegateFailure && !isPhasePassed(result) && phaseQualityRepairMax > 0) {
    for (let qualityAttempt = 1; qualityAttempt <= phaseQualityRepairMax; qualityAttempt += 1) {
      const failureKind = stringValue(result.failure?.kind);
      if (!HARD_CONSTRAINT_DENIED_KINDS.has(failureKind)) break;
      const preferredStrategy = failureKind === FailureKind.BROAD_TEST_COMMAND_DENIED
        ? "correct_test_selection"
        : failureKind === FailureKind.READ_ONLY_MUTATION_DENIED
          && (n.phase === "verify" || n.phase === "adversarial_verify")
          ? "fresh_session_permission_repair"
        : failureKind === FailureKind.EXECUTE_NO_EDIT_PROGRESS || failureKind === FailureKind.TOOL_BUDGET_EXCEEDED
          ? "fresh_session_alternate_approach"
          : "correct_permission_strategy";
      const prepared = await prepareRecovery(result, qualityAttempt, "quality_interception", preferredStrategy);
      if (!prepared) break;
      const { retry, recovery } = prepared;
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
        ...recoveryFields(recovery),
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
        ...recoveryFields(recovery),
      }, now);
      phaseRetryCount += 1;
      throwIfAborted(n.signal);
      result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
      if (isPhasePassed(result)) break;
    }
  }

  if (!quotaDelegateFailure && !isPhasePassed(result) && phaseRetryMax > 0) {
    for (let phaseRetry = 1; phaseRetry <= phaseRetryMax && !isPhasePassed(result); phaseRetry += 1) {
      const failureKind = stringValue(result.failure?.kind);
      const isRetryable = Boolean(result.failure?.retryable) || retryableKinds.has(failureKind);
      if (!isRetryable || HARD_CONSTRAINT_DENIED_KINDS.has(failureKind) || CROSS_PHASE_REPAIR_KINDS.has(failureKind)) break;
      const retryClass = failureKind === FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT
        ? "bounded_handoff_timeout"
        : "transient_failure";
      const prepared = await prepareRecovery(result, phaseRetry, retryClass);
      if (!prepared) break;
      const { retry, recovery } = prepared;
        await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
          type: "phase_retry",
          jobId: n.jobId,
          project: n.project,
          phase: n.phase,
          attempt: phaseRetry,
          maxAttempts: phaseRetryMax,
          failureKind: result.failure?.kind,
          reason: result.failure?.reason,
          carryForward: Boolean(retry.handoffCarryForward),
          ...recoveryFields(recovery),
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
          carryForward: Boolean(retry.handoffCarryForward),
          ...recoveryFields(recovery),
        }, now);
        await delay(retryBaseDelayMs() * phaseRetry, n.signal);
        phaseRetryCount += 1;
      throwIfAborted(n.signal);
      result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
    }
  }

  if (!isPhasePassed(result) && phaseFeedbackRetryMax > 0 && feedbackRetryKinds.has(stringValue(result.failure?.kind))) {
    for (let retryAttempt = 1; retryAttempt <= phaseFeedbackRetryMax; retryAttempt += 1) {
      const failureKind = stringValue(result.failure?.kind);
      const verdictInvalid = failureKind === FailureKind.VERDICT_INVALID;
      const prepared = await prepareRecovery(
        result,
        retryAttempt,
        "contract_feedback",
        verdictInvalid ? "rebuild_evidence" : "contract_repair",
        verdictInvalid
          ? `Correct the verifier verdict contract using this validation error, keep the candidate unchanged, and reference only frozen checklist ids: ${stringValue(result.failure?.reason)}`
          : null,
      );
      if (!prepared) break;
      const { retry, recovery } = prepared;
      await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
        type: "phase_feedback_retry",
        jobId: n.jobId,
        project: n.project,
        phase: n.phase,
        attempt: retryAttempt,
        maxAttempts: phaseFeedbackRetryMax,
        failureKind: retry.failureKind,
        reason: retry.failureReason,
        ...recoveryFields(recovery),
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
        ...recoveryFields(recovery),
      }, now);
      phaseRetryCount += 1;
      throwIfAborted(n.signal);
      result = await runPhase(phaseInput(ctx, activeState, { ...phaseSourceContext, retry }));
      if (isPhasePassed(result)) break;
    }
  }

  if (phaseRetryCount > 0) {
    result = {
      ...result,
      diagnostics: {
        ...recordValue(result.diagnostics),
        phaseRetryCount,
        ...(phaseAgentFallback ? { phaseAgentFallback } : {}),
      },
    };
  }

  return result;
}
