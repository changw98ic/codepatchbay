/**
 * WorkflowDagBuilder — constructs and validates a DAG from workflow + phase list.
 *
 * Extracted from run-job.js so other modules (health-check, dry-run previews)
 * can materialise a DAG without pulling in the full engine.
 *
 * @module core/engine/dag-builder
 */

import { normalizeWorkflow } from "../workflow/definition.js";

type DagNode = {
  id: string;
  phase: string;
  role?: string;
  dependsOn?: string[];
  [key: string]: unknown;
};
type DagEdge = { from: string; to: string };
type WorkflowDag = {
  name: string;
  nodes: DagNode[];
  edges: DagEdge[];
  maxConcurrentNodes: number;
  isDag: boolean;
  source: "runtime_phase_projection";
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Build a DAG descriptor for a concrete run.
 *
 * Merges the persisted workflow definition (if any) with the resolved phase
 * list, falling back to a linear chain when no definition exists.
 *
 * @param {{ workflow: string, phases: string[], phaseRoleMap: Record<string,string> }} opts
 * @returns {{ name: string, nodes: object[], edges: object[], maxConcurrentNodes: number, isDag: boolean, source: string }}
 */
export function buildWorkflowDag({ workflow, phases, phaseRoleMap }: { workflow: string; phases: string[]; phaseRoleMap: Record<string, string> }): WorkflowDag {
  const base = normalizeWorkflow(workflow);
  const baseNodes = Array.isArray(base?.nodes) ? base.nodes : [];
  const baseNodeById = new Map<string, DagNode>();
  const seenIds = new Set<string>();

  for (const rawNode of baseNodes) {
    const phase = nonEmptyString(rawNode.phase) || nonEmptyString(rawNode.id);
    const id = nonEmptyString(rawNode.id) || phase;
    if (!phase || !id) continue;
    if (baseNodeById.has(id)) {
      throw new Error(`workflow ${workflow} has duplicate node id: ${id}`);
    }
    baseNodeById.set(id, {
      ...rawNode,
      id,
      phase,
      role: nonEmptyString(rawNode.role) || undefined,
      dependsOn: Array.isArray(rawNode.dependsOn)
        ? rawNode.dependsOn.map(String).filter(Boolean)
        : [],
    });
  }

  const phaseBudget = new Map<string, number>();
  for (const phase of phases) {
    phaseBudget.set(phase, (phaseBudget.get(phase) || 0) + 1);
  }

  const nodes: DagNode[] = [];
  const pushNode = (node: DagNode) => {
    const id = nonEmptyString(node.id) || "";
    if (!id) {
      throw new Error(`workflow ${workflow} has node missing id`);
    }
    if (seenIds.has(id)) {
      throw new Error(`workflow ${workflow} has duplicate node id: ${id}`);
    }
    seenIds.add(id);
    nodes.push(node);
  };

  for (const existing of baseNodes) {
    const phase = nonEmptyString(existing.phase) || nonEmptyString(existing.id);
    if (!phase) continue;
    if (!phaseBudget.has(phase)) continue;
    const remaining = phaseBudget.get(phase) || 0;
    if (remaining <= 0) continue;
    phaseBudget.set(phase, remaining - 1);
    const id = nonEmptyString(existing.id) || phase;
    const role = nonEmptyString(existing.role) || phaseRoleMap[phase] || phase;
    pushNode({
      ...existing,
      id,
      phase,
      role,
      dependsOn: Array.isArray(existing.dependsOn)
        ? existing.dependsOn.map(String).filter(Boolean)
        : [],
    });
  }

  for (const [phase, remaining] of phaseBudget.entries()) {
    for (let idx = 0; idx < remaining; idx++) {
      const previous = nodes[nodes.length - 1];
      const fallbackNode = {
        id: idx === 0 ? phase : `${phase}_${idx + 1}`,
        phase,
        role: phaseRoleMap[phase] || phase,
        dependsOn: previous ? [previous.id] : [],
      };
      pushNode(fallbackNode);
    }
  }

  const includedIds = new Set(nodes.map((n) => n.id));
  const projectedDependencies = (
    ownerId: string,
    dependencies: string[],
    visiting: Set<string> = new Set(),
  ): string[] => {
    const projected: string[] = [];
    for (const dependencyId of dependencies) {
      if (includedIds.has(dependencyId)) {
        if (!projected.includes(dependencyId)) projected.push(dependencyId);
        continue;
      }
      const dependency = baseNodeById.get(dependencyId);
      if (!dependency) {
        throw new Error(`workflow ${workflow} has unknown dependency for node ${ownerId}: ${dependencyId}`);
      }
      if (visiting.has(dependencyId)) {
        throw new Error(`workflow ${workflow} has cyclic projected dependency at node ${dependencyId}`);
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(dependencyId);
      for (const ancestorId of projectedDependencies(ownerId, dependency.dependsOn || [], nextVisiting)) {
        if (!projected.includes(ancestorId)) projected.push(ancestorId);
      }
    }
    return projected;
  };
  const normalizedNodes = nodes.map((n) => {
    const dependsOn = (n.dependsOn || []).filter((depId) => typeof depId === "string");
    return {
      ...n,
      dependsOn: projectedDependencies(n.id, dependsOn, new Set([n.id])),
    };
  });

  return {
    name: base?.name || workflow || "standard",
    nodes: normalizedNodes,
    edges: normalizedNodes.flatMap((n) =>
      (n.dependsOn || []).map((depId) => ({ from: depId, to: n.id })),
    ),
    maxConcurrentNodes: Number(base?.maxConcurrentNodes) || 1,
    isDag: normalizedNodes.length > 0,
    source: "runtime_phase_projection",
  };
}

/**
 * Append an `adversarial_verify` phase right after `verify` when the risk map
 * demands it.  Returns a new array — does not mutate the input.
 *
 * @param {string[]} phases
 * @param {{ adversarialRequired?: boolean }} riskMap
 * @returns {string[]}
 */
export function insertAdversarialVerify(phases: string[], riskMap: { adversarialRequired?: boolean } | null | undefined): string[] {
  if (
    !riskMap?.adversarialRequired ||
    !phases.includes("verify") ||
    phases.includes("adversarial_verify")
  ) {
    return phases;
  }

  const result: string[] = [];
  for (const phase of phases) {
    result.push(phase);
    if (phase === "verify") result.push("adversarial_verify");
  }
  return result;
}

/**
 * Validate that a DAG is suitable for a mutating job (one that writes to the
 * codebase).  Currently this checks that at least one verify-phase node is
 * present.
 *
 * @param {{ nodes: { phase: string }[] }} dag
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateDagForMutatingJob(dag: { nodes?: Array<{ phase?: string }> } | null | undefined): { valid: true } | { valid: false; reason: string } {
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const hasVerify = nodes.some((n) => n.phase === "verify");
  if (!hasVerify) {
    return {
      valid: false,
      reason: "Mutating job requires a verify phase in the DAG",
    };
  }
  return { valid: true };
}
