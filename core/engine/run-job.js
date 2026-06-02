/**
 * Engine.runJob — native phase state machine.
 *
 * Creates a job, resolves phases from workflow, runs each phase via
 * native adapters (core/phases/*.js).  Returns structured JobResult.
 *
 * All infrastructure services (createJob, appendEvent, etc.) are
 * injected via ctx — no server/ imports in core/.
 */

import { runPhase } from "./run-phase.js";
import { resolvePhases } from "./workflow-runner.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { generateHandoffBundle } from "../handoff/handoff-bundle.js";

// Lazy imports to avoid hard dependency on server/ from core/
let _providerQuota = null;
async function getProviderQuota() {
  if (!_providerQuota) {
    try { _providerQuota = await import("../../server/services/provider-quota.js"); } catch { _providerQuota = null; }
  }
  return _providerQuota;
}

let _providerAdapters = null;
async function getProviderAdapters() {
  if (!_providerAdapters) {
    try { _providerAdapters = await import("../../server/services/provider-adapters.js"); } catch { _providerAdapters = null; }
  }
  return _providerAdapters;
}

let _delegateClient = null;
async function getDelegateClient() {
  if (!_delegateClient) {
    try { _delegateClient = await import("../../server/services/quota-delegate-client.js"); } catch { _delegateClient = null; }
  }
  return _delegateClient;
}

const HANDOFF_MAX_PER_PHASE = Number(process.env.CPB_PROVIDER_HANDOFF_MAX_PER_PHASE || 1);
const PHASE_RETRY_MAX = Number(process.env.CPB_PHASE_RETRY_MAX || 2);
const PHASE_RETRY_BASE_DELAY_MS = 30_000;
const PHASE_RETRYABLE_KINDS = new Set([
  FailureKind.AGENT_SPAWN_ERROR,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.TIMEOUT,
  FailureKind.RUNTIME_INTERRUPTED,
]);
const PHASE_CORRECTION_MAX = Number(process.env.CPB_PHASE_CORRECTION_MAX || 1);
const PHASE_CORRECTABLE_KINDS = new Set([
  FailureKind.ARTIFACT_INVALID,
  FailureKind.AGENT_CONTRACT_INVALID,
]);

function ts() {
  return new Date().toISOString();
}

function extractArtifactId(artifact) {
  if (!artifact?.name) return null;
  const parts = artifact.name.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : artifact.id || null;
}

/**
 * @param {object} ctx
 * @param {string} ctx.cpbRoot
 * @param {string} [ctx.hubRoot]
 * @param {string} ctx.project
 * @param {string} ctx.task
 * @param {string} [ctx.workflow="standard"]
 * @param {string} [ctx.planMode="full"]
 * @param {string} [ctx.sourcePath]
 * @param {object} [ctx.sourceContext]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.timeoutMin]
 * @param {Function} ctx.createJob
 * @param {Function} [ctx.startPhase]
 * @param {Function} ctx.completePhase
 * @param {Function} ctx.completeJob
 * @param {Function} ctx.failJob
 * @param {Function} ctx.appendEvent
 * @param {Function} ctx.getPool
 * @returns {Promise<{status: string, jobId: string, exitCode: number, failure?: object}>}
 */
