import { FailureKind } from "../contracts/failure.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import { ProviderAgents } from "./provider-handoff.js";

type LooseRecord = Record<string, unknown>;

type PhaseFailure = {
  kind?: unknown;
  reason?: unknown;
  retryable?: unknown;
  stderrSnippet?: unknown;
  cause?: unknown;
};

type PhaseResult = {
  status?: string;
  failure?: PhaseFailure | null;
  [key: string]: unknown;
};

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
  retryableKinds?: Set<string>;
  feedbackRetryKinds?: Set<string>;
  retryBaseDelayMs?: () => number;
  delay?: (ms: number) => Promise<void>;
  now?: () => string;
  runPhase?: (input: LooseRecord) => Promise<PhaseResult>;
};

const DEFAULT_PHASE_RETRY_MAX = Number(process.env.CPB_PHASE_RETRY_MAX || 2);
const DEFAULT_PHASE_RETRY_BASE_DELAY_MS = Number(process.env.CPB_PHASE_RETRY_BASE_DELAY_MS || 30_000);
const DEFAULT_PHASE_RETRYABLE_KINDS = new Set<string>([
  FailureKind.AGENT_SPAWN_ERROR,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.TIMEOUT,
  FailureKind.RUNTIME_INTERRUPTED,
]);
const DEFAULT_PHASE_FEEDBACK_RETRY_MAX = Number(process.env.CPB_PHASE_FEEDBACK_RETRY_MAX || 1);
const DEFAULT_PHASE_FEEDBACK_RETRY_KINDS = new Set<string>([
  FailureKind.ARTIFACT_INVALID,
  FailureKind.AGENT_CONTRACT_INVALID,
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

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
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

export async function runPhaseRetryLoops(ctx: RetryContext, n: RetryState, deps: RetryDeps = {}) {
  const phaseRetryMax = deps.phaseRetryMax ?? DEFAULT_PHASE_RETRY_MAX;
  const phaseFeedbackRetryMax = deps.phaseFeedbackRetryMax ?? DEFAULT_PHASE_FEEDBACK_RETRY_MAX;
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

  const quotaDelegateFailure = String(recordValue(result.failure?.cause).code || "").startsWith("QUOTA_DELEGATE_");
  if (!quotaDelegateFailure && !isPhasePassed(result) && phaseRetryMax > 0) {
    const failureKind = stringValue(result.failure?.kind);
    const isRetryable = Boolean(result.failure?.retryable) || retryableKinds.has(failureKind);
    if (isRetryable) {
      for (let phaseRetry = 1; phaseRetry <= phaseRetryMax; phaseRetry += 1) {
        await appendRuntimeEvent(ctx, n.cpbRoot, n.project, n.jobId, {
          type: "phase_retry",
          jobId: n.jobId,
          project: n.project,
          phase: n.phase,
          attempt: phaseRetry,
          maxAttempts: phaseRetryMax,
          failureKind: result.failure?.kind,
          reason: result.failure?.reason,
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
        }, now);
        await delay(retryBaseDelayMs() * phaseRetry);
        result = await runPhase(phaseInput(ctx, n, phaseSourceContext));
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
        previousOutput: result.failure?.stderrSnippet || cause.rawOutput || "",
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
      result = await runPhase(phaseInput(ctx, n, { ...phaseSourceContext, retry }));
      if (isPhasePassed(result)) break;
    }
  }

  return result;
}
