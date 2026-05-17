#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendEvent,
  readEvents,
  materializeJob,
  eventFileFor,
  repairEventFile,
} from "../server/services/event-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-event-store-"));
const project = "demo";
const jobId = "job-20260513-000001";

const createdEvent = {
  type: "job_created",
  jobId,
  project,
  task: "Add login",
  ts: "2026-05-13T00:00:00.000Z",
};
const appendResult = await appendEvent(root, project, jobId, createdEvent);
assert.deepEqual(appendResult, createdEvent);
await appendEvent(root, project, jobId, {
  type: "phase_started",
  jobId,
  phase: "plan",
  leaseId: "lease-job-20260513-000001-plan",
  ts: "2026-05-13T00:01:00.000Z",
});
await appendEvent(root, project, jobId, {
  type: "phase_completed",
  jobId,
  phase: "plan",
  artifact: "wiki/projects/demo/inbox/plan-001.md",
  ts: "2026-05-13T00:02:00.000Z",
});

const file = eventFileFor(root, project, jobId);
const raw = await readFile(file, "utf8");
assert.equal(raw.trim().split("\n").length, 3);

const events = await readEvents(root, project, jobId);
assert.equal(events.length, 3);
assert.equal(events[0].type, "job_created");

const startedState = materializeJob(events.slice(0, 2));
assert.equal(startedState.phase, "plan");
assert.equal(startedState.leaseId, "lease-job-20260513-000001-plan");

const state = materializeJob(events);
assert.equal(state.jobId, jobId);
assert.equal(state.project, project);
assert.equal(state.task, "Add login");
assert.equal(state.status, "running");
assert.equal(state.phase, "plan");
assert.equal(state.leaseId, null);
assert.equal(state.artifacts.plan, "wiki/projects/demo/inbox/plan-001.md");
assert.equal(state.updatedAt, "2026-05-13T00:02:00.000Z");

const nextPhaseState = materializeJob([
  ...events,
  {
    type: "phase_started",
    jobId,
    phase: "execute",
    leaseId: "lease-job-20260513-000001-execute",
    ts: "2026-05-13T00:03:00.000Z",
  },
]);
assert.equal(nextPhaseState.phase, "execute");
assert.equal(nextPhaseState.leaseId, "lease-job-20260513-000001-execute");

const failedPhaseState = materializeJob([
  ...events,
  {
    type: "phase_started",
    jobId,
    phase: "execute",
    leaseId: "lease-job-20260513-000001-execute",
    ts: "2026-05-13T00:03:00.000Z",
  },
  {
    type: "phase_failed",
    jobId,
    phase: "execute",
    error: "child exited with 7",
    ts: "2026-05-13T00:04:00.000Z",
  },
]);
assert.equal(failedPhaseState.status, "failed");
assert.equal(failedPhaseState.phase, "execute");
assert.equal(failedPhaseState.leaseId, null);
assert.equal(failedPhaseState.blockedReason, "child exited with 7");

const budgetBlocked = materializeJob([
  ...events,
  {
    type: "budget_exceeded",
    jobId,
    reason: "max attempts reached",
    ts: "2026-05-13T00:05:00.000Z",
  },
]);
assert.equal(budgetBlocked.status, "blocked");
assert.equal(budgetBlocked.leaseId, null);
assert.equal(budgetBlocked.blockedReason, "max attempts reached");

assert.throws(() => eventFileFor(root, "../../escape", jobId), /invalid project/i);
assert.throws(() => eventFileFor(root, project, "../../escape"), /invalid jobId/i);
assert.throws(() => eventFileFor(root, "..demo", jobId), /invalid project/i);
assert.throws(() => eventFileFor(root, project, ".job"), /invalid jobId/i);

const completed = materializeJob([
  ...events,
  {
    type: "job_completed",
    jobId,
    ts: "2026-05-13T00:03:00.000Z",
  },
]);
assert.equal(completed.status, "completed");
assert.equal(completed.phase, "completed");

const invalidEventRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-invalid-"));
await assert.rejects(
  () => appendEvent(invalidEventRoot, project, jobId, undefined),
  /invalid event/i
);
await assert.rejects(() => stat(eventFileFor(invalidEventRoot, project, jobId)), {
  code: "ENOENT",
});

// --- Crash repair tests ---

const trailingPartialRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-partial-"));
const trailingPartialFile = eventFileFor(trailingPartialRoot, project, jobId);
await mkdir(path.dirname(trailingPartialFile), { recursive: true });
await writeFile(
  trailingPartialFile,
  `${JSON.stringify(createdEvent)}\n{"type": "phase_started"`,
  "utf8"
);
const recoveredEvents = await readEvents(trailingPartialRoot, project, jobId);
assert.equal(recoveredEvents.length, 1);
assert.equal(recoveredEvents[0].type, "job_created");
const repairedPartialRaw = await readFile(trailingPartialFile, "utf8");
assert.equal(repairedPartialRaw, `${JSON.stringify(createdEvent)}\n`);

// After readEvents auto-repair, the corrupt tail is removed from the file
const repairedRaw = await readFile(trailingPartialFile, "utf8");
assert.equal(repairedRaw.trim().split("\n").length, 1);
assert.ok(repairedRaw.endsWith("\n"), "file should end with newline after repair");

