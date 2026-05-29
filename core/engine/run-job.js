import { phasePassed } from "../contracts/phase-result.js";
import { jobCompleted, jobFailed } from "../contracts/job-result.js";
import { failure, FailureKind } from "../contracts/failure.js";
import { resolvePhases } from "./workflow-runner.js";
import { runPhase } from "./run-phase.js";
import {
  appendJobEvent,
  jobStartedEvent,
  phaseStartedEvent,
  phaseResultEvent,
  jobCompletedEvent,
  jobFailedEvent,
} from "./job-events.js";

/**
 * Engine.runJob — the single job state machine.
 * Executes phases sequentially, writes job events, returns JobResult.
 *
 * @param {object} ctx
 * @param {string} ctx.cpbRoot
 * @param {string} ctx.project
 * @param {string} ctx.task
 * @param {string} ctx.workflow
 * @param {string} ctx.planMode
 * @param {string} ctx.jobId
 * @param {object} ctx.pool       - AcpPool instance
 * @param {object} [ctx.sourceContext]
 * @param {object} [ctx.env]
 * @param {string} [ctx.sourcePath]
 * @param {object} [ctx.executor]
 * @returns {Promise<JobResult>}
 */
export async function runJob(ctx) {
  const { cpbRoot, project, jobId } = ctx;
  const phases = resolvePhases(ctx.workflow, ctx.planMode);

  await appendJobEvent(cpbRoot, project, jobId, jobStartedEvent({
    task: ctx.task,
    workflow: ctx.workflow,
    planMode: ctx.planMode,
  }));

  const phaseResults = [];

  for (const phase of phases) {
    await appendJobEvent(cpbRoot, project, jobId, phaseStartedEvent(phase));

    const result = await runPhase({
      ...ctx,
      phase,
      previousResults: phaseResults,
    });

    phaseResults.push(result);

    await appendJobEvent(cpbRoot, project, jobId, phaseResultEvent(phase, result));

    if (result.status !== "passed") {
      const f = result.failure;
      await appendJobEvent(cpbRoot, project, jobId, jobFailedEvent({
        reason: f.reason,
        code: f.kind,
        phase,
        cause: f,
      }));

      return jobFailed({ jobId, phaseResults, failure: f });
    }
  }

  const lastArtifact = phaseResults.length > 0
    ? phaseResults[phaseResults.length - 1].artifact
    : null;

  await appendJobEvent(cpbRoot, project, jobId, jobCompletedEvent(lastArtifact));

  return jobCompleted({ jobId, phaseResults });
}
