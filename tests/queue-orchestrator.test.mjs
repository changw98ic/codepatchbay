import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  claimEligible,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../server/services/hub-queue.js";
import { HubOrchestrator } from "../server/orchestrator/hub-orchestrator.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "../server/services/concurrency-limits.js";
import { tempRoot, oldIso, readJson } from "./helpers.mjs";

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
  const failedRepair = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Repair job job-${original.id}`,
    type: "cli_repair",
    metadata: { repairJobId: `job-${original.id}` },
  });
  await updateEntry(hubRoot, failedRepair.id, { status: "failed" });
  await enqueue(hubRoot, {
    projectId: "proj",
    description: `Repair job job-${original.id}`,
    type: "cli_repair",
    metadata: { repairJobId: `job-${original.id}` },
  });
  const unretried = await enqueue(hubRoot, { projectId: "proj", description: "unretried failed job" });
  await updateEntry(hubRoot, unretried.id, { status: "failed" });
  const repaired = await enqueue(hubRoot, { projectId: "proj", description: "repaired failed job" });
  await updateEntry(hubRoot, repaired.id, { status: "failed" });
  const completedRepair = await enqueue(hubRoot, {
    projectId: "proj",
    description: `Repair job job-${repaired.id}`,
    type: "cli_repair",
    metadata: { repairJobId: `job-${repaired.id}` },
  });
  await updateEntry(hubRoot, completedRepair.id, { status: "completed" });

  const status = await queueStatus(hubRoot);

  assert.equal(status.failed, 4);
  assert.equal(status.failedEntries, 4);
  assert.equal(status.failedTargets, 3);
  assert.equal(status.retryingFailedTargets, 1);
  assert.equal(status.repairedFailedTargets, 1);
  assert.equal(status.unretriedFailedTargets, 1);
  assert.equal(status.projects.proj.failedEntries, 4);
  assert.equal(status.projects.proj.failedTargets, 3);
  assert.equal(status.projects.proj.retryingFailedTargets, 1);
  assert.equal(status.projects.proj.repairedFailedTargets, 1);
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
  await claimEligible(hubRoot, { workerId: "w-active" });
  await enqueue(hubRoot, { projectId: "proj-a", description: "same project pending" });
  await enqueue(hubRoot, { projectId: "proj-b", description: "other project pending" });

  const sameProject = await claimEligible(hubRoot, {
    workerId: "w-same",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 99,
    projectId: "proj-a",
  });
  assert.equal(sameProject.entry, null);
  assert.equal(sameProject.reason, "all-projects-busy");
  assert.deepEqual(sameProject.skippedBusy, ["proj-a"]);

  const otherProject = await claimEligible(hubRoot, {
    workerId: "w-global",
    maxActivePerProject: 1,
    [removedHubTotalOption]: 1,
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
  });
  assert.equal(issueGate.entry.id, linked.id);
  assert.equal((await listQueue(hubRoot)).find((entry) => entry.id === unlinked.id).status, "pending");

  const indexHubRoot = await tempRoot("cpb-queue-index");
  const staleIndex = await enqueue(indexHubRoot, { projectId: "indexed", description: "needs index" });
  const indexGate = await claimEligible(indexHubRoot, {
    workerId: "w-index",
    getProjectFn: async (_hubRoot, projectId) => (
      projectId === "indexed"
        ? { id: projectId, sourcePath: null, projectRuntimeRoot: null }
        : null
    ),
  });
  assert.equal(indexGate.entry, null);

  const gated = (await listQueue(indexHubRoot)).find((entry) => entry.id === staleIndex.id);
  assert.equal(gated.status, "index_unavailable");
  assert.equal(gated.metadata.indexFreshness.available, false);
  assert.deepEqual(gated.metadata.indexFreshness.dirtyReasons, ["missing_source_or_runtime_root"]);
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