export async function runJob(ctx) {
  const {
    cpbRoot,
    hubRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourcePath,
    sourceContext,
    maxRetries,
    timeoutMin,
    // Injected services
    createJob,
    startPhase,
    completePhase,
    completeJob,
    failJob,
    appendEvent,
    getPool,
  } = ctx;

  process.env.CPB_ROOT = cpbRoot;
  if (hubRoot) process.env.CPB_HUB_ROOT = hubRoot;
  if (sourcePath) process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;

  // 1. Create job
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    planMode,
    jobId: ctx.jobId,
    sourceContext: sourceContext || {},
  });
  const jobId = job.jobId;

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_started",
    jobId,
    project,
    task,
    workflow,
    planMode,
    ts: ts(),
  });

  // 2. Resolve phases
  const phases = resolvePhases(workflow, planMode);

  // 3. Get ACP pool
  const pool = getPool();

  // 4. Execute phases sequentially
  const phaseResults = [];
  const state = { planId: null, deliverableId: null };

  const envTimeout = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS) || 0;
  // Explicit timeoutMin takes priority, then env var, then disabled
  const phaseTimeout = timeoutMin != null ? (timeoutMin > 0 ? timeoutMin * 60_000 : 0) : envTimeout;

  const phaseRoleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", repair: "repairer" };

  for (const phase of phases) {
    if (typeof startPhase === "function") {
      await startPhase(cpbRoot, project, jobId, { phase });
    } else {
      await appendEvent(cpbRoot, project, jobId, {
        type: "phase_started",
        jobId,
        project,
        phase,
        ts: ts(),
      });
    }

    // Provider selection + fallback for this phase
    const role = phaseRoleMap[phase] || phase;
    const phaseAgents = { ...ctx.agents };
    let handoffCount = 0;
    let handoffReason = null;
    const providerAttempts = [];

    // Pre-flight: check if preferred provider is available
    if (hubRoot && pool) {
      const preflight = await preflightProvider({
        hubRoot, pool, phase, role, agents: phaseAgents, agent: ctx.agent,
      }).catch(() => null);
      if (preflight?.switched) {
        phaseAgents[role] = preflight.selectedAgent;
        handoffReason = preflight.reason;
        await appendEvent(cpbRoot, project, jobId, {
          type: "provider_handoff",
          jobId,
          project,
          phase,
          role,
          from: preflight.from,
          to: preflight.selectedProviderKey,
          reason: preflight.reason,
          ts: ts(),
        });
      }
    }

    // Run phase (with mid-run quota fallback)
    let result = await runPhase({
      phase,
      project,
      task,
      jobId,
      job,
      cpbRoot,
      sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
      sourceContext,
      pool,
      state,
      previousResults: phaseResults,
      agent: ctx.agent,
      agents: phaseAgents,
      timeouts: {
        plan: phaseTimeout,
        execute: phaseTimeout,
        verify: phaseTimeout,
        review: phaseTimeout,
        repair: phaseTimeout,
      },
    });

    // Mid-run quota fallback: retry with different provider on AGENT_RATE_LIMITED
    while (
      hubRoot &&
      !isPhasePassed(result) &&
      result.failure?.kind === FailureKind.AGENT_RATE_LIMITED &&
      result.failure?.retryable &&
      handoffCount < HANDOFF_MAX_PER_PHASE
    ) {
      handoffCount += 1;
      const quotaCause = result.failure.cause || {};

      // Mark the failed provider as unavailable (via delegate client, fail closed)
      const failedProviderKey = quotaCause.providerKey || resolveProviderKey(pool, phaseAgents[role], ctx.agent);
      const failedAgent = typeof phaseAgents[role] === "object" ? phaseAgents[role]?.agent : phaseAgents[role];
      const failedVariant = typeof phaseAgents[role] === "object" ? phaseAgents[role]?.variant : null;
      // Mark failed provider unavailable via delegate (fail closed)
      let delegateFailure = null;
      try {
        const dc = await getDelegateClient();
        if (!dc) {
          const err = new Error("quota delegate client unavailable; provider state not recorded");
          err.code = "QUOTA_DELEGATE_CLIENT_UNAVAILABLE";
          throw err;
        }
        await dc.delegateMarkProviderUnavailable(hubRoot, {
          providerKey: failedProviderKey,
          agent: failedAgent,
          variant: failedVariant,
          status: quotaCause.status || "rate_limited",
          nextEligibleAt: quotaCause.nextEligibleAt || Date.now() + 60_000,
          source: quotaCause.source || "run-job-handoff",
          confidence: quotaCause.confidence ?? 0.8,
          reason: result.failure.reason,
        });
      } catch (err) {
        delegateFailure = err;
      }

      // Delegate failure → structured phase failure (don't let runJob() bare-throw)
      if (delegateFailure) {
        result = phaseFailed({
          phase,
          failure: failure({
            kind: FailureKind.RUNTIME_INTERRUPTED,
            phase,
            reason: `quota delegate failure: ${delegateFailure.message}`,
            retryable: true,
            cause: {
              code: delegateFailure.code || "QUOTA_DELEGATE_WRITE_FAILED",
              providerKey: failedProviderKey,
              fallbackCount: handoffCount,
              providerAttempts: providerAttempts.length > 0 ? providerAttempts : null,
            },
          }),
        });
        break;
      }

      // Track provider attempt for history chain
      providerAttempts.push({
        providerKey: failedProviderKey,
        agent: failedAgent,
        variant: failedVariant,
        status: quotaCause.status || "rate_limited",
        at: new Date().toISOString(),
      });

      // Select fallback provider
      const fallback = await preflightProvider({
        hubRoot, pool, phase, role, agents: phaseAgents, agent: ctx.agent,
        excludeProvider: quotaCause.providerKey,
      }).catch(() => null);

      if (!fallback || !fallback.available) {
        // Ensure fallbackCount is in failure cause before breaking
        if (result.failure?.cause) {
          result.failure.cause.fallbackCount = handoffCount;
          if (providerAttempts.length > 0) {
            result.failure.cause.providerAttempts = providerAttempts;
          }
        }
        await appendEvent(cpbRoot, project, jobId, {
          type: "provider_quota_blocked",
          jobId,
          project,
          phase,
          role,
          reason: "all fallback providers unavailable",
          ts: ts(),
        });
        break;
      }

      // Apply fallback agent
      phaseAgents[role] = fallback.selectedAgent;

      // Write fallbackCount into failure cause for orchestrator consumption
      result.failure.cause = { ...result.failure.cause, fallbackCount: handoffCount };

      await appendEvent(cpbRoot, project, jobId, {
        type: "provider_handoff",
        jobId,
        project,
        phase,
        role,
        from: quotaCause.providerKey,
        to: fallback.selectedProviderKey,
        reason: result.failure.reason,
        midRun: true,
        attempt: handoffCount,
        ts: ts(),
      });

      // Generate handoff context for continuation prompt (execute phase only)
      let continuationContext = null;
      if (phase === "execute") {
        try {
          continuationContext = await generateHandoffBundle({
            project, jobId, phase, task,
            originProvider: quotaCause.providerKey,
            failureReason: result.failure.reason,
            partialStdout: quotaCause.stdout || "",
            partialStderr: quotaCause.stderr || "",
            previousResults: phaseResults,
            cpbRoot,
            sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
          });
        } catch { /* handoff bundle generation is best-effort */ }
      }

      // Retry the phase with fallback provider
      result = await runPhase({
        phase,
        project,
        task,
        jobId,
        job,
        cpbRoot,
        sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
        sourceContext: continuationContext
          ? { ...sourceContext, handoff: continuationContext }
          : sourceContext,
        pool,
        state,
        previousResults: phaseResults,
        agent: ctx.agent,
        agents: phaseAgents,
        timeouts: {
          plan: phaseTimeout,
          execute: phaseTimeout,
          verify: phaseTimeout,
          review: phaseTimeout,
          repair: phaseTimeout,
        },
      });
    }

    // Ensure fallbackCount and providerAttempts are in the failure cause
    if (handoffCount > 0 && result.failure?.cause) {
      result.failure.cause.fallbackCount = handoffCount;
      if (providerAttempts.length > 0) {
        result.failure.cause.providerAttempts = providerAttempts;
      }
    }

    // Phase retry: transient/validation failures get a second chance
    if (!isPhasePassed(result) && PHASE_RETRY_MAX > 0) {
      const isRetryable = result.failure?.retryable || PHASE_RETRYABLE_KINDS.has(result.failure?.kind);
      if (isRetryable) {
        for (let phaseRetry = 1; phaseRetry <= PHASE_RETRY_MAX; phaseRetry++) {
          await appendEvent(cpbRoot, project, jobId, {
            type: "phase_retry",
            jobId,
            project,
            phase,
            attempt: phaseRetry,
            maxAttempts: PHASE_RETRY_MAX,
            failureKind: result.failure?.kind,
            reason: result.failure?.reason,
            ts: ts(),
          });
          await new Promise((r) => setTimeout(r, PHASE_RETRY_BASE_DELAY_MS * phaseRetry));
          result = await runPhase({
            phase,
            project,
            task,
            jobId,
            job,
            cpbRoot,
            sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
            sourceContext,
            pool,
            state,
            previousResults: phaseResults,
            agent: ctx.agent,
            agents: phaseAgents,
            timeouts: {
              plan: phaseTimeout,
              execute: phaseTimeout,
              verify: phaseTimeout,
              review: phaseTimeout,
              repair: phaseTimeout,
            },
          });
          if (isPhasePassed(result)) break;
        }
      }
    }

    // Phase correction: validation failures retry with error feedback appended
    if (!isPhasePassed(result) && PHASE_CORRECTION_MAX > 0 && PHASE_CORRECTABLE_KINDS.has(result.failure?.kind)) {
      for (let correctionAttempt = 1; correctionAttempt <= PHASE_CORRECTION_MAX; correctionAttempt++) {
        const correction = {
          failureKind: result.failure.kind,
          failureReason: result.failure.reason,
          previousOutput: result.failure.stderrSnippet || result.failure.cause?.rawOutput || "",
          attempt: correctionAttempt,
        };
        await appendEvent(cpbRoot, project, jobId, {
          type: "phase_correction",
          jobId,
          project,
          phase,
          attempt: correctionAttempt,
          maxAttempts: PHASE_CORRECTION_MAX,
          failureKind: correction.failureKind,
          reason: correction.failureReason,
          ts: ts(),
        });
        result = await runPhase({
          phase,
          project,
          task,
          jobId,
          job,
          cpbRoot,
          sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
          sourceContext: { ...sourceContext, correction },
          pool,
          state,
          previousResults: phaseResults,
          agent: ctx.agent,
          agents: phaseAgents,
          timeouts: {
            plan: phaseTimeout,
            execute: phaseTimeout,
            verify: phaseTimeout,
            review: phaseTimeout,
            repair: phaseTimeout,
          },
        });
        if (isPhasePassed(result)) break;
      }
    }

    phaseResults.push(result);

    // Resolve agent name for this phase (use potentially handoff-modified phaseAgents)
    const rawAgent = phaseAgents[role] || ctx.agent || legacyAgentForPhase(phase);
    const agentName = typeof rawAgent === "object" && rawAgent !== null
      ? (rawAgent.agent || rawAgent.name || legacyAgentForPhase(phase))
      : (rawAgent || legacyAgentForPhase(phase));

    // Track artifacts for subsequent phases
    if (isPhasePassed(result) && result.artifact) {
      const artifactId = extractArtifactId(result.artifact);
      if (phase === "plan") state.planId = artifactId;
      if (phase === "execute") state.deliverableId = artifactId;

      await completePhase(cpbRoot, project, jobId, {
        phase,
        artifact: result.artifact.name,
      });
    }

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_result",
      jobId,
      project,
      phase,
      agent: agentName,
      status: result.status,
      artifact: result.artifact?.name || null,
      promptArtifact: result.diagnostics?.promptArtifact?.name || null,
      failure: result.failure
        ? { kind: result.failure.kind, reason: result.failure.reason }
        : null,
      ts: ts(),
    });

    // Enqueue phase-level provider usage (via delegate client, best-effort)
    if (hubRoot) {
      try {
        const dc = await getDelegateClient();
        if (dc) {
          const { agent: resolvedAgent, variant } = resolveRawAgent(phaseAgents, ctx.agent, role, phase);
          const providerKey = resolveProviderKey(pool, phaseAgents[role], ctx.agent);
          const pa = await getProviderAdapters();
          const adapter = pa?.getProviderAdapter(providerKey);
          const failCause = result.failure?.cause || {};
          const diag = result.diagnostics || {};

          const hardGateFailed = result.failure?.cause?.hardGate === true;
          let usageStatus = "ok";
          if (!isPhasePassed(result)) {
            if (hardGateFailed) {
              usageStatus = "hard_gate_failed";
            } else if (result.failure?.kind === FailureKind.AGENT_RATE_LIMITED) {
              usageStatus = handoffCount > 0 ? "fallback" : "rate_limited";
            } else if (result.failure?.kind === FailureKind.TIMEOUT) {
              usageStatus = "timeout";
            } else {
              usageStatus = "error";
            }
          }

          await dc.delegateEnqueueProviderUsage(hubRoot, {
            project,
            issueNumber: sourceContext?.issueNumber ?? sourceContext?.github?.issueNumber ?? job?.issueNumber ?? null,
            source: sourceContext?.source || null,
            attempt: sourceContext?.attempt ?? null,
            phase,
            role,
            providerKey: diag.providerKey || providerKey,
            agent: diag.agent || resolvedAgent,
            variant: diag.variant || variant,
            providerRegion: adapter?.region || null,
            providerAdapter: adapter?.providerKeyPattern || null,
            status: usageStatus,
            phaseStatus: isPhasePassed(result) ? "passed" : "failed",
            durationMs: diag.elapsedMs ?? null,
            quota: {
              status: failCause.status || null,
              source: failCause.source || null,
              confidence: failCause.confidence ?? null,
              nextEligibleAt: failCause.nextEligibleAt ?? null,
              retryAfterMs: failCause.retryAfterMs ?? null,
              windowResetAt: failCause.windowResetAt ?? null,
              weeklyResetAt: failCause.weeklyResetAt ?? null,
              reason: failCause.reason || null,
            },
            fallback: handoffCount > 0 || Boolean(handoffReason) ? {
              used: true,
              fromProviderKey: failCause.providerKey || null,
              toProviderKey: diag.providerKey || providerKey,
              count: handoffCount,
              reason: handoffReason || result.failure?.reason || null,
            } : { used: false, fromProviderKey: null, toProviderKey: null, count: 0, reason: null },
            providerAttempts: providerAttempts.length > 0 ? providerAttempts : null,
            usage: { calls: hardGateFailed ? 0 : 1, inputTokens: null, outputTokens: null, totalTokens: null, tokenSource: null, toolCalls: null, functionCalls: null },
          }).catch(() => null);
        }
      } catch { /* usage tracking is best-effort */ }
    }

    if (!isPhasePassed(result)) {
      const fail = result.failure || {};
      await failJob(cpbRoot, project, jobId, {
        reason: fail.reason || `${phase} phase failed`,
        code: fail.kind || "fatal",
        phase,
        cause: fail,
      });

      return {
        status: "failed",
        jobId,
        exitCode: 1,
        failure: {
          kind: fail.kind,
          phase,
          reason: fail.reason,
          retryable: fail.retryable,
        },
        phaseResults,
      };
    }
  }

  // 5. Complete job
  await completeJob(cpbRoot, project, jobId);

  return {
    status: "completed",
    jobId,
    exitCode: 0,
    failure: null,
    phaseResults,
  };
}

