import { LooseRecord } from "../../shared/types.js";
import { validateDag } from "./dag-executor.js";
import { resolveSquadAgent } from "../agents/registry.js";
import {
  agentForRoutingPhase,
  assertValidRoutingRules,
  resolveEffectiveRouting,
} from "../agents/routing.js";

type WorkflowNode = LooseRecord & {
  id: string;
  phase: string;
  role?: string | null;
  agent?: string | null;
  squad?: string | LooseRecord;
  _squad?: string | LooseRecord;
  dependsOn?: string[];
  custom?: boolean;
  sideEffecting?: boolean;
  parallelSafe?: boolean;
  conflictKey?: string;
  conflictKeys?: string[];
};
type WorkflowDefinition = LooseRecord & {
  name: string;
  phases: string[];
  roleForPhase: Record<string, string>;
  dispatchForPhase: Record<string, string>;
  requireSubagents?: Record<string, boolean>;
  nodes?: WorkflowNode[];
  maxConcurrentNodes?: number;
};
type WorkflowOptions = { category?: string; routing?: LooseRecord | null };

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  standard: {
    name: "standard",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
    ],
    maxConcurrentNodes: 1,
  },
  direct: {
    name: "direct",
    phases: ["execute", "verify"],
    roleForPhase: { execute: "executor", verify: "verifier" },
    dispatchForPhase: { execute: "executor", verify: "verifier" },
    nodes: [
      { id: "execute", phase: "execute", role: "executor", dependsOn: [] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
    ],
    maxConcurrentNodes: 1,
  },
  complex: {
    name: "complex",
    phases: ["plan", "execute", "review", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review", phase: "review", role: "reviewer", dependsOn: ["execute"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review"] },
    ],
    maxConcurrentNodes: 1,
  },
  blocked: {
    name: "blocked",
    phases: [],
    roleForPhase: {},
    dispatchForPhase: {},
    nodes: [],
    maxConcurrentNodes: 1,
  },
  accelerated: {
    name: "accelerated",
    stub: true,
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
    ],
    maxConcurrentNodes: 1,
    requireSubagents: { plan: true, execute: true, verify: true, remediate: true },
    subagentConfig: { maxConcurrency: 3 },
    verificationLayers: ["fast", "changed", "regression", "acceptance"],
  },
};

// Cache for normalized DAGs
const _dagCache = new Map<string, LooseRecord>();

export function getWorkflow(name: string): WorkflowDefinition {
  return WORKFLOWS[name] ?? WORKFLOWS.standard;
}

export function nextPhase(workflow: WorkflowDefinition, currentPhase?: string | null) {
  const phases = workflow.phases;
  if (phases.length === 0) return null;
  if (currentPhase === null || currentPhase === undefined) return phases[0];
  const idx = phases.indexOf(currentPhase);
  if (idx === -1 || idx >= phases.length - 1) return null;
  return phases[idx + 1];
}

export function dispatchForPhase(workflow: WorkflowDefinition, phase: string) {
  return workflow.dispatchForPhase[phase] ?? null;
}

export function roleForPhase(workflow: WorkflowDefinition, phase: string) {
  return workflow.roleForPhase[phase] ?? null;
}

export function phaseRequiresSubagents(workflow: WorkflowDefinition, phase: string) {
  return workflow.requireSubagents?.[phase] === true;
}

export function getVerificationLayers(workflow: WorkflowDefinition) {
  return workflow.verificationLayers ?? null;
}

export function getSubagentConfig(workflow: WorkflowDefinition) {
  return workflow.subagentConfig ?? null;
}

export function listWorkflows() {
  return Object.keys(WORKFLOWS).filter((k) => !WORKFLOWS[k].stub);
}

export function isWorkflowName(name: string) {
  return Object.hasOwn(WORKFLOWS, name) && !WORKFLOWS[name].stub;
}

// --- DAG support ---

/**
 * Normalize a workflow into a DAG representation.
 * Every workflow owns an explicit DAG. The phase projection remains available
 * to phase-oriented presentation and policy code, but it is never used to
 * construct execution topology.
 */
