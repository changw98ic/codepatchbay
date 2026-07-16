import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { Scheduler } from "../server/orchestrator/scheduler.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
import { FailureKind } from "../core/contracts/failure.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub/hub-queue.js";
import { tempRoot, readJson, writeJson } from "./helpers.js";
import { readSchedulerConfig, isValidSchedulerMode, readHubConfig, writeHubConfig } from "../server/services/agent/agent-config.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";

const noAssignmentStore = { getAssignment: async () => null };

async function hubWithSchedulerMode(mode) {
  const hubRoot = await tempRoot("cpb-sched");
  await writeJson(path.join(hubRoot, "config.json"), {
    scheduler: { mode },
  });
  return hubRoot;
}

// ── Config parsing ──

test("readSchedulerConfig returns default for missing scheduler config", () => {
  assert.deepEqual(readSchedulerConfig({}), { mode: "default" });
  assert.deepEqual(readSchedulerConfig({ scheduler: null }), { mode: "default" });
  assert.deepEqual(readSchedulerConfig({ scheduler: {} }), { mode: "default" });
});

test("readSchedulerConfig validates mode values", () => {
  assert.deepEqual(readSchedulerConfig({ scheduler: { mode: "default" } }), { mode: "default" });
  assert.deepEqual(readSchedulerConfig({ scheduler: { mode: "smart" } }), { mode: "smart" });
  assert.deepEqual(readSchedulerConfig({ scheduler: { mode: "invalid" } }), { mode: "default" });
});

test("isValidSchedulerMode accepts valid modes only", () => {
  assert.equal(isValidSchedulerMode("default"), true);
  assert.equal(isValidSchedulerMode("smart"), true);
  assert.equal(isValidSchedulerMode("fancy"), false);
  assert.equal(isValidSchedulerMode(""), false);
});

// ── Default scheduler mode preserves priority-then-age ordering ──

