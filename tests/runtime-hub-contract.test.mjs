import assert from "node:assert/strict";
import { access, constants } from "node:fs/promises";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireLease, readLease, renewLease, releaseLease,
  appendEvent, readEvents, repairEventFile,
  getJob, listJobs,
  hubQueueEnqueue, hubQueueDequeue, hubQueueList, hubQueueUpdate, hubQueueStatus,
  queuePush, queueList, queueClaim, queueComplete,
  pushBacklogIssue, listBacklog,
  setRateLimit, getRateLimit,
  upsertRegistryProject, listRegistryProjects,
  resolveRuntimeBin, getRuntimeBackend,
} from "../server/services/runtime-cli.js";

async function detectRuntimeBinary() {
  const bin = resolveRuntimeBin(".");
  try {
    await access(bin, constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

const detectedBinary = await detectRuntimeBinary();
if (detectedBinary && !process.env.CPB_RUNTIME_BIN) {
  process.env.CPB_RUNTIME_BIN = detectedBinary;
}
const hasRuntimeBinary = Boolean(detectedBinary);

const skip = { skip: !hasRuntimeBinary };

// ─── Hub Queue Lifecycle ─────────────────────────────────────────────

test("hub-queue: enqueue returns full entry shape with all required fields", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-q-shape-"));
  const entry = await hubQueueEnqueue(hubRoot, {
    projectId: "shape-test",
    sourcePath: "/repos/test",
    priority: "P1",
    description: "add contract tests",
  });

  assert.ok(entry.id && entry.id.startsWith("q-"), `id should start with "q-", got: ${entry.id}`);
  assert.equal(entry.projectId, "shape-test");
  assert.equal(entry.sourcePath, "/repos/test");
  assert.equal(entry.status, "pending");
  assert.equal(entry.priority, "P1");
  assert.equal(entry.description, "add contract tests");
  assert.equal(entry.claimedBy, null);
  assert.equal(entry.claimedAt, null);
  assert.ok(entry.createdAt);
  assert.ok(entry.updatedAt);
});

test("hub-queue: enqueue → dequeue → update → status full lifecycle", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-q-lifecycle-"));

  await hubQueueEnqueue(hubRoot, { projectId: "p-a", priority: "P2", description: "low pri" });
  await hubQueueEnqueue(hubRoot, { projectId: "p-b", priority: "P0", description: "high pri" });

  const status1 = await hubQueueStatus(hubRoot);
  assert.equal(status1.total, 2);
  assert.equal(status1.pending, 2);
  assert.equal(status1.inProgress, 0);

  const claimed = await hubQueueDequeue(hubRoot);
  assert.equal(claimed.projectId, "p-b");
  assert.equal(claimed.status, "in_progress");
  assert.ok(claimed.claimedAt);

  const status2 = await hubQueueStatus(hubRoot);
  assert.equal(status2.pending, 1);
  assert.equal(status2.inProgress, 1);

  const updated = await hubQueueUpdate(hubRoot, claimed.id, {
    status: "completed",
    workerId: "worker-001",
  });
  assert.equal(updated.status, "completed");
  assert.equal(updated.workerId, "worker-001");

  const status3 = await hubQueueStatus(hubRoot);
  assert.equal(status3.completed, 1);
  assert.equal(status3.pending, 1);
});

test("hub-queue: list filters by status and projectId", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-q-list-"));
  await hubQueueEnqueue(hubRoot, { projectId: "alpha", description: "a1" });
  await hubQueueEnqueue(hubRoot, { projectId: "beta", description: "b1" });

  const alpha = await hubQueueList(hubRoot, { projectId: "alpha" });
  assert.equal(alpha.length, 1);
  assert.equal(alpha[0].projectId, "alpha");

  const pending = await hubQueueList(hubRoot, { status: "pending" });
  assert.equal(pending.length, 2);
});

test("hub-queue: dequeue returns null when no pending items", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-q-empty-"));
  const result = await hubQueueDequeue(hubRoot);
  assert.equal(result, null);
});

test("hub-queue: update returns null for unknown entry id", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-hub-q-unknown-"));
  const result = await hubQueueUpdate(hubRoot, "nonexistent", { status: "failed" });
  assert.equal(result, null);
});

// ─── Event Append / Read / Repair ────────────────────────────────────

test("events: append and read round-trip preserves all fields", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-evt-roundtrip-"));
  const event = { type: "job_created", jobId: "j-rt-1", project: "demo", task: "roundtrip test" };

  await appendEvent(cpbRoot, "demo", "j-rt-1", event);
  const events = await readEvents(cpbRoot, "demo", "j-rt-1");

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "job_created");
  assert.equal(events[0].jobId, "j-rt-1");
  assert.equal(events[0].task, "roundtrip test");
});

