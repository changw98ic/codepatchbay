import { phasesToDag, validateDag } from "./dag-executor.js";
import { resolveSquadAgent } from "../agents/registry.js";

const WORKCPBS = {
  standard: {
    name: "standard",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    bridgeForPhase: {
      plan: "run-phase.mjs",
      execute: "run-phase.mjs",
      verify: "run-phase.mjs",
    },
  },
  complex: {
    name: "complex",
    phases: ["plan", "execute", "review", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    bridgeForPhase: {
      plan: "run-phase.mjs",
      execute: "run-phase.mjs",
      review: "run-phase.mjs",
      verify: "run-phase.mjs",
    },
  },
  blocked: {
    name: "blocked",
    phases: [],
    roleForPhase: {},
    dispatchForPhase: {},
    bridgeForPhase: {},
  },
  accelerated: {
    name: "accelerated",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    bridgeForPhase: {
      plan: "run-phase.mjs",
      execute: "run-phase.mjs",
      verify: "run-phase.mjs",
    },
    requireSubagents: { plan: true, execute: true, verify: true, repair: true },
    subagentConfig: { maxConcurrency: 3 },
    verificationLayers: ["fast", "changed", "regression", "acceptance"],
  },
};

// Cache for normalized DAGs
const _dagCache = new Map();

export function getWorkflow(name) {
  return WORKCPBS[name] ?? WORKCPBS.standard;
}

export function nextPhase(workflow, currentPhase) {
  const phases = workflow.phases;
  if (phases.length === 0) return null;
  if (currentPhase === null || currentPhase === undefined) return phases[0];
  const idx = phases.indexOf(currentPhase);
  if (idx === -1 || idx >= phases.length - 1) return null;
  return phases[idx + 1];
}

export function bridgeForPhase(workflow, phase) {
  return workflow.bridgeForPhase[phase] ?? null;
}

export function dispatchForPhase(workflow, phase) {
  return workflow.dispatchForPhase[phase] ?? null;
}

export function roleForPhase(workflow, phase) {
  return workflow.roleForPhase[phase] ?? null;
}

export function phaseRequiresSubagents(workflow, phase) {
  return workflow.requireSubagents?.[phase] === true;
}

export function getVerificationLayers(workflow) {
  return workflow.verificationLayers ?? null;
}

export function getSubagentConfig(workflow) {
  return workflow.subagentConfig ?? null;
}

export function listWorkflows() {
  return Object.keys(WORKCPBS);
}

export function isWorkflowName(name) {
  return Object.hasOwn(WORKCPBS, name);
}

// --- DAG support ---

/**
 * Normalize a workflow into a DAG representation.
 * If workflow has explicit `nodes`, validate and use them.
 * Otherwise, convert legacy `phases` to a single-chain DAG.
 */
export function normalizeWorkflow(name) {
  const wf = getWorkflow(name);

  // Explicit DAG nodes defined on workflow
  if (wf.nodes && wf.nodes.length > 0) {
    const validation = validateDag(wf.nodes);
    if (!validation.valid) {
      throw new Error(`workflow ${name} has invalid DAG: ${validation.errors.join(", ")}`);
    }
    return {
      name: wf.name,
      nodes: resolveSquadsInNodes(wf.nodes),
      edges: wf.edges || buildEdges(wf.nodes),
      maxConcurrentNodes: wf.maxConcurrentNodes || 2,
      isDag: true,
    };
  }

  // Legacy: convert phases to single-chain DAG
  const cacheKey = wf.name;
  if (_dagCache.has(cacheKey)) return _dagCache.get(cacheKey);

  const nodes = phasesToDag(wf.phases, wf.roleForPhase);
  const result = {
    name: wf.name,
    nodes: resolveSquadsInNodes(nodes),
    edges: buildEdges(nodes),
    maxConcurrentNodes: 1, // Legacy workflows are sequential
    isDag: wf.phases.length > 0,
  };
  _dagCache.set(cacheKey, result);
  return result;
}

/**
 * Resolve `squad` fields in DAG nodes to concrete `agent` names.
 * If a node has both `squad` and `agent`, `squad` takes precedence.
 */
function resolveSquadsInNodes(nodes) {
  return nodes.map((node) => {
    if (!node.squad) return node;
    const agent = resolveSquadAgent(node.squad);
    if (!agent) return node;
    return { ...node, agent, _squad: node.squad };
  });
}

function buildEdges(nodes) {
  const edges = [];
  for (const n of nodes) {
    for (const dep of n.dependsOn || []) {
      edges.push({ from: dep, to: n.id });
    }
  }
  return edges;
}

/**
 * Get DAG nodes for a workflow. Returns empty array for blocked/empty workflows.
 */
export function getDagNodes(name) {
  return normalizeWorkflow(name).nodes;
}

/**
 * Register a custom DAG workflow at runtime.
 */
export function registerDagWorkflow(name, { nodes, maxConcurrentNodes = 2 }) {
  const validation = validateDag(nodes);
  if (!validation.valid) {
    throw new Error(`invalid DAG: ${validation.errors.join(", ")}`);
  }
  WORKCPBS[name] = {
    name,
    phases: nodes.map((n) => n.phase),
    roleForPhase: Object.fromEntries(nodes.map((n) => [n.phase, n.role || "executor"])),
    bridgeForPhase: Object.fromEntries(nodes.map((n) => [n.phase, "run-phase.mjs"])),
    nodes,
    maxConcurrentNodes,
  };
  _dagCache.delete(name);
}