test("default mode sorts by priority then createdAt", async () => {
  const hubRoot = await hubWithSchedulerMode("default");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Enqueue P2 first, then P1 — P1 should win
  const p2 = await enqueue(hubRoot, { projectId: "proj", description: "low priority", priority: "P2" });
  // Ensure different createdAt by using a slightly later entry
  const p1 = await enqueue(hubRoot, { projectId: "proj", description: "high priority", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, p1.id);
});

// ── Smart scheduler mode ──

test("smart mode selects higher-scoring candidate with different priority and age", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // P2 old entry should still lose to P1 new entry due to priority weight
  const old = await enqueue(hubRoot, { projectId: "proj", description: "old P2", priority: "P2" });
  // Make the old entry actually old
  await updateEntry(hubRoot, old.id, {
    metadata: { ...(await listQueue(hubRoot)).find(e => e.id === old.id)?.metadata },
  });

  const recent = await enqueue(hubRoot, { projectId: "proj", description: "new P1", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate.id, recent.id);
  // Verify scheduler decision metadata
  assert.equal(candidate.metadata.schedulerDecision.mode, "smart");
  assert.ok(typeof candidate.metadata.schedulerDecision.score === "number");
  assert.ok(Array.isArray(candidate.metadata.schedulerDecision.reasons));
});

test("smart mode boosts entries with failure metadata", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const normal = await enqueue(hubRoot, { projectId: "proj", description: "normal task", priority: "P2" });
  const failed = await enqueue(hubRoot, {
    projectId: "proj",
    description: "previously failed",
    priority: "P2",
    metadata: { lastFailureKind: "verification_failed", failureCount: 1 },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  // The failed entry gets a boost for verification_failed but a penalty for failureCount(1).
  // verification_failed: +5, failureCount 1: -4 => net +1 over normal
  assert.equal(candidate.id, failed.id);
  assert.ok(candidate.metadata.schedulerDecision.reasons.includes("verification_failed-boost"));
});

test("smart mode prefers project with no active pressure", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Make proj-a have an active entry with a recent claimedAt so it won't be recovered
  const activeA = await enqueue(hubRoot, { projectId: "proj-a", description: "active on a", priority: "P2" });
  await updateEntry(hubRoot, activeA.id, {
    status: "in_progress",
    claimedBy: "w-1",
    workerId: "w-1",
    claimedAt: new Date().toISOString(),
  });

  // proj-b entry enqueued first (older = more age score), proj-a entry second
  const entryB = await enqueue(hubRoot, { projectId: "proj-b", description: "pending on idle b", priority: "P2" });
  const entryA = await enqueue(hubRoot, { projectId: "proj-a", description: "pending on busy a", priority: "P2" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    maxActivePerProject: 2,
  });

  const candidate = await scheduler.nextCandidate();
  // proj-b has zero active pressure and is older, should be preferred
  assert.equal(candidate.id, entryB.id);
  assert.ok(candidate.metadata.schedulerDecision.reasons.includes("no-active-pressure"));
});

test("smart mode attaches schedulerDecision with mode, selectedAt, score, and reasons", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  await enqueue(hubRoot, { projectId: "proj", description: "lone entry", priority: "P1" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  const decision = candidate.metadata.schedulerDecision;
  assert.equal(decision.mode, "smart");
  assert.ok(decision.selectedAt);
  assert.equal(decision.rank, 1);
  assert.ok(typeof decision.score === "number");
  assert.ok(Array.isArray(decision.reasons));
  assert.ok(decision.reasons.length > 0);
});

test("smart mode preserves ranked batch dispatch instead of serializing eligible work", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const p2 = await enqueue(hubRoot, { projectId: "proj-c", description: "p2", priority: "P2" });
  const p0 = await enqueue(hubRoot, { projectId: "proj-a", description: "p0", priority: "P0" });
  const p1 = await enqueue(hubRoot, { projectId: "proj-b", description: "p1", priority: "P1" });
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidates = await scheduler.nextCandidates(3);

  assert.deepEqual(candidates.map((entry) => entry.id), [p0.id, p1.id, p2.id]);
  assert.deepEqual(candidates.map((entry) => entry.metadata.schedulerDecision.rank), [1, 2, 3]);
});

test("smart mode records evidence-backed retry strategy and failure fingerprint", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const fingerprint = "sha256:stable-failure";
  const retried = await enqueue(hubRoot, {
    projectId: "proj",
    description: "evidence-backed retry",
    priority: "P1",
    metadata: {
      lastFailureKind: "verification_failed",
      failureCount: 1,
      sourceContext: { retry: { retryStrategy: "fresh_attempt", failureFingerprint: fingerprint } },
    },
  });
  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  const decision = candidate.metadata.schedulerDecision;

  assert.equal(candidate.id, retried.id);
  assert.equal(decision.retryStrategy, "fresh_attempt");
  assert.equal(decision.failureFingerprint, fingerprint);
  assert.ok(decision.reasons.includes("evidence-backed-fresh-attempt"));
});

// ── FailureRouter smart mode supervisor eligibility ──

test("FailureRouter consults supervisor for complex failures regardless of mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "mark_failed", reason: "supervisor says so" }; },
  };
  const router = new FailureRouter(supervisor);

  await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.AGENT_CONTRACT_INVALID, reason: "bad" } },
  });
  assert.equal(diagnosed, true);
});

test("FailureRouter skips supervisor for verification_failed in default mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "retry_same_worker" }; },
  };
  const router = new FailureRouter(supervisor);

  const result = await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.VERIFICATION_FAILED, reason: "bad output", cause: { verdict: { fix_scope: ["src/api.js"] } } } },
  });
  assert.equal(diagnosed, false);
  assert.equal(result.action, "retry_same_worker");
});

test("FailureRouter gives an exhausted in-attempt solver one explicit fresh diagnosis attempt", async () => {
  const router = new FailureRouter();
  const result = await router.route({
    assignment: { attempts: 1, sourceContext: {} },
    attempt: { attempt: 1 },
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "same focused test still fails",
        retryable: true,
        cause: {
          solver: {
            exhausted: true,
            repairAttempts: 2,
            failureFingerprint: "sha256:fingerprint-1",
          },
        },
      },
    },
  });

  assert.equal(result.action, "retry_same_worker");
  assert.equal(result.retryStrategy, "fresh_session_diagnosis");
  assert.equal(result.retryPhase, null);
  assert.match(String(result.failureFingerprint), /^sha256:/);
  assert.notEqual(result.failureFingerprint, "sha256:fingerprint-1");
  assert.equal(result.forceFreshSession, true);
});