test("events: append multiple and read preserves order", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-evt-order-"));
  await appendEvent(cpbRoot, "demo", "j-ord", { type: "job_created", jobId: "j-ord", ts: "T0" });
  await appendEvent(cpbRoot, "demo", "j-ord", { type: "phase_started", jobId: "j-ord", phase: "plan", ts: "T1" });
  await appendEvent(cpbRoot, "demo", "j-ord", { type: "phase_completed", jobId: "j-ord", phase: "plan", ts: "T2" });

  const events = await readEvents(cpbRoot, "demo", "j-ord");
  assert.equal(events.length, 3);
  assert.equal(events[0].type, "job_created");
  assert.equal(events[1].type, "phase_started");
  assert.equal(events[2].type, "phase_completed");
});

test("events: repair truncates corrupt trailing JSONL", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-evt-repair-"));
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", "demo");
  await mkdir(eventsDir, { recursive: true });
  const file = path.join(eventsDir, "j-repair.jsonl");

  const valid = JSON.stringify({ type: "job_created", jobId: "j-repair", project: "demo" });
  await writeFile(file, `${valid}\n{"broken":`);

  const result = await repairEventFile(cpbRoot, "demo", "j-repair");
  assert.equal(result.repaired, true);
  assert.ok(result.removedBytes > 0);

  const events = await readEvents(cpbRoot, "demo", "j-repair");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "job_created");
});

test("events: read returns empty array for missing job", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-evt-missing-"));
  const events = await readEvents(cpbRoot, "demo", "no-such-job");
  assert.deepEqual(events, []);
});

// ─── Per-Project Queue Lifecycle ─────────────────────────────────────

test("queue: push → claim → complete lifecycle", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-queue-lifecycle-"));

  const pushed = await queuePush(cpbRoot, "my-proj", { id: "q-1", task: "do work" });
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.id, "q-1");

  const claimed = await queueClaim(cpbRoot, "my-proj", { worker: "worker-x" });
  assert.equal(claimed.id, "q-1");
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claimedBy, "worker-x");

  const completed = await queueComplete(cpbRoot, "my-proj", "q-1");
  assert.equal(completed.completed, true);

  const items = await queueList(cpbRoot, "my-proj", { status: "completed" });
  assert.equal(items.length, 1);
  assert.ok(items[0].completedAt);
});

test("queue: push rejects duplicate id", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-queue-dup-"));
  await queuePush(cpbRoot, "dup-proj", { id: "q-dup", task: "first" });
  const dup = await queuePush(cpbRoot, "dup-proj", { id: "q-dup", task: "second" });
  assert.equal(dup.pushed, false);
});

test("queue: complete rejects unclaimed item", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-queue-unclaimed-"));
  await queuePush(cpbRoot, "uc-proj", { id: "q-uc", task: "skip claim" });
  const result = await queueComplete(cpbRoot, "uc-proj", "q-uc");
  assert.equal(result.completed, false);
});

test("queue: claim returns null when empty", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-queue-empty-"));
  const result = await queueClaim(cpbRoot, "empty-proj");
  assert.equal(result, null);
});

// ─── Backlog CRUD ────────────────────────────────────────────────────

test("backlog: push adds issue, deduplicates by description", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-backlog-dedup-"));
  const first = await pushBacklogIssue(cpbRoot, "bl-proj", {
    priority: "P1",
    description: "fix parsing edge case",
  });
  assert.equal(first.added, true);
  assert.equal(first.total, 1);

  const dup = await pushBacklogIssue(cpbRoot, "bl-proj", {
    priority: "P2",
    description: "fix parsing edge case",
  });
  assert.equal(dup.added, false);
  assert.equal(dup.total, 1);

  const second = await pushBacklogIssue(cpbRoot, "bl-proj", {
    priority: "P1",
    description: "add logging",
  });
  assert.equal(second.added, true);
  assert.equal(second.total, 2);

  const items = await listBacklog(cpbRoot, "bl-proj");
  assert.equal(items.length, 2);
  assert.equal(items[0].status, "pending");
  assert.equal(items[1].status, "pending");
});

test("backlog: list returns empty array for unknown project", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-backlog-empty-"));
  const items = await listBacklog(cpbRoot, "no-such-proj");
  assert.deepEqual(items, []);
});

// ─── Rate-Limit State ────────────────────────────────────────────────

test("rate-limit: set and get round-trip preserves fields", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rl-roundtrip-"));
  const set = await setRateLimit(hubRoot, {
    agent: "codex",
    untilTs: "2026-06-01T00:00:00.000Z",
    reason: "429 cooldown",
  });
  assert.equal(set.agent, "codex");
  assert.equal(set.untilTs, "2026-06-01T00:00:00.000Z");
  assert.equal(set.reason, "429 cooldown");

  const get = await getRateLimit(hubRoot, "codex");
  assert.equal(get.agent, "codex");
  assert.equal(get.reason, "429 cooldown");
});

test("rate-limit: get returns null for unknown agent", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rl-unknown-"));
  const result = await getRateLimit(hubRoot, "no-such-agent");
  assert.equal(result, null);
});

test("rate-limit: get without agent returns all limits", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-rl-all-"));
  await setRateLimit(hubRoot, { agent: "codex", untilTs: "2026-06-01T00:00:00.000Z", reason: "r1" });
  await setRateLimit(hubRoot, { agent: "claude", untilTs: "2026-06-02T00:00:00.000Z", reason: "r2" });

  const all = await getRateLimit(hubRoot);
  assert.ok(all.codex);
  assert.ok(all.claude);
});

