import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  claimEligible,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../server/services/hub/hub-queue.js";
import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "../server/services/infra.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { tempRoot, oldIso, readJson, writeJson } from "./helpers.js";

// Mock assignmentStore: always returns null (no active assignment)
const noAssignmentStore = { getAssignment: async () => null };

function highConfidenceCapabilityMetadata() {
  const projectCapabilityMap = {
    confidence: "high",
    coreModules: ["server/orchestrator/scheduler.js"],
    testSurfaces: ["tests/queue-orchestrator.test.js"],
  };
  return {
    capabilityMapConfidence: "high",
    project_capability_map: projectCapabilityMap,
  };
}

async function sourceWithCodeGraphIndexButNoLiveState(prefix) {
  const sourcePath = await tempRoot(prefix);
  await mkdir(path.join(sourcePath, ".codegraph"), { recursive: true });
  await writeFile(path.join(sourcePath, ".codegraph", "codegraph.db"), Buffer.alloc(2048, 1));
  return sourcePath;
}

async function sourceWithLiveCodeGraphState(prefix) {
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState(prefix);
  await writeJson(path.join(sourcePath, ".codegraph", "daemon.pid"), {
    pid: process.pid,
    codebaseRoot: sourcePath,
    source: "test",
  });
  return sourcePath;
}

async function registerReadyProject(hubRoot, id, prefix) {
  const sourcePath = await sourceWithLiveCodeGraphState(prefix);
  await registerProject(hubRoot, {
    id,
    sourcePath,
    skipCodeGraphGate: true,
    metadata: highConfidenceCapabilityMetadata(),
  });
  return sourcePath;
}

test("enqueue dedupes pending entries and requires UI lane reason", async () => {
  const hubRoot = await tempRoot("cpb-queue");
  const first = await enqueue(hubRoot, {
    projectId: "proj",
    description: "same task",
    metadata: { queueDedupeKey: "same-origin" },
  });
  const second = await enqueue(hubRoot, {
    projectId: "proj",
    description: "same task",
    metadata: { queueDedupeKey: "same-origin" },
  });

  assert.equal(second.id, first.id);
  assert.equal((await listQueue(hubRoot)).length, 1);

  await assert.rejects(
    enqueue(hubRoot, {
      projectId: "proj",
      description: "ui task",
      metadata: { acpProfile: "ui" },
    }),
    /ui profile requires a non-empty uiLaneReason/,
  );
});

test("claimEligible reports provider slot exhaustion without mutating pending queue", async () => {
  const hubRoot = await tempRoot("cpb-queue-provider");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "blocked by provider slots" });

  const result = await claimEligible(hubRoot, {
    workerId: "w-provider",
    providerSlotsAvailable: false,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(result.entry, null);
  assert.equal(result.reason, "provider-slots-exhausted");
  assert.equal((await listQueue(hubRoot))[0].id, entry.id);
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
});

