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
import { isPhasePassed } from "../contracts/phase-result.js";
import { legacyAgentForPhase } from "../agents/registry.js";

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
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      project,
      phase,
      ts: ts(),
    });

    const result = await runPhase({
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
      agents: ctx.agents,
      timeouts: {
        plan: phaseTimeout,
        execute: phaseTimeout,
        verify: phaseTimeout,
        review: phaseTimeout,
        repair: phaseTimeout,
      },
    });

    phaseResults.push(result);

    // Resolve agent name for this phase (same logic as phase adapters)
    const role = phaseRoleMap[phase] || phase;
    const rawAgent = ctx.agents?.[role] || ctx.agent || legacyAgentForPhase(phase);
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
      failure: result.failure
        ? { kind: result.failure.kind, reason: result.failure.reason }
        : null,
      ts: ts(),
    });

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
