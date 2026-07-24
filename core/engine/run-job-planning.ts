import path from "node:path";

import { resolveArtifactPath, resolveArtifactPathForRoot } from "../artifacts/artifact-paths.js";
import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";

export type WorkflowDagNode = LooseRecord & {
  id: string;
  phase: string;
  dependsOn?: string[];
  custom?: boolean;
  sideEffecting?: boolean;
  parallelSafe?: boolean;
  conflictKey?: string;
  conflictKeys?: string[];
  checklistNeutral?: boolean;
  checklistIds?: string[];
  checklistBindingSource?: string;
};

export type WorkflowDag = LooseRecord & {
  nodes: WorkflowDagNode[];
  maxConcurrentNodes?: number;
};

type ResumeContext = {
  completedNodeIds: string[];
  resumeTarget: LooseRecord | null;
};

type ArtifactRoots = {
  cpbRoot?: string;
  project?: string;
  dataRoot?: string;
};

type RecoveredArtifact = LooseRecord & {
  kind: string;
  name: string;
  path: string | null;
};

type AcceptanceChecklistItem = {
  id?: unknown;
  required?: unknown;
};

type AcceptanceChecklist = {
  items?: AcceptanceChecklistItem[];
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function workflowDagNodes(workflowDag: { nodes?: unknown }): WorkflowDagNode[] {
  // retain: dynamic JSON — nodes element shape is not validated at this boundary
  return Array.isArray(workflowDag.nodes) ? workflowDag.nodes as WorkflowDagNode[] : [];
}

function readyNodeIds(nodes: WorkflowDagNode[], completed: Set<string>): string[] {
  const ready: string[] = [];
  for (const node of nodes) {
    if (completed.has(node.id)) continue;
    const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
    if (deps.length === 0 || deps.every((dep) => completed.has(dep))) {
      ready.push(node.id);
    }
  }
  return ready;
}

function getWorkflowNode(nodes: WorkflowDagNode[], nodeId: string): WorkflowDagNode | null {
  return nodes.find((node) => node.id === nodeId) || null;
}

export function dagSequentialExecutionPlan(workflowDag: { nodes?: unknown }): WorkflowDagNode[] {
  const nodes = workflowDagNodes(workflowDag);
  const completed = new Set<string>();
  const planned: WorkflowDagNode[] = [];

  while (planned.length < nodes.length) {
    const [nodeId] = readyNodeIds(nodes, completed);
    if (!nodeId) {
      throw new Error(`DAG has no ready node after ${planned.length}/${nodes.length} node(s)`);
    }
    const node = getWorkflowNode(nodes, nodeId);
    if (!node) {
      throw new Error(`DAG ready node is missing from workflow: ${nodeId}`);
    }
    planned.push(node);
    completed.add(nodeId);
  }

  return planned;
}

export function normalizeDagResumeContext(sourceContext: unknown = {}): ResumeContext {
  const source = recordValue(sourceContext);
  const retry = recordValue(source.retry);
  const dagResume = recordValue(source.dagResume);
  const previousFailure = recordValue(source.previousFailure);
  const completedNodeIds = [
    ...arrayOfStrings(dagResume.completedNodeIds),
    ...arrayOfStrings(retry.completedNodeIds),
    ...arrayOfStrings(previousFailure.completedNodeIds),
  ];
  const resumeTarget = retry.resumeTarget || dagResume.resumeTarget || previousFailure.resumeTarget || null;
  return {
    completedNodeIds: [...new Set(completedNodeIds)],
    resumeTarget: isRecord(resumeTarget)
      ? { ...resumeTarget }
      : null,
  };
}

function artifactKindForPhase(phase: string): string {
  if (phase === "plan") return "plan";
  if (phase === "execute" || phase === "remediate") return "deliverable";
  if (phase === "verify" || phase === "adversarial_verify") return "verdict";
  if (phase === "review") return "review";
  return phase || "artifact";
}

function artifactPathFromName({
  cpbRoot,
  project,
  kind,
  value,
  dataRoot,
}: ArtifactRoots & { kind: string; value: unknown }): string | null {
  if (!value || typeof value !== "string") return null;
  if (path.isAbsolute(value)) return value;
  if (value.includes("/") || value.includes("\\")) return path.resolve(String(cpbRoot || ""), value);
  const base = value.endsWith(".md") ? value.slice(0, -3) : value;
  const prefix = `${kind}-`;
  if (!base.startsWith(prefix)) return null;
  return dataRoot
    ? resolveArtifactPathForRoot(dataRoot, kind, base.slice(prefix.length))
    : resolveArtifactPath(String(cpbRoot || ""), String(project || ""), kind, base.slice(prefix.length));
}

export function recoveredArtifactForPhase(
  sourceContext: unknown = {},
  phase: string,
  roots: ArtifactRoots = {},
): RecoveredArtifact | null {
  const source = recordValue(sourceContext);
  const retry = recordValue(source.retry);
  const previousFailure = recordValue(source.previousFailure);
  const retryArtifacts = recordValue(retry.artifacts);
  const previousArtifacts = recordValue(previousFailure.artifacts);
  const raw = retryArtifacts[phase] || previousArtifacts[phase] || null;
  if (!raw) return null;
  const kind = artifactKindForPhase(phase);
  if (typeof raw === "string") {
    return { kind, name: raw, path: artifactPathFromName({ ...roots, kind, value: raw }) };
  }
  if (isRecord(raw)) {
    const artifact = raw;
    const name = stringValue(artifact.name) || stringValue(artifact.path) || `${phase}-recovered`;
    return {
      ...artifact,
      kind,
      name,
      path: stringValue(artifact.path) || artifactPathFromName({ ...roots, kind, value: name }),
    };
  }
  return null;
}

export function recoveredVerdictForPhase(sourceContext: unknown = {}, phase: string): unknown {
  const source = recordValue(sourceContext);
  const retry = recordValue(source.retry);
  const previousFailure = recordValue(source.previousFailure);
  if (phase === "verify") return retry.verdict || previousFailure.verdict || null;
  if (phase === "adversarial_verify") return retry.adversarialVerdict || previousFailure.adversarialVerdict || null;
  return null;
}

export function attachChecklistIdsToWorkflowDag<T extends { nodes?: unknown }>(
  workflowDag: T,
  acceptanceChecklist: AcceptanceChecklist | null,
): T & { nodes: WorkflowDagNode[] } {
  if (!acceptanceChecklist?.items?.length) {
    return { ...workflowDag, nodes: workflowDagNodes(workflowDag) };
  }
  const requiredIds = acceptanceChecklist.items
    .filter((item) => item.required)
    .map((item) => String(item.id || ""))
    .filter(Boolean);
  return {
    ...workflowDag,
    nodes: workflowDagNodes(workflowDag).map((node) => {
      if ((node.phase === "execute" || node.phase === "verify" || node.phase === "adversarial_verify") && !node.custom && !node.sideEffecting) {
        return { ...node, checklistIds: requiredIds, checklistBindingSource: "canonical-default" };
      }
      if (node.sideEffecting || node.custom || node.phase === "remediate" || node.phase === "review") {
        return node.checklistNeutral ? { ...node, checklistIds: [] } : node;
      }
      return node;
    }),
  };
}