test("queueStatus separates historical failed entries from failed targets still needing retry", async () => {
  const hubRoot = await tempRoot("cpb-queue-failed-targets");
  const original = await enqueue(hubRoot, { projectId: "proj", description: "original failed job" });
  await updateEntry(hubRoot, original.id, { status: "failed" });
  const failedRetry = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${original.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${original.id}` },
  });
  await updateEntry(hubRoot, failedRetry.id, { status: "failed" });
  await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${original.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${original.id}` },
  });
  const unretried = await enqueue(hubRoot, { projectId: "proj", description: "unretried failed job" });
  await updateEntry(hubRoot, unretried.id, { status: "failed" });
  const retried = await enqueue(hubRoot, { projectId: "proj", description: "retried failed job" });
  await updateEntry(hubRoot, retried.id, { status: "failed" });
  const completedRetry = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Retry job job-${retried.id}`,
    type: "cli_retry",
    metadata: { retryJobId: `job-${retried.id}` },
  });
  await updateEntry(hubRoot, completedRetry.id, { status: "completed" });

  const status = await queueStatus(hubRoot);

  assert.equal(status.failed, 4);
  assert.equal(status.failedEntries, 4);
  assert.equal(status.failedTargets, 3);
  assert.equal(status.retryingFailedTargets, 1);
  assert.equal(status.retriedFailedTargets, 1);
  assert.equal(status.unretriedFailedTargets, 1);
  assert.equal(status.projects.proj.failedEntries, 4);
  assert.equal(status.projects.proj.failedTargets, 3);
  assert.equal(status.projects.proj.retryingFailedTargets, 1);
  assert.equal(status.projects.proj.retriedFailedTargets, 1);
  assert.equal(status.projects.proj.unretriedFailedTargets, 1);
});

test("claimEligible recovers stale in_progress entries and reclaims them", async () => {
  const hubRoot = await tempRoot("cpb-queue-stale");
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale claim" });
  await updateEntry(hubRoot, entry.id, {
    status: "in_progress",
    claimedBy: "w-old",
    workerId: "w-old",
    claimedAt: oldIso(),
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-new",
    claimTimeoutMs: 1,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(result.entry.id, entry.id);
  assert.deepEqual(result.recovered, [entry.id]);
  assert.equal(result.entry.claimedBy, "w-new");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("claimEligible enforces per-project concurrency without any Hub-wide active cap", async () => {
  const hubRoot = await tempRoot("cpb-queue-concurrency");
  const removedHubTotalOption = ["maxActive", "Total"].join("");
  const active = await enqueue(hubRoot, { projectId: "proj-a", description: "active" });
  await claimEligible(hubRoot, { workerId: "w-active", assignmentStore: noAssignmentStore });
  await enqueue(hubRoot, { projectId: "proj-a", description: "same project pending" });
  await enqueue(hubRoot, { projectId: "proj-b", description: "other project pending" });

  const sameProject = await claimEligible(hubRoot, {
    workerId: "w-same",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 99,
    projectId: "proj-a",
    assignmentStore: noAssignmentStore,
  });
  assert.equal(sameProject.entry, null);
  assert.equal(sameProject.reason, "all-projects-busy");
  assert.deepEqual(sameProject.skippedBusy, ["proj-a"]);

  const otherProject = await claimEligible(hubRoot, {
    workerId: "w-global",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 1,
    assignmentStore: noAssignmentStore,
  });
  assert.equal(otherProject.entry.projectId, "proj-b");

  assert.equal((await listQueue(hubRoot)).find((entry) => entry.id === active.id).status, "in_progress");
});

test("Hub concurrency config never emits Hub-wide or ACP total caps", async () => {
  const hubRoot = await tempRoot("cpb-queue-concurrency-env");
  const removedHubTotalOption = ["maxActive", "Total"].join("");
  const removedAcpPoolTotalOption = ["acpPool", "Total"].join("");
  const removedHubTotalEnv = ["CPB_HUB_MAX_ACTIVE", "TOTAL"].join("_");
  const removedPoolTotalEnv = ["CPB_ACP_POOL", "TOTAL"].join("_");
  await import("node:fs/promises").then(({ mkdir, writeFile }) => Promise.all([
    mkdir(hubRoot, { recursive: true }),
    writeFile(
      path.join(hubRoot, "config.json"),
      JSON.stringify({
        concurrency: {
          maxActivePerProject: 4,
          [removedHubTotalOption]: 1,
        },
        acpPool: {
          total: 1,
          providerMax: 5,
        },
      }, null, 2) + "\n",
      "utf8",
    ),
  ]));

  const limits = await resolveHubConcurrencyLimits(hubRoot, {
    [removedHubTotalOption]: 1,
    [removedAcpPoolTotalOption]: 1,
    acpProviderMax: 6,
  });
  const env = hubConcurrencyEnv(limits);

  assert.deepEqual(limits, {
    maxActivePerProject: 4,
    acpProviderMax: 5,
  });
  assert.equal(Object.hasOwn(env, removedHubTotalEnv), false);
  assert.equal(Object.hasOwn(env, removedPoolTotalEnv), false);
  assert.deepEqual(env, {
    CPB_HUB_MAX_ACTIVE_PER_PROJECT: "4",
    CPB_ACP_POOL_PROVIDER_MAX: "5",
  });
});

test("claimEligible applies issue-link and index-unavailable gates", async () => {
  const hubRoot = await tempRoot("cpb-queue-gates");
  const unlinked = await enqueue(hubRoot, { projectId: "proj", description: "missing issue" });
  const linked = await enqueue(hubRoot, {
    projectId: "proj",
    description: "has issue",
    metadata: { issueNumber: 12 },
  });

  const issueGate = await claimEligible(hubRoot, {
    workerId: "w-linked",
    requireIssueLink: true,
    assignmentStore: noAssignmentStore,
  });
  assert.equal(issueGate.entry.id, linked.id);
  assert.equal((await listQueue(hubRoot)).find((entry) => entry.id === unlinked.id).status, "pending");

  const indexHubRoot = await tempRoot("cpb-queue-index");
  const staleIndex = await enqueue(indexHubRoot, { projectId: "indexed", description: "needs index" });
  const indexGate = await claimEligible(indexHubRoot, {
    workerId: "w-index",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "indexed"
        ? { id: projectId, sourcePath: null, projectRuntimeRoot: null }
        : null
    ),
  });
  assert.equal(indexGate.entry, null);

  const gated = (await listQueue(indexHubRoot)).find((entry) => entry.id === staleIndex.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.indexFreshness.available, false);
  assert.deepEqual(gated.metadata.indexFreshness.dirtyReasons, ["missing_source_or_runtime_root"]);
});

test("claimEligible blocks registered projects without high-confidence capability maps", async () => {
  const hubRoot = await tempRoot("cpb-queue-capability-map");
  const sourcePath = await tempRoot("cpb-queue-capability-source");
  const projectRuntimeRoot = await tempRoot("cpb-queue-capability-runtime");
  const pending = await enqueue(hubRoot, {
    projectId: "flow",
    description: "needs Project Capability Map",
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-capability-map",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "flow"
        ? { id: "flow", sourcePath, projectRuntimeRoot, metadata: {} }
        : null
    ),
  });

  assert.equal(result.entry, null);
  const gated = (await listQueue(hubRoot)).find((entry) => entry.id === pending.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.capabilityMap.available, false);
  assert.equal(gated.metadata.capabilityMap.reason, "missing_project_capability_map");
});

test("claimEligible blocks high-confidence projects when live CodeGraph readiness is missing", async () => {
  const hubRoot = await tempRoot("cpb-queue-live-codegraph");
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState("cpb-queue-live-codegraph-source");
  const projectRuntimeRoot = await tempRoot("cpb-queue-live-codegraph-runtime");
  const pending = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "needs live CodeGraph",
  });

  const result = await claimEligible(hubRoot, {
    workerId: "w-live-codegraph",
    assignmentStore: noAssignmentStore,
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "flow"
        ? {
          id: "flow",
          sourcePath,
          projectRuntimeRoot,
          metadata: highConfidenceCapabilityMetadata(),
        }
        : null
    ),
  });

  assert.equal(result.entry, null);
  const gated = (await listQueue(hubRoot)).find((entry) => entry.id === pending.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.codegraphReadiness.available, false);
  assert.equal(gated.metadata.codegraphReadiness.reason, "missing_codegraph_state");
  assert.deepEqual(gated.metadata.indexFreshness.dirtyReasons, ["missing_codegraph_state"]);
});

test("codegraph unavailable counters and recovery accept legacy index_unavailable rows", async () => {
  const hubRoot = await tempRoot("cpb-queue-codegraph-legacy");
  const current = await enqueue(hubRoot, { projectId: "proj", description: "current codegraph gate" });
  await updateEntry(hubRoot, current.id, {
    status: "codegraph_unavailable",
    updatedAt: oldIso(),
    metadata: { indexFreshness: { available: false } },
  });
  const legacy = await enqueue(hubRoot, { projectId: "proj", description: "legacy index gate" });
  await updateEntry(hubRoot, legacy.id, {
    status: "index_unavailable",
    updatedAt: oldIso(),
    metadata: { indexFreshness: { available: false } },
  });

  const status = await queueStatus(hubRoot);
  assert.equal(status.indexUnavailable, 2);
  assert.equal(status.codegraphUnavailable, 2);
  assert.equal(status.projects.proj.indexUnavailable, 2);
  assert.equal(status.projects.proj.codegraphUnavailable, 2);

  const first = await claimEligible(hubRoot, {
    workerId: "w-legacy",
    indexUnavailableRetryMs: 1,
    assignmentStore: noAssignmentStore,
  });

  assert.equal(first.entry.id, current.id);
  assert.deepEqual(first.recovered, [current.id, legacy.id]);
  const recovered = await listQueue(hubRoot);
  assert.equal(recovered.find((entry) => entry.id === current.id).status, "in_progress");
  assert.equal(recovered.find((entry) => entry.id === legacy.id).status, "pending");
  assert.equal(recovered.find((entry) => entry.id === legacy.id).metadata.indexFreshness, undefined);
});

test("HubOrchestrator.tick stops on leader lock loss", async () => {
  const hubRoot = await tempRoot("cpb-orch-leader");
  const cpbRoot = await tempRoot("cpb-orch-cpb");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  let released = false;
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => false,
    release: async () => { released = true; },
  };

  const result = await orchestrator.tick();

  assert.deepEqual(result, { stopped: true, reason: "leader lock lost" });
  assert.equal(orchestrator.running, false);
  assert.equal(released, true);
});

test("HubOrchestrator scheduler applies provider capacity per provider", async () => {
  const hubRoot = await tempRoot("cpb-orch-provider-capacity");
  const cpbRoot = await tempRoot("cpb-orch-provider-capacity-cpb");
  await writeJson(path.join(hubRoot, "config.json"), {
    scheduler: { mode: "default" },
    acpPool: { providerMax: 1 },
  });
  await registerReadyProject(hubRoot, "proj-a", "cpb-orch-provider-a-source");
  await registerReadyProject(hubRoot, "proj-b", "cpb-orch-provider-b-source");
  await registerReadyProject(hubRoot, "proj-c", "cpb-orch-provider-c-source");
  const activeCodex = await enqueue(hubRoot, {
    projectId: "proj-a",
    description: "active codex",
    metadata: { agents: { executor: { agent: "codex" } } },
  });
  await updateEntry(hubRoot, activeCodex.id, {
    status: "in_progress",
    claimedBy: "w-codex",
    claimedAt: new Date().toISOString(),
  });
  await enqueue(hubRoot, {
    projectId: "proj-b",
    description: "pending codex",
    priority: "P0",
    metadata: { agents: { executor: { agent: "codex" } } },
  });
  const pendingClaude = await enqueue(hubRoot, {
    projectId: "proj-c",
    description: "pending claude",
    priority: "P1",
    metadata: { agents: { executor: { agent: "claude" } } },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();

  const candidates = await orchestrator.scheduler.nextCandidates(10);

  assert.deepEqual(candidates.map((entry) => entry.id), [pendingClaude.id]);
});

test("HubOrchestrator scheduler gates missing project capability maps before dispatch", async () => {
  const hubRoot = await tempRoot("cpb-orch-capability-gate");
  const cpbRoot = await tempRoot("cpb-orch-capability-gate-cpb");
  const sourcePath = await tempRoot("cpb-orch-capability-source");
  await registerProject(hubRoot, { id: "flow", sourcePath, skipCodeGraphGate: true });
  const entry = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "must not dispatch without capability maps",
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-capability", {
    projectId: "flow",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 7,
    release: async () => {},
  };
  orchestrator.reconciler = { reconcileAssignments: async () => {} };

  const result = await orchestrator.tick();

  assert.deepEqual(result, { idle: true });
  assert.equal(await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`), null);
  const gated = (await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.capabilityMap.available, false);
  assert.equal(gated.metadata.capabilityMap.reason, "missing_project_capability_map");
});