test("FailureRouter stops unchanged verification failures across solver attempts", async () => {
  const router = new FailureRouter();
  const result = await router.route({
    assignment: {
      attempts: 2,
      sourceContext: { retry: { failureFingerprint: "sha256:fingerprint-1" } },
    },
    attempt: { attempt: 2 },
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "same focused test still fails",
        retryable: true,
        cause: {
          solver: {
            exhausted: true,
            failureFingerprint: "sha256:fingerprint-1",
          },
        },
      },
    },
  });

  assert.equal(result.action, "mark_failed");
  assert.match(result.reason, /repeated unchanged/i);
  assert.match(result.reason, /blind retry denied/i);
});

test("FailureRouter advances repeated implementation failures once, then stops instead of cycling", async () => {
  const router = new FailureRouter();
  const failure = {
    kind: FailureKind.VERIFICATION_FAILED,
    reason: "focused parser behavior still fails",
    retryable: true,
    cause: { verdict: { fix_scope: ["src/parser.ts"] } },
  };
  const first = await router.route({
    assignment: { attempts: 0, sourceContext: {} },
    attempt: { attempt: 1 },
    result: { failure },
  });
  assert.equal(first.action, "retry_same_worker");
  assert.equal(first.retryStrategy, "targeted_repair");

  const second = await router.route({
    assignment: {
      attempts: 1,
      sourceContext: { retry: {
        failureFingerprint: first.failureFingerprint,
        retryStrategy: first.retryStrategy,
      } },
    },
    attempt: { attempt: 2 },
    result: { failure },
  });
  assert.equal(second.action, "retry_same_worker");
  assert.equal(second.retryStrategy, "fresh_session_diagnosis");
  assert.equal(second.forceFreshSession, true);

  const exhausted = await router.route({
    assignment: {
      attempts: 2,
      sourceContext: { retry: {
        failureFingerprint: second.failureFingerprint,
        retryStrategy: second.retryStrategy,
      } },
    },
    attempt: { attempt: 3 },
    result: { failure },
  });
  assert.equal(exhausted.action, "mark_failed");
  assert.equal(exhausted.retryable, false);
  assert.match(String(exhausted.reason), /exhausted distinct queue recovery strategies/);
});

test("FailureRouter consults supervisor for verification_failed in smart mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "restart_worker_and_retry", reason: "supervisor diagnosed" }; },
  };
  const router = new FailureRouter(supervisor, { readModeFn: async () => "smart" });

  const result = await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.VERIFICATION_FAILED, reason: "bad", cause: { verdict: { fix_scope: ["src/api.js"] } } } },
  });
  assert.equal(diagnosed, true);
  assert.equal(result.action, "restart_worker_and_retry");
});

test("FailureRouter consults supervisor for assignment_progress_stale in smart mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "mark_failed", reason: "supervisor" }; },
  };
  const router = new FailureRouter(supervisor, { readModeFn: async () => "smart" });

  await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.ASSIGNMENT_PROGRESS_STALE, reason: "stale" } },
  });
  assert.equal(diagnosed, true);
});

test("FailureRouter consults supervisor for timeout in smart mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "mark_failed", reason: "supervisor" }; },
  };
  const router = new FailureRouter(supervisor, { readModeFn: async () => "smart" });

  await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.TIMEOUT, reason: "timed out" } },
  });
  assert.equal(diagnosed, true);
});

test("FailureRouter does not consult supervisor for timeout in default mode", async () => {
  let diagnosed = false;
  const supervisor = {
    diagnoseFailure: async () => { diagnosed = true; return { action: "mark_failed" }; },
  };
  const router = new FailureRouter(supervisor, { readModeFn: async () => "default" });

  const result = await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: { failure: { kind: FailureKind.TIMEOUT, reason: "timed out" } },
  });
  assert.equal(diagnosed, false);
  assert.equal(result.action, "restart_worker_and_retry");
});