// Subsequent append should work cleanly after auto-repair
const appended = await appendEvent(trailingPartialRoot, project, jobId, {
  type: "phase_started",
  jobId,
  phase: "plan",
  ts: "2026-05-13T00:01:00.000Z",
});
assert.equal(appended.type, "phase_started");
const afterAppend = await readFile(trailingPartialFile, "utf8");
assert.equal(afterAppend.trim().split("\n").length, 2);

const malformedFinalNewlineRoot = await mkdtemp(
  path.join(tmpdir(), "cpb-event-store-malformed-final-")
);
const malformedFinalNewlineFile = eventFileFor(malformedFinalNewlineRoot, project, jobId);
await mkdir(path.dirname(malformedFinalNewlineFile), { recursive: true });
await writeFile(
  malformedFinalNewlineFile,
  `${JSON.stringify(createdEvent)}\n{"type": "phase_started"\n`,
  "utf8"
);
await assert.rejects(
  () => readEvents(malformedFinalNewlineRoot, project, jobId),
  new RegExp(`${malformedFinalNewlineFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*line 2`)
);

const nonObjectEventRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-non-object-"));
const nonObjectEventFile = eventFileFor(nonObjectEventRoot, project, jobId);
await mkdir(path.dirname(nonObjectEventFile), { recursive: true });
await writeFile(nonObjectEventFile, `${JSON.stringify(createdEvent)}\nnull\n`, "utf8");
await assert.rejects(
  () => readEvents(nonObjectEventRoot, project, jobId),
  new RegExp(`${nonObjectEventFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*line 2.*malformed event`)
);

const arrayEventRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-array-"));
const arrayEventFile = eventFileFor(arrayEventRoot, project, jobId);
await mkdir(path.dirname(arrayEventFile), { recursive: true });
await writeFile(arrayEventFile, `${JSON.stringify(createdEvent)}\n[]\n`, "utf8");
await assert.rejects(
  () => readEvents(arrayEventRoot, project, jobId),
  new RegExp(`${arrayEventFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*line 2.*malformed event`)
);

const malformedMiddleRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-malformed-"));
const malformedMiddleFile = eventFileFor(malformedMiddleRoot, project, jobId);
await mkdir(path.dirname(malformedMiddleFile), { recursive: true });
await writeFile(
  malformedMiddleFile,
  `${JSON.stringify(createdEvent)}\n{"type": "phase_started"\n${JSON.stringify({
    type: "job_completed",
    jobId,
    ts: "2026-05-13T00:03:00.000Z",
  })}\n`,
  "utf8"
);
await assert.rejects(
  () => readEvents(malformedMiddleRoot, project, jobId),
  new RegExp(`${malformedMiddleFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*line 2`)
);

// --- repairEventFile explicit tests ---

const repairCorruptRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-repair-corrupt-"));
const repairCorruptFile = eventFileFor(repairCorruptRoot, project, jobId);
await mkdir(path.dirname(repairCorruptFile), { recursive: true });
await writeFile(
  repairCorruptFile,
  `${JSON.stringify(createdEvent)}\n{"broken":`,
  "utf8"
);
const repairResult = await repairEventFile(repairCorruptRoot, project, jobId);
assert.equal(repairResult.repaired, true);
assert.ok(repairResult.removedBytes > 0);
const afterRepair = await readFile(repairCorruptFile, "utf8");
assert.equal(afterRepair, `${JSON.stringify(createdEvent)}\n`);

const repairHealthyRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-repair-healthy-"));
const repairHealthyFile = eventFileFor(repairHealthyRoot, project, jobId);
await mkdir(path.dirname(repairHealthyFile), { recursive: true });
await writeFile(
  repairHealthyFile,
  `${JSON.stringify(createdEvent)}\n`,
  "utf8"
);
const healthyResult = await repairEventFile(repairHealthyRoot, project, jobId);
assert.equal(healthyResult.repaired, false);
assert.equal(healthyResult.removedBytes, 0);

const repairMissingNewlineRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-repair-missing-nl-"));
const repairMissingNewlineFile = eventFileFor(repairMissingNewlineRoot, project, jobId);
await mkdir(path.dirname(repairMissingNewlineFile), { recursive: true });
await writeFile(
  repairMissingNewlineFile,
  JSON.stringify(createdEvent),
  "utf8"
);
const missingNlResult = await repairEventFile(repairMissingNewlineRoot, project, jobId);
assert.equal(missingNlResult.repaired, true);
assert.equal(missingNlResult.removedBytes, 0);
assert.equal(missingNlResult.addedNewline, true);
const afterMissingNl = await readFile(repairMissingNewlineFile, "utf8");
assert.ok(afterMissingNl.endsWith("\n"), "should have trailing newline after repair");
assert.equal(afterMissingNl.trim(), JSON.stringify(createdEvent));

const repairMissingRoot = await mkdtemp(path.join(tmpdir(), "cpb-event-store-repair-missing-"));
const missingResult = await repairEventFile(repairMissingRoot, "nonexist", "job-nope");
assert.equal(missingResult.repaired, false);
assert.equal(missingResult.removedBytes, 0);