test("HubOrchestrator scheduler gates missing live CodeGraph readiness before dispatch", async () => {
  const hubRoot = await tempRoot("cpb-orch-live-codegraph");
  const cpbRoot = await tempRoot("cpb-orch-live-codegraph-cpb");
  const sourcePath = await sourceWithCodeGraphIndexButNoLiveState("cpb-orch-live-codegraph-source");
  await registerProject(hubRoot, {
    id: "flow",
    sourcePath,
    skipCodeGraphGate: true,
    metadata: highConfidenceCapabilityMetadata(),
  });
  const entry = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "must not dispatch without live CodeGraph",
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-live-codegraph", {
    projectId: "flow",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 9,
    release: async () => {},
  };
  orchestrator.reconciler = { reconcileAssignments: async () => {} };

  const result = await orchestrator.tick();

  assert.deepEqual(result, { idle: true });
  assert.equal(await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`), null);
  const gated = (await listQueue(hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(gated.status, "codegraph_unavailable");
  assert.equal(gated.metadata.codegraphReadiness.available, false);
  assert.equal(gated.metadata.codegraphReadiness.reason, "missing_codegraph_state");
});

test("HubOrchestrator scheduler does not oversubscribe one provider in a single tick", async () => {
  const hubRoot = await tempRoot("cpb-orch-provider-same-tick");
  const cpbRoot = await tempRoot("cpb-orch-provider-same-tick-cpb");
  await writeJson(path.join(hubRoot, "config.json"), {
    scheduler: { mode: "default" },
    acpPool: { providerMax: 1 },
  });
  const sourcePath = await registerReadyProject(hubRoot, "flow", "cpb-orch-provider-same-tick-source");
  const first = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "first codex task",
    metadata: {
      agents: { executor: { agent: "codex" } },
    },
  });
  const second = await enqueue(hubRoot, {
    projectId: "flow",
    sourcePath,
    description: "second codex task",
    metadata: {
      agents: { executor: { agent: "codex" } },
    },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  await orchestrator.workerStore.registerWorker("w-one", { projectId: "flow", status: "ready" });
  await orchestrator.workerStore.registerWorker("w-two", { projectId: "flow", status: "ready" });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 8,
    release: async () => {},
  };
  orchestrator.reconciler = { reconcileAssignments: async () => {} };

  const result = await orchestrator.tick();
  const entries = await listQueue(hubRoot);
  const scheduled = entries.filter((entry) => entry.status === "scheduled");
  const pending = entries.filter((entry) => entry.status === "pending");

  assert.equal(result.dispatched.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(pending.length, 1);
  assert.deepEqual(new Set(entries.map((entry) => entry.id)), new Set([first.id, second.id]));
});

test("HubOrchestrator.tick writes inbox then keeps queue, assignment, and worker state aligned", async () => {
  const hubRoot = await tempRoot("cpb-orch-tick");
  const cpbRoot = await tempRoot("cpb-orch-cpb");
  const sourcePath = await tempRoot("cpb-source");
  const entry = await enqueue(hubRoot, {
    projectId: "proj",
    sourcePath,
    description: "dispatch me",
    metadata: { workflow: "complex", planMode: "full", issueNumber: 7 },
  });

  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot, { executorRoot: process.cwd() });
  await orchestrator.assignmentStore.init();
  await orchestrator.workerStore.init();
  const worker = await orchestrator.workerStore.registerWorker("w-dispatch", {
    projectId: "proj",
    status: "ready",
  });
  orchestrator.running = true;
  orchestrator.leaderLock = {
    stillHeld: async () => true,
    getEpoch: () => 42,
    release: async () => {},
  };
  orchestrator.scheduler = {
    nextCandidates: async () => [entry],
    nextCandidate: async () => entry,
    findIdleWorker: async () => worker,
  };
  orchestrator.workerSupervisor = {
    ensureWorkerFor: async () => worker,
  };
  orchestrator.reconciler = { reconcileAssignments: async () => {} };

  const result = await orchestrator.tick();

  assert.equal(result.scheduled, true);
  const queueEntry = (await listQueue(hubRoot))[0];
  assert.equal(queueEntry.status, "scheduled");
  assert.equal(queueEntry.claimedBy, "w-dispatch");

  const assignment = await orchestrator.assignmentStore.getAssignment(`a-${entry.id}`);
  assert.equal(assignment.status, "assigned");
  assert.equal(assignment.activeAttempt, 1);
  assert.equal(assignment.sourceContext.queueEntryId, entry.id);

  const inbox = await orchestrator.workerStore.readInbox("w-dispatch");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].assignmentId, `a-${entry.id}`);
  assert.equal(inbox[0].attempt, 1);
  assert.equal(typeof inbox[0].attemptToken, "string");
  assert.equal(inbox[0].orchestratorEpoch, 42);

  const updatedWorker = await orchestrator.workerStore.getWorker("w-dispatch");
  assert.equal(updatedWorker.status, "assigned");
  assert.equal(updatedWorker.currentAssignmentId, `a-${entry.id}`);

  const projectJson = path.join(hubRoot, "queue", "queue.json");
  const persisted = await readJson(projectJson);
  assert.equal(persisted.entries[0].status, "scheduled");
});
