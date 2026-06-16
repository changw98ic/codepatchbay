/**
 * WorkflowDagBuilder — constructs and validates a DAG from workflow + phase list.
 *
 * Extracted from run-job.js so other modules (health-check, dry-run previews)
 * can materialise a DAG without pulling in the full engine.
 *
 * @module core/engine/dag-builder
 */
import { normalizeWorkflow } from "../workflow/definition.js";
/**
 * Build a DAG descriptor for a concrete run.
 *
 * Merges the persisted workflow definition (if any) with the resolved phase
 * list, falling back to a linear chain when no definition exists.
 *
 * @param {{ workflow: string, phases: string[], phaseRoleMap: Record<string,string> }} opts
 * @returns {{ name: string, nodes: object[], edges: object[], maxConcurrentNodes: number, isDag: boolean, source: string }}
 */
export function buildWorkflowDag({ workflow, phases, phaseRoleMap }) {
    const base = normalizeWorkflow(workflow);
    const baseNodes = Array.isArray(base?.nodes) ? base.nodes : [];
    const phaseBudget = new Map();
    for (const phase of phases) {
        phaseBudget.set(phase, (phaseBudget.get(phase) || 0) + 1);
    }
    const nodes = [];
    for (const existing of baseNodes) {
        const phase = existing.phase || existing.id;
        if (!phaseBudget.has(phase))
            continue;
        const remaining = phaseBudget.get(phase);
        if (remaining <= 0)
            continue;
        phaseBudget.set(phase, remaining - 1);
        nodes.push({
            ...existing,
            id: existing.id || phase,
            phase,
            role: existing.role || phaseRoleMap[phase] || phase,
            dependsOn: Array.isArray(existing.dependsOn)
                ? [...existing.dependsOn]
                : [],
        });
    }
    for (const [phase, remaining] of phaseBudget.entries()) {
        for (let idx = 0; idx < remaining; idx++) {
            const previous = nodes[nodes.length - 1];
            nodes.push({
                id: idx === 0 ? phase : `${phase}_${idx + 1}`,
                phase,
                role: phaseRoleMap[phase] || phase,
                dependsOn: previous ? [previous.id] : [],
            });
        }
    }
    const includedIds = new Set(nodes.map((n) => n.id));
    const normalizedNodes = nodes.map((n) => ({
        ...n,
        dependsOn: (n.dependsOn || []).filter((depId) => includedIds.has(depId)),
    }));
    return {
        name: base?.name || workflow || "standard",
        nodes: normalizedNodes,
        edges: normalizedNodes.flatMap((n) => (n.dependsOn || []).map((depId) => ({ from: depId, to: n.id }))),
        maxConcurrentNodes: base?.maxConcurrentNodes || 1,
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
export function insertAdversarialVerify(phases, riskMap) {
    if (!riskMap?.adversarialRequired ||
        !phases.includes("verify") ||
        phases.includes("adversarial_verify")) {
        return phases;
    }
    const result = [];
    for (const phase of phases) {
        result.push(phase);
        if (phase === "verify")
            result.push("adversarial_verify");
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
export function validateDagForMutatingJob(dag) {
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