// ─── Registry ────────────────────────────────────────────────────────

test("registry: upsert and list round-trip", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-reg-roundtrip-"));
  const project = {
    id: "reg-test",
    name: "Registry Test",
    sourcePath: "/repos/reg-test",
  };

  const saved = await upsertRegistryProject(hubRoot, project);
  assert.equal(saved.id, "reg-test");
  assert.equal(saved.sourcePath, "/repos/reg-test");
  assert.ok(saved.createdAt);
  assert.ok(saved.updatedAt);

  const projects = await listRegistryProjects(hubRoot);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].id, "reg-test");
});

test("registry: upsert updates existing project", skip, async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-reg-update-"));
  await upsertRegistryProject(hubRoot, {
    id: "upd-test",
    name: "Before",
    sourcePath: "/repos/upd",
  });
  const updated = await upsertRegistryProject(hubRoot, {
    id: "upd-test",
    name: "After",
    sourcePath: "/repos/upd-v2",
  });
  assert.equal(updated.name, "After");
  assert.equal(updated.sourcePath, "/repos/upd-v2");

  const projects = await listRegistryProjects(hubRoot);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "After");
});

// ─── Lease Renew & Release ───────────────────────────────────────────

test("lease: acquire → renew → release lifecycle", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-lease-lifecycle-"));
  const acquired = await acquireLease(cpbRoot, {
    leaseId: "lease-lc-1",
    jobId: "job-lc",
    phase: "plan",
    ttlMs: 60_000,
    ownerPid: 500,
  });
  assert.equal(acquired.acquired, true);
  const ownerToken = acquired.lease.ownerToken;

  const renewed = await renewLease(cpbRoot, "lease-lc-1", {
    ttlMs: 120_000,
    ownerToken,
  });
  assert.equal(renewed.leaseId, "lease-lc-1");
  assert.ok(renewed.heartbeatAt);

  const released = await releaseLease(cpbRoot, "lease-lc-1", { ownerToken });
  assert.equal(released.released, true);

  const after = await readLease(cpbRoot, "lease-lc-1");
  assert.equal(after, null);
});

test("lease: renew rejects wrong owner token", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-lease-bad-token-"));
  const acquired = await acquireLease(cpbRoot, {
    leaseId: "lease-bad-1",
    jobId: "job-bad",
    phase: "plan",
    ttlMs: 60_000,
    ownerPid: 600,
  });
  assert.equal(acquired.acquired, true);

  await assert.rejects(
    () => renewLease(cpbRoot, "lease-bad-1", { ttlMs: 60_000, ownerToken: "wrong-token" }),
    { message: /owner mismatch/ },
  );
});

// ─── Job Materialization (getJob / listJobs) ─────────────────────────

test("job: getJob materializes events into correct state", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-materialize-"));
  await appendEvent(cpbRoot, "demo", "j-mat-1", { type: "job_created", jobId: "j-mat-1", project: "demo", task: "materialize test", ts: "T0" });
  await appendEvent(cpbRoot, "demo", "j-mat-1", { type: "phase_started", jobId: "j-mat-1", phase: "plan", leaseId: "l-1", ts: "T1" });
  await appendEvent(cpbRoot, "demo", "j-mat-1", { type: "phase_completed", jobId: "j-mat-1", phase: "plan", ts: "T2" });
  await appendEvent(cpbRoot, "demo", "j-mat-1", { type: "job_completed", jobId: "j-mat-1", ts: "T3" });

  const job = await getJob(cpbRoot, "demo", "j-mat-1");
  assert.equal(job.jobId, "j-mat-1");
  assert.equal(job.project, "demo");
  assert.equal(job.task, "materialize test");
  assert.equal(job.status, "completed");
  assert.equal(job.phase, "completed");
  assert.equal(job.leaseId, null);
  assert.equal(job.createdAt, "T0");
});

test("job: listJobs returns materialized jobs across projects", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-list-"));
  await appendEvent(cpbRoot, "proj-a", "j-la", { type: "job_created", jobId: "j-la", project: "proj-a", task: "task a", ts: "T0" });
  await appendEvent(cpbRoot, "proj-b", "j-lb", { type: "job_created", jobId: "j-lb", project: "proj-b", task: "task b", ts: "T1" });
  await appendEvent(cpbRoot, "proj-a", "j-la", { type: "job_completed", jobId: "j-la", ts: "T2" });

  const all = await listJobs(cpbRoot);
  assert.equal(all.length, 2);

  const filtered = await listJobs(cpbRoot, { project: "proj-a" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].jobId, "j-la");
  assert.equal(filtered[0].status, "completed");
});

test("job: getJob returns null state for missing job", skip, async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-missing-"));
  const job = await getJob(cpbRoot, "demo", "no-such-job");
  assert.equal(job.jobId, null);
  assert.equal(job.status, null);
});