// ─── Provider Selection Helpers ─────────────────────────────────────

function resolveRawAgent(agents, agent, role, phase) {
  const raw = agents?.[role] || agent || legacyAgentForPhase(phase);
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || raw.name || legacyAgentForPhase(phase), variant: raw.variant || null };
  return { agent: raw, variant: null };
}

function resolveProviderKey(pool, rawAgent, defaultAgent) {
  const { agent, variant } = typeof rawAgent === "object" && rawAgent !== null
    ? { agent: rawAgent.agent || defaultAgent, variant: rawAgent.variant || null }
    : { agent: rawAgent || defaultAgent, variant: null };
  if (pool?.providerKey) return pool.providerKey(agent, variant);
  if (variant && agent === "claude") return `claude:${variant}`;
  return agent;
}

/**
 * Pre-flight provider availability check.
 * Returns { available, switched, selectedAgent, selectedProviderKey, reason, from } or null.
 */
async function preflightProvider({ hubRoot, pool, phase, role, agents, agent, excludeProvider = null }) {
  const pq = await getProviderQuota();
  if (!pq || !hubRoot) return null;

  const { agent: resolvedAgent, variant } = resolveRawAgent(agents, agent, role, phase);
  const providerKey = resolveProviderKey(pool, agents?.[role], agent);

  // Check preferred provider
  if (providerKey !== excludeProvider) {
    try {
      await pq.assertProviderAvailable(hubRoot, {
        providerKey,
        agent: resolvedAgent,
        variant,
        phase,
        role,
      });
      return {
        available: true,
        switched: false,
        selectedAgent: agents?.[role] || agent,
        selectedProviderKey: providerKey,
        reason: null,
        from: providerKey,
      };
    } catch {
      // Preferred is unavailable — try fallbacks
    }
  }

  // Try fallback candidates: other known variants (pool-configurable)
  const fallbackCandidates = getFallbackCandidates(pool, resolvedAgent, variant, excludeProvider || providerKey);
  for (const candidate of fallbackCandidates) {
    try {
      await pq.assertProviderAvailable(hubRoot, {
        providerKey: candidate.providerKey,
        agent: candidate.agent,
        variant: candidate.variant,
        phase,
        role,
      });
      const selectedAgent = candidate.variant
        ? { agent: candidate.agent, variant: candidate.variant }
        : candidate.agent;
      return {
        available: true,
        switched: candidate.providerKey !== providerKey,
        selectedAgent,
        selectedProviderKey: candidate.providerKey,
        reason: `fallback from ${providerKey}`,
        from: providerKey,
      };
    } catch {
      continue;
    }
  }

  return {
    available: false,
    switched: false,
    selectedAgent: null,
    selectedProviderKey: null,
    reason: `all providers unavailable for ${role}`,
    from: providerKey,
  };
}

function getFallbackCandidates(pool, agent, currentVariant, excludeKey) {
  // Pool-provided candidates take precedence (runtime-configurable)
  if (pool?.fallbackCandidates) {
    try {
      const poolCandidates = pool.fallbackCandidates(agent, currentVariant, excludeKey);
      if (Array.isArray(poolCandidates) && poolCandidates.length > 0) return poolCandidates;
    } catch { /* fall through to defaults */ }
  }

  // Hardcoded defaults
  const candidates = [];
  if (agent === "claude") {
    const variants = ["kimi-k2.6", "mimo-v2.5pro"];
    for (const v of variants) {
      const key = `claude:${v}`;
      if (key !== excludeKey && v !== currentVariant) {
        candidates.push({ agent: "claude", variant: v, providerKey: key });
      }
    }
    // Also try plain claude if currently on a variant
    if (currentVariant && "claude" !== excludeKey) {
      candidates.push({ agent: "claude", variant: null, providerKey: "claude" });
    }
  }
  if (agent === "codex" && "codex" !== excludeKey) {
    candidates.push({ agent: "codex", variant: null, providerKey: "codex" });
  }
  return candidates;
}