export function normalizeWorkflow(name: string, options: WorkflowOptions = {}) {
  const hasRouting = Boolean(options?.category || options?.routing);
  if (hasRouting) {
    return normalizeWorkflowWithRouting(name, options);
  }

  const wf = getWorkflow(name);

  const nodes = wf.nodes;
  if (!nodes) {
    throw new Error(`workflow ${name} is missing its explicit DAG definition`);
  }
  const cacheKey = wf.name;
  if (_dagCache.has(cacheKey)) return _dagCache.get(cacheKey);
  const validation = validateDag(nodes);
  if (!validation.valid) {
    throw new Error(`workflow ${name} has invalid DAG: ${validation.errors.join(", ")}`);
  }
  const result = {
    name: wf.name,
    nodes: resolveSquadsInNodes(nodes),
    edges: buildEdges(nodes),
    maxConcurrentNodes: wf.maxConcurrentNodes || 1,
    isDag: true,
  };
  _dagCache.set(cacheKey, result);
  return result;
}

function normalizeWorkflowWithRouting(name: string, { category, routing = null }: WorkflowOptions = {}) {
  const routingRules = routing || {};
  assertValidRoutingRules(routingRules, { isWorkflowName });
  const selection = resolveEffectiveRouting(category || "", routingRules, { workflow: name });
  const wf = getWorkflow(selection.workflow || name);

  const baseNodes = wf.nodes;
  if (!baseNodes) {
    throw new Error(`workflow ${wf.name} is missing its explicit DAG definition`);
  }
  const validation = validateDag(baseNodes);
  if (!validation.valid) {
    throw new Error(`workflow ${wf.name} has invalid DAG: ${validation.errors.join(", ")}`);
  }
  const nodes = applyRoutingAgents(resolveSquadsInNodes(baseNodes), selection);
  return {
    name: wf.name,
    nodes: resolveSquadsInNodes(nodes),
    edges: buildEdges(nodes),
    maxConcurrentNodes: wf.maxConcurrentNodes || 1,
    isDag: true,
    routing: selection,
  };
}

function applyRoutingAgents(nodes: WorkflowNode[], selection: LooseRecord) {
  return nodes.map((node) => {
    const agent = agentForRoutingPhase(selection, node.phase, node.role);
    return agent ? { ...node, agent } : node;
  });
}

/**
 * Mark nodes with squad fields but do NOT resolve to concrete agent yet.
 * Agent resolution happens at execution time via resolveNodeAgent() so
 * that pool status is available for least-busy strategy.
 */
function resolveSquadsInNodes(nodes: WorkflowNode[]) {
  return nodes.map((node) => {
    if (!node.squad) return node;
    return { ...node, _squad: node.squad };
  });
}

/**
 * Resolve a node's agent at execution time with current pool status.
 * Supports squad strategies (least-busy, round-robin, leader-first).
 */
export function resolveNodeAgent(node: WorkflowNode, { poolStatus }: { poolStatus?: LooseRecord } = {}) {
  if (node._squad) {
    const squadName = typeof node._squad === "string" ? node._squad : String(node._squad);
    const agent = resolveSquadAgent(squadName, { poolStatus });
    if (agent) return agent;
  }
  return node.agent || null;
}

function buildEdges(nodes: WorkflowNode[]) {
  const edges: Array<{ from: string; to: string }> = [];
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
export function getDagNodes(name: string) {
  const workflow = normalizeWorkflow(name);
  return Array.isArray(workflow?.nodes) ? workflow.nodes : [];
}

/**
 * Register a custom DAG workflow at runtime.
 */
export function registerDagWorkflow(name: string, { nodes, maxConcurrentNodes = 2 }: { nodes: WorkflowNode[]; maxConcurrentNodes?: number }) {
  const validation = validateDag(nodes);
  if (!validation.valid) {
    throw new Error(`invalid DAG: ${validation.errors.join(", ")}`);
  }
  WORKFLOWS[name] = {
    name,
    phases: nodes.map((n) => n.phase),
    roleForPhase: Object.fromEntries(nodes.map((n) => [n.phase, n.role || "executor"])),
    dispatchForPhase: Object.fromEntries(nodes.map((n) => [n.phase, n.role || "executor"])),
    nodes,
    maxConcurrentNodes,
  };
  _dagCache.delete(name);
}
