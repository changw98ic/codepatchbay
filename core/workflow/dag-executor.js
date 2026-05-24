/**
 * DAG executor for workflow nodes.
 * Provides topological sort, ready-node identification, and concurrency control.
 * Compatible with legacy linear phase workflows via automatic conversion.
 */

/**
 * Topologically sort DAG nodes. Returns array of node IDs.
 * Throws if cycle detected.
 */
export function topologicalSort(nodes) {
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
export function readyNodes(nodes, completedNodeIds, runningNodeIds = new Set()) {
  const result = [];
  for (const n of nodes) {
    if (completedNodeIds.has(n.id) || runningNodeIds.has(n.id)) continue;
    const deps = n.dependsOn || [];
    if (deps.length === 0 || deps.every((d) => completedNodeIds.has(d))) {
      result.push(n.id);
    }
  }
  return result;
}

/**
 * Check if all DAG nodes are completed.
 */
export function isDagComplete(nodes, completedNodeIds) {
  return nodes.every((n) => completedNodeIds.has(n.id));
}

/**
 * Get a node by ID.
 */
export function getNode(nodes, nodeId) {
  return nodes.find((n) => n.id === nodeId) || null;
}

/**
 * Validate a DAG: check for cycles, missing deps, duplicate IDs.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateDag(nodes) {
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
    errors.push(e.message);
    return { valid: false, errors };
  }

  return { valid: true, errors: [] };
}

/**
 * Convert a legacy linear workflow (phases array) to a single-chain DAG.
 */
export function phasesToDag(phases, roleForPhase = {}, agent = null) {
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
export function scheduleReadyNodes(nodes, completedNodeIds, runningNodeIds, maxConcurrent = 2) {
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
 * @param {Function} [callbacks.onBeforeNode] - async (nodeId) => boolean|void
 * @param {Function} [callbacks.onNodeResult] - async (nodeId, result) => void
 * @param {string[]} [callbacks.seedCompleted] - Node IDs to pre-mark as completed
 * @returns {Promise<{ok: boolean, results: Map, failedNode?: string, reason?: string}>}
 */
export async function executeDag(dag, callbacks) {
  const { executor, shouldStop = () => false, onBeforeNode, onNodeResult, seedCompleted } = callbacks;
  const nodes = dag.nodes;
  const completed = new Set(seedCompleted || []);
  const results = new Map();
  const attempts = new Map();

  while (!isDagComplete(nodes, completed)) {
    if (shouldStop()) return { ok: false, results, reason: "stopped" };

    const ready = readyNodes(nodes, completed);
    if (ready.length === 0) break;

    const nodeId = ready[0];
    const node = getNode(nodes, nodeId);
    const maxAttempts = node.maxRetries ?? 3;
    const attempt = (attempts.get(nodeId) || 0) + 1;
    attempts.set(nodeId, attempt);

    if (onBeforeNode) {
      const proceed = await onBeforeNode(nodeId);
      if (proceed === false) return { ok: false, results, failedNode: nodeId, reason: "cancelled" };
    }

    const result = await executor(node, { attempt, maxAttempts });
    results.set(nodeId, result);
    if (onNodeResult) await onNodeResult(nodeId, result);

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
