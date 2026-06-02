import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AssignmentStore } from "../server/orchestrator/assignment-store.js";
import { LeaderLock } from "../server/orchestrator/leader-lock.js";
import { Reconciler } from "../server/orchestrator/reconciler.js";
import { WorkerStore } from "../server/orchestrator/worker-store.js";

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function withHubRoot(prefix, fn) {
  const hubRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(hubRoot);
  } finally {
    await rm(hubRoot, { recursive: true, force: true });
  }
}

describe("orchestrator lifecycle fencing", () => {
  it("does not revive terminal or unhealthy workers during worker finalization", async () => {
    await withHubRoot("cpb-orch-lifecycle-worker-", async (hubRoot) => {
      const assignmentStore = new AssignmentStore(hubRoot);
      const workerStore = new WorkerStore(hubRoot);
      const leaderLock = new LeaderLock(hubRoot);
      await assignmentStore.init();
      await workerStore.init();
      await leaderLock.acquire();

      const reconciler = new Reconciler(hubRoot, {
        assignmentStore,
        workerStore,
        leaderLock,
        failureRouter: {},
      });

      for (const status of ["dead", "exited", "unhealthy"]) {
        const workerId = `w-${status}`;
        const entryId = `q-${status}`;
        const assignment = await assignmentStore.getOrCreateAssignmentForEntry({
          entryId,
          projectId: "alpha",
          task: `task ${status}`,
        });
        const attempt = await assignmentStore.createAttempt(assignment.assignmentId, {
          workerId,
          orchestratorEpoch: leaderLock.getEpoch(),
        });
        await workerStore.registerWorker(workerId, {
          status,
          currentAssignmentId: assignment.assignmentId,
        });

        await reconciler._finalizeWorker(assignment, attempt);

        const worker = await workerStore.getWorker(workerId);
        assert.equal(worker.status, status);
        assert.equal(worker.currentAssignmentId, null);
      }

      await leaderLock.release();
    });
  });

  it("treats an expired own leader record as no longer held", async () => {
    await withHubRoot("cpb-orch-lifecycle-expired-", async (hubRoot) => {
      const leaderLock = new LeaderLock(hubRoot);
      const leader = await leaderLock.acquire();
      await writeJson(path.join(hubRoot, "orchestrator", "leader.lock", "leader.json"), {
        ...leader,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      });

      assert.equal(await leaderLock.stillHeld(), false);
    });
  });

  it("treats a different epoch for the same hub id as no longer held", async () => {
    await withHubRoot("cpb-orch-lifecycle-epoch-", async (hubRoot) => {
      const leaderLock = new LeaderLock(hubRoot);
      const leader = await leaderLock.acquire();
      await writeJson(path.join(hubRoot, "orchestrator", "leader.lock", "leader.json"), {
        ...leader,
        epoch: leader.epoch + 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      assert.equal(await leaderLock.stillHeld(), false);
    });
  });

  it("does not force-delete the leader lock when stale quarantine cannot prove ownership", async () => {
    await withHubRoot("cpb-orch-lifecycle-stale-", async (hubRoot) => {
      const staleHubId = "stale/hub";
      const fixedNow = 1_700_000_000_000;
      const lockDir = path.join(hubRoot, "orchestrator", "leader.lock");
      await writeJson(path.join(lockDir, "leader.json"), {
        hubId: staleHubId,
        host: os.hostname(),
        pid: process.pid,
        epoch: 7,
        startedAt: new Date(fixedNow - 120_000).toISOString(),
        heartbeatAt: new Date(fixedNow - 120_000).toISOString(),
        expiresAt: new Date(fixedNow - 60_000).toISOString(),
      });
      const originalNow = Date.now;
      Date.now = () => fixedNow;
      try {
        const leaderLock = new LeaderLock(hubRoot);
        await assert.rejects(
          () => leaderLock.acquire(),
          /leader lock stale cleanup failed/,
        );
      } finally {
        Date.now = originalNow;
      }

      const remaining = await readJson(path.join(lockDir, "leader.json"));
      assert.equal(remaining.hubId, staleHubId);
    });
  });
});
