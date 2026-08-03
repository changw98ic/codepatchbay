import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { handleWorkerStateBroker } from "../server/services/hub/worker-state-broker.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import type { LooseRecord } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

test("worker broker activation preserves an orchestrator assignment reservation", async () => {
  const hubRoot = await tempRoot("cpb-worker-broker-reservation");
  const cpbRoot = await tempRoot("cpb-worker-broker-reservation-cpb");
  const workerId = "w-broker-reservation";
  const incarnationToken = "broker-reservation-incarnation";
  const brokerToken = "b".repeat(43);
  const store = new WorkerStore(hubRoot);
  await store.init();
  await store.registerWorker(workerId, {
    status: "assigned",
    currentAssignmentId: "a-broker-reservation",
    currentAttemptToken: "attempt-broker-reservation",
    incarnationToken,
    brokerTokenHash: createHash("sha256").update(brokerToken, "utf8").digest("hex"),
  });

  const activated = await handleWorkerStateBroker({
    cpbRoot,
    hubRoot,
    headers: { authorization: `Bearer ${brokerToken}` },
    body: {
      workerId,
      incarnationToken,
      op: "worker.register",
      args: {
        meta: {
          pid: 4242,
          host: "worker.example.test",
          status: "ready",
          startedAt: "2026-08-03T00:00:00.000Z",
          lastHeartbeatAt: "2026-08-03T00:00:01.000Z",
        },
      },
    } as unknown as LooseRecord,
  });

  assert.ok(activated && typeof activated === "object" && !Array.isArray(activated));
  const record = activated as LooseRecord;
  assert.equal(record.status, "assigned");
  assert.equal(record.currentAssignmentId, "a-broker-reservation");
  assert.equal(record.currentAttemptToken, "attempt-broker-reservation");
  assert.equal(record.pid, 4242);
  assert.equal(record.incarnationToken, incarnationToken);
});
