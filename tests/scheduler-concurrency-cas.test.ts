import assert from "node:assert/strict";
import { test } from "node:test";

import { Scheduler } from "../server/orchestrator/scheduler.js";
import {
  enqueue,
  listQueue,
  updateEntry,
} from "../server/services/hub/hub-queue.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { tempRoot } from "./helpers.js";

async function schedulerFor(hubRoot: string, maxActivePerProject: number) {
  const assignmentStore = new AssignmentStore(hubRoot);
  await assignmentStore.init();
  return new Scheduler(hubRoot, {
    assignmentStore,
    workerStore: { findIdleWorker: async () => null },
    maxActivePerProject,
    providerCapacityFn: async () => ({ available: 20, total: 20 }),
  });
}

test("provider capacity cannot bypass an occupied per-project slot", async () => {
  const hubRoot = await tempRoot("cpb-scheduler-project-cap");
  const active = await enqueue(hubRoot, {
    projectId: "project-a",
    description: "active mutation",
  });
  await updateEntry(hubRoot, active.id, {
    status: "in_progress",
    claimedBy: "worker-a",
    claimedAt: new Date().toISOString(),
  });
  await enqueue(hubRoot, {
    projectId: "project-a",
    description: "must remain queued",
  });
  const other = await enqueue(hubRoot, {
    projectId: "project-b",
    description: "has capacity",
  });

  const scheduler = await schedulerFor(hubRoot, 1);
  const candidates = await scheduler.nextCandidates(10);

  assert.deepEqual(candidates.map((entry) => entry.id), [other.id]);
});

test("a scheduler batch reserves each per-project slot only once", async () => {
  const hubRoot = await tempRoot("cpb-scheduler-project-reservation");
  const first = await enqueue(hubRoot, {
    projectId: "project-a",
    description: "first mutation",
    priority: "P0",
  });
  await enqueue(hubRoot, {
    projectId: "project-a",
    description: "second mutation",
    priority: "P1",
  });

  const scheduler = await schedulerFor(hubRoot, 1);
  const candidates = await scheduler.nextCandidates(10);

  assert.deepEqual(candidates.map((entry) => entry.id), [first.id]);
});

test("guarded queue updates reject a stale scheduler snapshot", async () => {
  const hubRoot = await tempRoot("cpb-queue-cas");
  const entry = await enqueue(hubRoot, {
    projectId: "project-a",
    description: "stale recovery candidate",
  });
  const oldClaimedAt = new Date(Date.now() - 300_000).toISOString();
  await updateEntry(hubRoot, entry.id, {
    status: "in_progress",
    claimedBy: "old-worker",
    claimedAt: oldClaimedAt,
  });
  const staleSnapshot = (await listQueue(hubRoot)).find((item) => item.id === entry.id);
  assert.ok(staleSnapshot);

  const currentClaimedAt = new Date().toISOString();
  await updateEntry(hubRoot, entry.id, {
    status: "in_progress",
    claimedBy: "current-worker",
    claimedAt: currentClaimedAt,
  });

  const updated = await updateEntry(
    hubRoot,
    entry.id,
    { status: "pending", claimedBy: null, claimedAt: null },
    {
      expectedStatus: staleSnapshot.status,
      expectedClaimedAt: staleSnapshot.claimedAt ?? null,
      expectedUpdatedAt: staleSnapshot.updatedAt ?? null,
    },
  );

  assert.equal(updated, null);
  const current = (await listQueue(hubRoot)).find((item) => item.id === entry.id);
  assert.equal(current?.status, "in_progress");
  assert.equal(current?.claimedBy, "current-worker");
  assert.equal(current?.claimedAt, currentClaimedAt);
});

test("project readiness cannot overwrite an entry claimed during its async check", async () => {
  const hubRoot = await tempRoot("cpb-scheduler-readiness-cas");
  const entry = await enqueue(hubRoot, {
    projectId: "project-a",
    description: "claimed while readiness is checking",
  });
  const assignmentStore = new AssignmentStore(hubRoot);
  await assignmentStore.init();
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore,
    workerStore: { findIdleWorker: async () => null },
    getProjectFn: async () => {
      await updateEntry(hubRoot, entry.id, {
        status: "in_progress",
        claimedBy: "worker-a",
        claimedAt: new Date().toISOString(),
      });
      return null;
    },
  });

  const candidates = await scheduler.nextCandidates(10);
  const current = (await listQueue(hubRoot)).find((item) => item.id === entry.id);

  assert.deepEqual(candidates, []);
  assert.equal(current?.status, "in_progress");
  assert.equal(current?.claimedBy, "worker-a");
});