test("FailureRouter marks non-retryable rate limits as failed", async () => {
  const router = new FailureRouter();

  const result = await router.route({
    assignment: { attempts: 0 },
    attempt: { attempt: 1 },
    result: {
      failure: {
        kind: FailureKind.AGENT_RATE_LIMITED,
        reason: "provider unavailable by hard gate",
        retryable: false,
        cause: { hardGate: true, nextEligibleAt: Date.now() + 60_000 },
      },
    },
  });

  assert.equal(result.action, "mark_failed");
  assert.equal(result.retryable, false);
  assert.match(result.reason, /non-retryable/);
});

// ── Scheduler mode config persistence ──

test("scheduler mode persists through config.json", async () => {
  const hubRoot = await tempRoot("cpb-sched-persist");
  await writeHubConfig(hubRoot, {});
  const config = await readHubConfig(hubRoot);
  config.scheduler = { mode: "smart" };
  await writeHubConfig(hubRoot, config);

  const reloaded = await readHubConfig(hubRoot);
  assert.equal(reloaded.scheduler.mode, "smart");
});

// ── Default mode is preserved — no behavior change ──

test("default mode returns null when no pending entries", async () => {
  const hubRoot = await hubWithSchedulerMode("default");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate, null);
});

test("smart mode returns null when no pending entries", async () => {
  const hubRoot = await hubWithSchedulerMode("smart");
  const store = new AssignmentStore(hubRoot);
  await store.init();

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate, null);
});

test("scheduler skips pending entries whose registered project is missing", async () => {
  const hubRoot = await hubWithSchedulerMode("default");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  await enqueue(hubRoot, { projectId: "missing-project", description: "should not schedule" });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
    getProjectFn: async () => null,
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate, null);
});

test("scheduler skips entries with future retryDecision untilTs", async () => {
  const hubRoot = await hubWithSchedulerMode("default");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const futureUntilTs = Date.now() + 60_000;
  await enqueue(hubRoot, {
    projectId: "proj",
    description: "rate limited task",
    metadata: {
      retryDecision: {
        action: "wait_for_rate_limit",
        untilTs: futureUntilTs,
      },
    },
  });

  const scheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });

  const candidate = await scheduler.nextCandidate();
  assert.equal(candidate, null);
});

test("mode switch from default to smart changes scheduling behavior", async () => {
  const hubRoot = await tempRoot("cpb-sched-switch");
  // Start in default mode
  await writeJson(path.join(hubRoot, "config.json"), { scheduler: { mode: "default" } });
  const store = new AssignmentStore(hubRoot);
  await store.init();

  // Create two entries where smart mode would pick differently due to failure metadata
  await enqueue(hubRoot, { projectId: "proj", description: "task a", priority: "P2" });
  await enqueue(hubRoot, {
    projectId: "proj",
    description: "task b",
    priority: "P2",
    metadata: { lastFailureKind: "verification_failed", failureCount: 1 },
  });

  // Default mode: picks by createdAt (task a first)
  const defaultScheduler = new Scheduler(hubRoot, {
    assignmentStore: store,
    workerStore: { findIdleWorker: async () => null },
  });
  // Re-read mode dynamically — config still says default
  const defaultCandidate = await defaultScheduler.nextCandidate();
  assert.equal(defaultCandidate.description, "task a");

  // Switch to smart mode
  await writeJson(path.join(hubRoot, "config.json"), { scheduler: { mode: "smart" } });

  // Re-enqueue since task a was already consumed
  const taskA2 = await enqueue(hubRoot, { projectId: "proj", description: "task a2", priority: "P2" });

  const smartCandidate = await defaultScheduler.nextCandidate();
  // Smart mode: task b has verification_failed boost (+5) minus failure penalty (-4) = net +1
  assert.equal(smartCandidate.description, "task b");
  assert.equal(smartCandidate.metadata.schedulerDecision.mode, "smart");
});
