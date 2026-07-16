import type { LooseRecord } from "../../shared/types.js";
/**
 * DAG executor for workflow nodes.
 * Provides topological sort, ready-node identification, and concurrency control.
 * Compatible with legacy linear phase workflows via automatic conversion.
 */

type DagCallbackContext = LooseRecord & {
  node: LooseRecord;
  attempt: number;
  maxAttempts: number;
};

type DagResult = LooseRecord & {
  ok?: boolean;
  retryable?: boolean;
  reactivate?: string;
  reason?: string;
};

type DagCallbacks = {
  executor?: (node: LooseRecord, ctx: DagCallbackContext) => Promise<DagResult> | DagResult;
  shouldStop?: () => boolean;
  onBeforeNode?: (nodeId: string, ctx: DagCallbackContext) => Promise<boolean | void> | boolean | void;
  onNodeResult?: (nodeId: string, result: DagResult, ctx: DagCallbackContext) => Promise<void> | void;
  seedCompleted?: string[];
};

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value || "");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function nodeId(node: LooseRecord): string {
  return stringValue(node.id);
}

function nodeDeps(node: LooseRecord): string[] {
  return stringArray(node.dependsOn);
}

/**
 * Topologically sort DAG nodes. Returns array of node IDs.
 * Throws if cycle detected.
 */
