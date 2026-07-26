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
  signal?: AbortSignal;
};

type DagResult = LooseRecord & {
  ok?: boolean;
  retryable?: boolean;
  reactivate?: string;
  reason?: string;
  failure?: LooseRecord;
};

type DagExecutionResult = {
  ok: boolean;
  results: Map<string, DagResult>;
  failedNode?: string;
  reason?: string;
  failure?: LooseRecord;
};

type DagCallbacks = {
  executor?: (node: LooseRecord, ctx: DagCallbackContext) => Promise<DagResult> | DagResult;
  shouldStop?: () => boolean;
  onBeforeNode?: (nodeId: string, ctx: DagCallbackContext) => Promise<boolean | void> | boolean | void;
  onNodeResult?: (nodeId: string, result: DagResult, ctx: DagCallbackContext) => Promise<void> | void;
  seedCompleted?: string[];
  signal?: AbortSignal;
  providerCapacity?: (providerKey: string) => number;
  providerKeyForNode?: (node: LooseRecord) => string | null;
};

type ScheduleReadyNodesOptions = {
  providerCapacity?: (providerKey: string) => number;
  providerKeyForNode?: (node: LooseRecord) => string | null;
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

function executorExceptionResult(error: unknown): DagResult {
  const exception = recordValue(error);
  const reason = error instanceof Error ? error.message : String(error);
  const code = typeof exception.code === "string" || typeof exception.code === "number"
    ? String(exception.code)
    : null;
  return {
    ok: false,
    reason,
    failure: {
      kind: "executor_exception",
      thrown: true,
      name: error instanceof Error ? error.name : String(exception.constructor?.name || typeof error),
      code,
      stack: error instanceof Error && typeof error.stack === "string" ? error.stack.slice(0, 8_000) : null,
    },
  };
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
export function scheduleReadyNodes(
  nodes: LooseRecord[],
  completedNodeIds: Set<string>,
  runningNodeIds: Set<string>,
  maxConcurrent = 2,
  options: ScheduleReadyNodesOptions = {},
) {
  const ready = readyNodes(nodes, completedNodeIds, runningNodeIds);
  const available = maxConcurrent - runningNodeIds.size;
  if (Math.max(0, available) <= 0) return [];
  if (!options.providerCapacity) return ready.slice(0, Math.max(0, available));

  const { providerCapacity, providerKeyForNode } = options;
  const selected: string[] = [];
  const remaining = new Map<string, number>();
  const runningByProvider = new Map<string, number>();

  for (const runningNodeId of runningNodeIds) {
    const runningNode = getNode(nodes, runningNodeId);
    if (!runningNode) continue;
    const providerKey = providerKeyForNode ? providerKeyForNode(runningNode) : null;
    const effectiveProviderKey = providerKey || "__default__";
    runningByProvider.set(effectiveProviderKey, (runningByProvider.get(effectiveProviderKey) || 0) + 1);
  }

  for (const nodeId of ready) {
    if (selected.length >= available) break;
    const node = getNode(nodes, nodeId);
    if (!node) continue;
    const providerKey = providerKeyForNode ? providerKeyForNode(node) : null;
    const effectiveProviderKey = providerKey || "__default__";
    const providerLimit = Math.max(0, Math.floor(providerCapacity(effectiveProviderKey)));
    if (providerLimit <= 0) continue;
    const remainingBudget = remaining.get(effectiveProviderKey)
      ?? Math.max(0, providerLimit - (runningByProvider.get(effectiveProviderKey) || 0));
    if (remainingBudget <= 0) continue;
    remaining.set(effectiveProviderKey, remainingBudget - 1);
    selected.push(nodeId);
  }

  return selected;
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
 * @returns {Promise<{ok: boolean, results: Map, failedNode?: string, reason?: string, failure?: object}>}
 */
export async function executeDag(dag: LooseRecord, callbacks: DagCallbacks): Promise<DagExecutionResult> {
  const {
    executor,
    shouldStop = () => false,
    onBeforeNode,
    onNodeResult,
    seedCompleted,
    signal,
    providerCapacity,
    providerKeyForNode,
  } = callbacks;
  if (typeof executor !== "function") throw new Error("executeDag requires executor callback");
  const nodes = Array.isArray(dag.nodes) ? dag.nodes.map(recordValue) : [];
  const validation = validateDag(nodes);
  if (!validation.valid) {
    throw new Error(`invalid DAG: ${validation.errors.join(", ")}`);
  }
  const completed = new Set<string>(stringArray(seedCompleted));
  const results = new Map<string, DagResult>();
  const attempts = new Map<string, number>();
  const running = new Set<string>();
  const configuredConcurrency = Number(dag.maxConcurrentNodes);
  const maxConcurrentNodes = Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
    ? Math.max(1, Math.floor(configuredConcurrency))
    : 1;

  const clearNodeAndDownstream = (targetNodeId: string) => {
    const toClear = [targetNodeId];
    const visited = new Set(toClear);
    while (toClear.length > 0) {
      const current = toClear.shift();
      if (!current) continue;
      completed.delete(current);
      results.delete(current);
      for (const node of nodes) {
        const id = nodeId(node);
        if (nodeDeps(node).includes(current) && !visited.has(id)) {
          visited.add(id);
          toClear.push(id);
        }
      }
    }
  };

  while (!isDagComplete(nodes, completed)) {
    if (signal?.aborted) return { ok: false, results, reason: "aborted" };
    if (shouldStop()) return { ok: false, results, reason: "stopped" };

    const ready = scheduleReadyNodes(nodes, completed, running, maxConcurrentNodes, {
      providerCapacity,
      providerKeyForNode,
    });
    if (ready.length === 0) break;

    const contexts: Array<{ nodeId: string; node: LooseRecord; ctx: DagCallbackContext }> = [];
    for (const readyNodeId of ready) {
      if (signal?.aborted) break;
      const node = getNode(nodes, readyNodeId);
      if (!node) {
        return { ok: false, results, failedNode: readyNodeId, reason: `missing node: ${readyNodeId}` };
      }
      const maxAttempts = typeof node.maxRetries === "number" ? node.maxRetries : 3;
      const attempt = (attempts.get(readyNodeId) || 0) + 1;
      const ctx: DagCallbackContext = { node, attempt, maxAttempts, signal };
      if (onBeforeNode) {
        const proceed = await onBeforeNode(readyNodeId, ctx);
        if (proceed === false) {
          return { ok: false, results, failedNode: readyNodeId, reason: "cancelled" };
        }
      }
      running.add(readyNodeId);
      contexts.push({ nodeId: readyNodeId, node, ctx });
    }

    const inFlight: Array<{
      nodeId: string;
      ctx: DagCallbackContext;
      result: Promise<DagResult>;
    }> = [];
    for (const entry of contexts) {
      if (signal?.aborted || shouldStop()) break;
      attempts.set(entry.nodeId, entry.ctx.attempt);
      try {
        inFlight.push({
          nodeId: entry.nodeId,
          ctx: entry.ctx,
          result: Promise.resolve(executor(entry.node, entry.ctx)).then((value) => recordValue(value) as DagResult),
        });
      } catch (error) {
        inFlight.push({
          nodeId: entry.nodeId,
          ctx: entry.ctx,
          result: Promise.resolve(executorExceptionResult(error)),
        });
      }
    }

    if (inFlight.length === 0) {
      return { ok: false, results, reason: signal?.aborted ? "aborted" : "stopped" };
    }

    const settled = await Promise.all(inFlight.map(async (entry) => {
      try {
        return { ...entry, value: await entry.result };
      } catch (error) {
        return {
          ...entry,
          value: executorExceptionResult(error),
        };
      }
    }));

    let fatal: { nodeId: string; result: DagResult } | null = null;
    const reactivated: string[] = [];
    for (const entry of settled) {
      const result = entry.value;
      results.set(entry.nodeId, result);
      if (onNodeResult) await onNodeResult(entry.nodeId, result, entry.ctx);

      if (fatal) continue;
      if (result.ok) {
        completed.add(entry.nodeId);
      } else if (result.reactivate) {
        reactivated.push(String(result.reactivate));
      } else if (result.retryable && entry.ctx.attempt < entry.ctx.maxAttempts) {
        // Leave the node pending; completed siblings remain reusable.
      } else {
        fatal = { nodeId: entry.nodeId, result };
      }
    }

    for (const targetNodeId of reactivated) clearNodeAndDownstream(targetNodeId);
    for (const { nodeId: completedNodeId } of settled) {
      running.delete(completedNodeId);
    }

    if (fatal) {
      return {
        ok: false,
        results,
        failedNode: fatal.nodeId,
        reason: fatal.result.reason,
        ...(fatal.result.failure ? { failure: fatal.result.failure } : {}),
      };
    }
    if (signal?.aborted) return { ok: false, results, reason: "aborted" };
    if (shouldStop()) return { ok: false, results, reason: "stopped" };
  }

  return { ok: isDagComplete(nodes, completed), results };
}
