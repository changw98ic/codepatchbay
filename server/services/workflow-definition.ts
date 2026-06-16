import path from "node:path";
import { AnyRecord } from "../../shared/types.js";
import {
  dispatchForPhase as coreDispatchForPhase,
  getWorkflow as getCoreWorkflow,
  isWorkflowName,
  listWorkflows,
  nextPhase as coreNextPhase,
  roleForPhase as coreRoleForPhase,
} from "../../core/workflow/definition.js";

type CoreWorkflow = ReturnType<typeof getCoreWorkflow>;
type ServerWorkflow = CoreWorkflow & AnyRecord;

// --- Helpers migrated from deleted supervisor.ts ---

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function hasArtifact(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCompletedPhase(state: AnyRecord, phase: string) {
  return state.completedPhases?.includes(phase) || hasArtifact(state.artifacts?.[phase]);
}

function artifactId(value: unknown, prefix: string) {
  if (!hasArtifact(value)) return "";
  const str = value as string;
  const base = path.basename(str, ".md");
  return base.startsWith(`${prefix}-`) ? base.slice(prefix.length + 1) : str;
}

// --- Job-level convenience functions ---

export function nextPhaseFor(state: AnyRecord) {
  if (!state || TERMINAL_STATUSES.has(state.status)) return "";
  if (state.cancelRequested) return "";

  const workflow = getWorkflow(state.workflow);
  if (workflow.phases.length === 0) return "";

  const artifacts = state.artifacts ?? {};
  for (const phase of workflow.phases) {
    if (!hasCompletedPhase(state, phase)) return phase;
  }
  return "complete";
}

export function bridgeForPhaseJob(phase: string, project: string, job: AnyRecord) {
  const bridgesDir = "bridges";
  switch (phase) {
    case "plan":
      return { script: path.join(bridgesDir, "planner.sh"), args: [project, job.task ?? ""] };
    case "execute": {
      const planId = artifactId(job.artifacts?.plan, "plan");
      return { script: path.join(bridgesDir, "executor.sh"), args: [project, planId] };
    }
    case "verify": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return { script: path.join(bridgesDir, "verifier.sh"), args: deliverableId ? [project, deliverableId] : [project, "--job-id", job.jobId] };
    }
    case "review": {
      const deliverableId = artifactId(job.artifacts?.execute, "deliverable");
      return { script: path.join(bridgesDir, "reviewer.sh"), args: [project, deliverableId] };
    }
    case "complete":
      return null;
    default: {
      const workflow = getWorkflow(job.workflow);
      const bridge = workflow.bridgeForPhase?.[phase] ?? null;
      if (bridge) return { script: path.join(bridgesDir, bridge), args: [project] };
      return null;
    }
  }
}

function bridgeMapForPhases(phases: string[] = []) {
  return Object.fromEntries(phases.map((phase) => [phase, "run-phase.js"]));
}

function withServerCompatibility(workflow: CoreWorkflow): ServerWorkflow {
  return {
    ...workflow,
    phases: [...(workflow.phases ?? [])],
    roleForPhase: { ...(workflow.roleForPhase ?? {}) },
    dispatchForPhase: { ...(workflow.dispatchForPhase ?? {}) },
    bridgeForPhase: bridgeMapForPhases(workflow.phases),
  };
}

export function getWorkflow(name: string) {
  return withServerCompatibility(getCoreWorkflow(name));
}

export function nextPhase(workflow: ServerWorkflow, currentPhase?: string | null) {
  return coreNextPhase(workflow, currentPhase);
}

export function bridgeForPhase(workflow: ServerWorkflow, phase: string) {
  return workflow.bridgeForPhase?.[phase] ?? null;
}

export function dispatchForPhase(workflow: ServerWorkflow, phase: string) {
  return coreDispatchForPhase(workflow, phase);
}

export function roleForPhase(workflow: ServerWorkflow, phase: string) {
  return coreRoleForPhase(workflow, phase);
}

export { isWorkflowName, listWorkflows };