export function topologicalSort(nodes: LooseRecord[]) {
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const n of nodes) {
    const id = nodeId(n);
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }
  for (const n of nodes) {
    const id = nodeId(n);
    for (const dep of nodeDeps(n)) {
      if (adjacency.has(dep)) {
        adjacency.get(dep)?.push(id);
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id) continue;
    sorted.push(id);
    for (const next of adjacency.get(id) || []) {
      inDegree.set(next, (inDegree.get(next) || 0) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }

  if (sorted.length !== nodes.length) {
    throw new Error(`DAG cycle detected: ${nodes.length - sorted.length} node(s) unreachable`);
  }
  return sorted;
}

/**
 * Identify ready nodes — those whose dependencies are all completed.
 * @param {Array} nodes - DAG node definitions
 * @param {Set} completedNodeIds - IDs of already completed nodes
 * @param {Set} runningNodeIds - IDs of currently running nodes
 * @returns {Array} Node IDs that are ready to execute
 */
export function readyNodes(nodes: LooseRecord[], completedNodeIds: Set<string>, runningNodeIds: Set<string> = new Set()) {
  const result: string[] = [];
  for (const n of nodes) {
    const id = nodeId(n);
    if (completedNodeIds.has(id) || runningNodeIds.has(id)) continue;
    const deps = nodeDeps(n);
    if (deps.length === 0 || deps.every((d) => completedNodeIds.has(d))) {
      result.push(id);
    }
  }
  return result;
}

/**
 * Check if all DAG nodes are completed.
 */
export function isDagComplete(nodes: LooseRecord[], completedNodeIds: Set<string>) {
  return nodes.every((n) => completedNodeIds.has(nodeId(n)));
}

/**
 * Get a node by ID.
 */
export function getNode(nodes: LooseRecord[], nodeId: string) {
  return nodes.find((n) => nodeId === n.id) || null;
}

function orderedPhaseEntries(phaseStates: LooseRecord) {
  if (!phaseStates || typeof phaseStates !== "object") return [];
  return Object.entries(phaseStates)
    .map(([phase, value]) => {
      const status = value && typeof value === "object" && !Array.isArray(value) ? recordValue(value).status : value;
      return [phase, status];
    })
    .filter(([phase]) => Boolean(phase));
}

/**
 * Derive deterministic DAG resume metadata from node-first state.
 * Falls back to phase names only when no workflow DAG nodes are available.
 */
export function deriveDagResumeState({ workflowDag, nodeStates = {}, phaseStates = {} }: LooseRecord = {}) {
  const workflow = recordValue(workflowDag);
  const nodes: LooseRecord[] = Array.isArray(workflow.nodes) ? workflow.nodes.map(recordValue).filter((node) => node.id) : [];
  const nodeStateMap = recordValue(nodeStates);

  if (nodes.length === 0) {
    const nodeEntries = Object.entries(nodeStateMap).filter(([nodeId]) => Boolean(nodeId));
    if (nodeEntries.length > 0) {
      const completedNodeIds = [];
      let failedNodeId = null;
      let failedPhase = null;
      for (const [nodeId, node] of nodeEntries) {
        const nodeObj = node && typeof node === "object" && !Array.isArray(node) ? recordValue(node) : null;
        const status = nodeObj ? nodeObj.status : node;
        if (status === "completed" || status === "skipped") completedNodeIds.push(nodeId);
        if (!failedNodeId && ["failed", "blocked", "cancelled"].includes(String(status))) {
          failedNodeId = nodeId;
          failedPhase = stringValue(nodeObj?.phase) || nodeId;
        }
      }
      return {
        completedNodeIds,
        failedNodeId,
        readyNodeIds: failedNodeId ? [failedNodeId] : [],
        blockedNodeIds: [],
        resumeTarget: failedNodeId ? { nodeId: failedNodeId, phase: failedPhase } : null,
      };
    }

    const completedNodeIds = [];
    let failedNodeId = null;
    for (const [phase, status] of orderedPhaseEntries(recordValue(phaseStates))) {
      if (status === "completed") completedNodeIds.push(phase);
      if (!failedNodeId && ["failed", "blocked", "cancelled"].includes(String(status))) failedNodeId = phase;
    }
    const resumeTarget = failedNodeId ? { nodeId: failedNodeId, phase: failedNodeId } : null;
    return {
      completedNodeIds,
      failedNodeId,
      readyNodeIds: failedNodeId ? [failedNodeId] : [],
      blockedNodeIds: [],
      resumeTarget,
    };
  }

  const completed = new Set<string>();
  const running = new Set<string>();
  const unavailable = new Set<string>();
  let failedNodeId = null;

  for (const node of nodes) {
    const id = nodeId(node);
    const status = recordValue(nodeStateMap[id]).status;
    if (status === "completed" || status === "skipped") {
      completed.add(id);
      continue;
    }
    if (status === "running" || status === "retrying") {
      running.add(id);
      unavailable.add(id);
      continue;
    }
    if (status === "failed" || status === "blocked" || status === "cancelled") {
      unavailable.add(id);
      if (!failedNodeId) failedNodeId = id;
    }
  }

  const completedNodeIds = nodes.map(nodeId).filter((id) => completed.has(id));
  const readyNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];

  for (const node of nodes) {
    const id = nodeId(node);
    if (completed.has(id) || running.has(id)) continue;
    const deps = nodeDeps(node);
    const depsComplete = deps.every((dep) => completed.has(dep));
    if (depsComplete) {
      readyNodeIds.push(id);
    } else if (!unavailable.has(id)) {
      blockedNodeIds.push(id);
    }
  }

  const targetId = failedNodeId || readyNodeIds[0] || null;
  const targetNode = targetId ? getNode(nodes, targetId) : null;

  return {
    completedNodeIds,
    failedNodeId,
    readyNodeIds,
    blockedNodeIds,
    resumeTarget: targetId ? { nodeId: targetId, phase: targetNode?.phase ?? targetId } : null,
  };
}

/**
 * Validate a DAG: check for cycles, missing deps, duplicate IDs.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateDag(nodes: LooseRecord[]) {
  const errors = [];
  const ids = new Set();

  for (const n of nodes) {
    const id = nodeId(n);
    if (!id) {
      errors.push(`node missing id: ${JSON.stringify(n)}`);
      continue;
    }
    if (ids.has(id)) {
      errors.push(`duplicate node id: ${id}`);
    }
    ids.add(id);
    if (!n.phase) {
      errors.push(`node ${id} missing phase`);
    }
  }

  for (const n of nodes) {
    const id = nodeId(n);
    for (const dep of nodeDeps(n)) {
      if (!ids.has(dep)) {
        errors.push(`node ${id} depends on unknown node: ${dep}`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  try {
    topologicalSort(nodes);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Convert a legacy linear workflow (phases array) to a single-chain DAG.
 */
export function phasesToDag(phases: string[], roleForPhase: Record<string, string> = {}, agent: string | null = null) {
  return phases.map((phase, idx) => ({
    id: phase,
    phase,
    role: roleForPhase[phase] || null,
    agent: agent || null,
    dependsOn: idx === 0 ? [] : [phases[idx - 1]],
  }));
}

/**
 * Get the maximum concurrency for ready nodes.
 * Respects maxConcurrentNodes limit.
 */
export function scheduleReadyNodes(nodes: LooseRecord[], completedNodeIds: Set<string>, runningNodeIds: Set<string>, maxConcurrent = 2) {
  const ready = readyNodes(nodes, completedNodeIds, runningNodeIds);
  const available = maxConcurrent - runningNodeIds.size;
  return ready.slice(0, Math.max(0, available));
}

/**
 * Execute a DAG with retry and upstream reactivation.
 *
 * For each ready node, calls executor(node, ctx). On failure:
 * - result.reactivate: un-complete that node + transitive downstream, retry chain
 * - result.retryable && attempts < maxRetries: retry same node
 * - Otherwise: terminate
 *
 * @param {Object} dag - DAG from normalizeWorkflow()
 * @param {Object} callbacks
 * @param {Function} callbacks.executor - async (node, ctx) => { ok, reason?, retryable?, reactivate? }
 * @param {Function} [callbacks.shouldStop] - () => boolean
 * @param {Function} [callbacks.onBeforeNode] - async (nodeId, ctx) => boolean|void
 * @param {Function} [callbacks.onNodeResult] - async (nodeId, result, ctx) => void
 * @param {string[]} [callbacks.seedCompleted] - Node IDs to pre-mark as completed
 * @returns {Promise<{ok: boolean, results: Map, failedNode?: string, reason?: string}>}
 */
export async function executeDag(dag: LooseRecord, callbacks: DagCallbacks) {
  const { executor, shouldStop = () => false, onBeforeNode, onNodeResult, seedCompleted } = callbacks;
  if (typeof executor !== "function") throw new Error("executeDag requires executor callback");
  const nodes = Array.isArray(dag.nodes) ? dag.nodes.map(recordValue).filter((node) => node.id) : [];
  const completed = new Set<string>(stringArray(seedCompleted));
  const results = new Map<string, unknown>();
  const attempts = new Map<string, number>();

  while (!isDagComplete(nodes, completed)) {
    if (shouldStop()) return { ok: false, results, reason: "stopped" };

    const ready = readyNodes(nodes, completed);
    if (ready.length === 0) break;

    const nodeId = ready[0];
    const node = getNode(nodes, nodeId);
    if (!node) return { ok: false, results, failedNode: nodeId, reason: `missing node: ${nodeId}` };
    const maxAttempts = typeof node.maxRetries === "number" ? node.maxRetries : 3;
    const attempt = (attempts.get(nodeId) || 0) + 1;
    attempts.set(nodeId, attempt);
    const ctx = { node, attempt, maxAttempts };

    if (onBeforeNode) {
      const proceed = await onBeforeNode(nodeId, ctx);
      if (proceed === false) return { ok: false, results, failedNode: nodeId, reason: "cancelled" };
    }

    const result = recordValue(await executor(node, ctx)) as DagResult;
    results.set(nodeId, result);
    if (onNodeResult) await onNodeResult(nodeId, result, ctx);

    if (result.ok) {
      completed.add(nodeId);
    } else if (result.reactivate) {
      const toClear = [String(result.reactivate)];
      const visited = new Set(toClear);
      while (toClear.length > 0) {
        const current = toClear.shift();
        if (!current) continue;
        completed.delete(current);
        results.delete(current);
        for (const n of nodes) {
          const id = stringValue(n.id);
          if (nodeDeps(n).includes(String(current)) && !visited.has(id)) {
            visited.add(id);
            toClear.push(id);
          }
        }
      }
    } else if (result.retryable && attempt < maxAttempts) {
      // Not completed — will be picked up again next iteration
    } else {
      return { ok: false, results, failedNode: nodeId, reason: result.reason };
    }
  }

  return { ok: isDagComplete(nodes, completed), results };
}
