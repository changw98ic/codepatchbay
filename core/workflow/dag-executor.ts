/**
 * DAG executor for workflow nodes.
 * Provides topological sort, ready-node identification, and concurrency control.
 * Compatible with legacy linear phase workflows via automatic conversion.
 */

/**
 * Topologically sort DAG nodes. Returns array of node IDs.
 * Throws if cycle detected.
 */
export function topologicalSort(nodes: Record<string, any>[]) {
  const adjacency = new Map();
  const inDegree = new Map();
  for (const n of nodes) {
    adjacency.set(n.id, []);
    inDegree.set(n.id, 0);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn || []) {
      if (adjacency.has(dep)) {
        adjacency.get(dep).push(n.id);
        inDegree.set(n.id, (inDegree.get(n.id) || 0) + 1);
      }
    }
  }

  const queue = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted = [];
  while (queue.length > 0) {
    const id = queue.shift();
    sorted.push(id);
    for (const next of adjacency.get(id) || []) {
      inDegree.set(next, inDegree.get(next) - 1);
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
export function readyNodes(nodes: Record<string, any>[], completedNodeIds: Set<string>, runningNodeIds: Set<string> = new Set()) {
  const result: string[] = [];
  for (const n of nodes) {
    if (completedNodeIds.has(n.id) || runningNodeIds.has(n.id)) continue;
    const deps = n.dependsOn || [];
    if (deps.length === 0 || deps.every((d: string) => completedNodeIds.has(d))) {
      result.push(n.id);
    }
  }
  return result;
}

/**
 * Check if all DAG nodes are completed.
 */
export function isDagComplete(nodes: Record<string, any>[], completedNodeIds: Set<string>) {
  return nodes.every((n) => completedNodeIds.has(n.id));
}

/**
 * Get a node by ID.
 */
export function getNode(nodes: Record<string, any>[], nodeId: string) {
  return nodes.find((n) => n.id === nodeId) || null;
}

function orderedPhaseEntries(phaseStates: Record<string, any>) {
  if (!phaseStates || typeof phaseStates !== "object") return [];
  return Object.entries(phaseStates)
    .map(([phase, value]) => {
      const status = value && typeof value === "object" ? (value as Record<string, any>).status : value;
      return [phase, status];
    })
    .filter(([phase]) => Boolean(phase));
}

/**
 * Derive deterministic DAG resume metadata from node-first state.
 * Falls back to phase names only when no workflow DAG nodes are available.
 */
export function deriveDagResumeState({ workflowDag, nodeStates = {}, phaseStates = {} }: Record<string, any> = {}) {
  const nodes: Record<string, any>[] = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes.filter((node: Record<string, any>) => node?.id) : [];

  if (nodes.length === 0) {
    const nodeEntries = Object.entries(nodeStates || {}).filter(([nodeId]) => Boolean(nodeId));
    if (nodeEntries.length > 0) {
      const completedNodeIds = [];
      let failedNodeId = null;
      let failedPhase = null;
      for (const [nodeId, node] of nodeEntries) {
        const entry = node as Record<string, any>;
        const status = node && typeof node === "object" ? entry.status : node;
        if (status === "completed" || status === "skipped") completedNodeIds.push(nodeId);
        if (!failedNodeId && ["failed", "blocked", "cancelled"].includes(status)) {
          failedNodeId = nodeId;
          failedPhase = entry?.phase || nodeId;
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
    for (const [phase, status] of orderedPhaseEntries(phaseStates)) {
      if (status === "completed") completedNodeIds.push(phase);
      if (!failedNodeId && ["failed", "blocked", "cancelled"].includes(status)) failedNodeId = phase;
    }
    const resumeTarget = failedNodeId ? { nodeId: failedNodeId, phase: failedNodeId } : null;
    return {
      completedNodeIds,
      failedNodeId,
      readyNodeIds: failedNodeId ? [failedNodeId] : [],
      blockedNodeIds: [] as string[],
      resumeTarget,
    };
  }

  const completed = new Set<string>();
  const running = new Set<string>();
  const unavailable = new Set<string>();
  let failedNodeId = null;

  for (const node of nodes) {
    const status = nodeStates[node.id]?.status;
    if (status === "completed" || status === "skipped") {
      completed.add(node.id);
      continue;
    }
    if (status === "running" || status === "retrying") {
      running.add(node.id);
      unavailable.add(node.id);
      continue;
    }
    if (status === "failed" || status === "blocked" || status === "cancelled") {
      unavailable.add(node.id);
      if (!failedNodeId) failedNodeId = node.id;
    }
  }

  const completedNodeIds = nodes.map((node) => node.id).filter((id: string) => completed.has(id));
  const readyNodeIds: string[] = [];
  const blockedNodeIds: string[] = [];

  for (const node of nodes) {
    if (completed.has(node.id) || running.has(node.id)) continue;
    const deps = node.dependsOn || [];
    const depsComplete = deps.every((dep: string) => completed.has(dep));
    if (depsComplete) {
      readyNodeIds.push(node.id);
    } else if (!unavailable.has(node.id)) {
      blockedNodeIds.push(node.id);
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
export function validateDag(nodes: Record<string, any>[]) {
  const errors = [];
  const ids = new Set();

  for (const n of nodes) {
    if (!n.id) {
      errors.push(`node missing id: ${JSON.stringify(n)}`);
      continue;
    }
    if (ids.has(n.id)) {
      errors.push(`duplicate node id: ${n.id}`);
    }
    ids.add(n.id);
    if (!n.phase) {
      errors.push(`node ${n.id} missing phase`);
    }
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn || []) {
      if (!ids.has(dep)) {
        errors.push(`node ${n.id} depends on unknown node: ${dep}`);
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
export function scheduleReadyNodes(nodes: Record<string, any>[], completedNodeIds: Set<string>, runningNodeIds: Set<string>, maxConcurrent = 2) {
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
export async function executeDag(dag: Record<string, any>, callbacks: Record<string, any>) {
  const { executor, shouldStop = () => false, onBeforeNode, onNodeResult, seedCompleted } = callbacks;
  const nodes = dag.nodes;
  const completed = new Set<string>(seedCompleted || []);
  const results = new Map<string, any>();
  const attempts = new Map<string, number>();

  while (!isDagComplete(nodes, completed)) {
    if (shouldStop()) return { ok: false, results, reason: "stopped" };

    const ready = readyNodes(nodes, completed);
    if (ready.length === 0) break;

    const nodeId = ready[0];
    const node = getNode(nodes, nodeId);
    if (!node) return { ok: false, results, failedNode: nodeId, reason: `missing node: ${nodeId}` };
    const maxAttempts = node.maxRetries ?? 3;
    const attempt = (attempts.get(nodeId) || 0) + 1;
    attempts.set(nodeId, attempt);
    const ctx = { node, attempt, maxAttempts };

    if (onBeforeNode) {
      const proceed = await onBeforeNode(nodeId, ctx);
      if (proceed === false) return { ok: false, results, failedNode: nodeId, reason: "cancelled" };
    }

    const result = await executor(node, ctx);
    results.set(nodeId, result);
    if (onNodeResult) await onNodeResult(nodeId, result, ctx);

    if (result.ok) {
      completed.add(nodeId);
    } else if (result.reactivate) {
      const toClear = [result.reactivate];
      const visited = new Set(toClear);
      while (toClear.length > 0) {
        const current = toClear.shift();
        completed.delete(current);
        results.delete(current);
        for (const n of nodes) {
          if ((n.dependsOn || []).includes(current) && !visited.has(n.id)) {
            visited.add(n.id);
            toClear.push(n.id);
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
