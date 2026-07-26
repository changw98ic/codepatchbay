import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildServices } from "../server/services/engine-runner.js";
import { readEvents } from "../server/services/event/event-store.js";
import { getJob } from "../server/services/job/job-store.js";
import { WorkerBrokerClient } from "../shared/orchestrator/worker-broker-client.js";
import { tempRoot } from "./helpers.js";

function recordingWorkerBrokerClient() {
  const calls: Array<{ op: string; args: unknown }> = [];
  const client = new WorkerBrokerClient({
      url: "http://127.0.0.1:17999",
      token: "a".repeat(43),
      workerId: "worker-1",
      incarnationToken: "incarnation-1",
    }, {
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { op: string; args: Record<string, unknown> };
        calls.push({ op: request.op, args: request.args });
        const jobId = String(request.args.jobId || "job-broker-created");
        const result = request.op === "artifact.index"
          ? { schemaVersion: 2, entries: [] }
          : request.op === "event.append"
            ? null
            : { op: request.op, args: request.args, jobId };
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
  return { client, calls };
}

test("buildServices writes job state through the explicit project runtime root", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-job-root");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const services = buildServices(cpbRoot, { dataRoot });

  const created = await services.createJob(cpbRoot, {
    project: "flow",
    task: "lock runJob service composition",
    workflow: "standard",
    ts: "2026-07-20T01:00:00.000Z",
  });

  assert.equal((await getJob(cpbRoot, "flow", created.jobId, { dataRoot })).task, "lock runJob service composition");
  await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
});

test("buildServices appends events through the explicit project runtime root without legacy fallback", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-event-root");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const services = buildServices(cpbRoot, { dataRoot });
  const jobId = "job-20260720-010500-service";

  await services.appendEvent(cpbRoot, "flow", jobId, {
    type: "job_created",
    jobId,
    project: "flow",
    task: "append via service port",
    workflow: "standard",
    ts: "2026-07-20T01:05:00.000Z",
  });

  const raw = await readFile(path.join(dataRoot, "events", "flow", `${jobId}.jsonl`), "utf8");
  assert.equal(JSON.parse(raw.trim()).task, "append via service port");
  assert.deepEqual(await readEvents(cpbRoot, "flow", jobId, { dataRoot, includeLegacyFallback: false }), [
    {
      type: "job_created",
      jobId,
      project: "flow",
      task: "append via service port",
      workflow: "standard",
      ts: "2026-07-20T01:05:00.000Z",
      traceId: jobId,
      spanId: `job:${jobId}`,
      parentSpanId: null,
    },
  ]);
  await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
});

test("buildServices reads artifact index through the explicit project runtime root", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-artifact-root");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const services = buildServices(cpbRoot, { dataRoot });
  const jobId = "job-20260720-013000-service";

  await services.appendEvent(cpbRoot, "flow", jobId, {
    type: "phase_completed",
    jobId,
    project: "flow",
    phase: "execute",
    artifact: "deliverable-missing.md",
    ts: "2026-07-20T01:30:00.000Z",
  });

  const index = await services.getArtifactIndex(cpbRoot, "flow", jobId);

  assert.equal(index.project, "flow");
  assert.equal(index.jobId, jobId);
  assert.equal(index.entries.length, 1);
  assert.equal(path.basename(index.entries[0].path), "deliverable-missing.md");
  assert.equal(index.entries[0].phase, "execute");
  assert.equal(index.entries[0].broken, true);
  await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
});

test("buildServices rejects invalid event job ids before writing through the service port", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-invalid-event");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const services = buildServices(cpbRoot, { dataRoot });

  assert.throws(
    () => services.appendEvent(cpbRoot, "flow", "../escape", {
      type: "job_created",
      jobId: "../escape",
      project: "flow",
      task: "invalid id",
      workflow: "standard",
      ts: "2026-07-20T01:10:00.000Z",
    }),
    /invalid jobId for appendEvent/,
  );
  await assert.rejects(() => stat(path.join(dataRoot, "events")), { code: "ENOENT" });
});

test("buildServices delegates job creation to the worker broker with normalized input", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-broker-create");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const { client: broker, calls } = recordingWorkerBrokerClient();
  const services = buildServices(cpbRoot, { dataRoot, workerBrokerClient: broker });

  const result = await services.createJob(cpbRoot, {
    project: "flow",
    task: "broker owned job state",
    ts: "2026-07-20T01:15:00.000Z",
  });

  assert.equal(result.op, "job.create");
  assert.deepEqual(calls, [
    {
      op: "job.create",
      args: {
        project: "flow",
        input: {
          project: "flow",
          task: "broker owned job state",
          ts: "2026-07-20T01:15:00.000Z",
          dataRoot,
          executor: null,
        },
      },
    },
  ]);
  await assert.rejects(() => stat(path.join(dataRoot, "jobs")), { code: "ENOENT" });
});

test("buildServices delegates phase, event, and artifact ports to the worker broker", async () => {
  const cpbRoot = await tempRoot("cpb-engine-services-broker-ports");
  const dataRoot = path.join(cpbRoot, "hub", "projects", "flow", "jobs");
  const { client: broker, calls } = recordingWorkerBrokerClient();
  const services = buildServices(cpbRoot, { dataRoot, workerBrokerClient: broker });
  const jobId = "job-20260720-012000-service";

  await services.startPhase(cpbRoot, "flow", jobId, { phase: "plan", attempt: 1 });
  await services.completePhase(cpbRoot, "flow", jobId, { phase: "plan", artifact: "plan-001.md" });
  await services.failJob(cpbRoot, "flow", jobId, { reason: "verification failed" });
  await services.blockJob(cpbRoot, "flow", jobId, { reason: "approval required" });
  await services.appendEvent(cpbRoot, "flow", jobId, { type: "custom", jobId, project: "flow" });
  await services.getArtifactIndex(cpbRoot, "flow", jobId);

  assert.deepEqual(calls.map((call) => call.op), [
    "job.startPhase",
    "job.completePhase",
    "job.fail",
    "job.block",
    "event.append",
    "artifact.index",
  ]);
  await assert.rejects(() => stat(path.join(dataRoot, "events")), { code: "ENOENT" });
});
