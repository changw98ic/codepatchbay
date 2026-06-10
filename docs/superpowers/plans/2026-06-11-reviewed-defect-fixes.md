# Reviewed Defect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the adversarially confirmed project boundary, auth, cancellation, and retry scheduling defects.

**Architecture:** Add validation at ingress and scheduling gates so unsafe queue entries cannot reach workers. Keep runtime state semantics explicit: user cancellation becomes `cancelled`, non-retryable failures remain terminal, and future retry decisions pause scheduling instead of immediately re-dispatching.

**Tech Stack:** Node ESM, Fastify, Node test runner, Vitest web test runner.

---

### Task 1: Hub Project Boundary

**Files:**
- Modify: `server/routes/hub.js`
- Modify: `server/services/hub-queue.js`
- Modify: `server/orchestrator/scheduler.js`
- Test: `tests/routes-hub.test.mjs`
- Test: `tests/scheduler-modes.test.mjs`

- [ ] Write failing tests:
  - `/api/hub/queue/enqueue` rejects unknown `projectId`.
  - `/api/hub/queue/enqueue` rejects a `sourcePath` that differs from the registered project source.
  - `Scheduler.nextCandidate()` skips unknown projects when `getProjectFn` is configured.
- [ ] Run: `node --test tests/routes-hub.test.mjs tests/scheduler-modes.test.mjs`
  Expected before implementation: new tests fail.
- [ ] Implement minimal validation:
  - Route-level enqueue resolves the project before writing the queue.
  - Queue-level enqueue validates registered project existence and canonical source path when provided.
  - Scheduler treats missing project records as ineligible when a project lookup function exists.
- [ ] Run the same targeted test command.

### Task 2: API Key And WebSocket Auth

**Files:**
- Modify: `server/index.js`
- Test: `tests/server-boundary.test.mjs` or a new focused server auth test if existing helpers do not cover full server startup.

- [ ] Write failing test:
  - With `CPB_API_KEYS` set, HTTP `/api/hub/status` without key returns `401`.
  - With `CPB_API_KEYS` set, `/ws` without key is rejected.
  - With `CPB_API_KEYS` set, `/ws` with a valid `x-api-key` or `api_key` query connects.
- [ ] Run the targeted server auth test.
  Expected before implementation: unauthorized WebSocket test fails.
- [ ] Implement shared API key extraction and use it in both HTTP and WebSocket paths.
- [ ] Run the targeted server auth test.

### Task 3: Cancellation Status

**Files:**
- Modify: `runtime/worker/managed-worker.js`
- Modify: `server/orchestrator/reconciler.js`
- Test: `tests/integration/managed-worker.test.mjs`
- Test: `tests/assignment-reconciler.test.mjs`

- [ ] Update/add failing tests:
  - Managed worker writes `status: "cancelled"` and a non-retryable cancellation result.
  - Reconciler finalizes a cancelled result as queue status `cancelled`.
- [ ] Run: `node --test tests/integration/managed-worker.test.mjs --test-name-pattern "managed worker stops an active assignment"` and `node --test tests/assignment-reconciler.test.mjs`
  Expected before implementation: cancellation status assertions fail.
- [ ] Implement minimal cancellation semantics without changing worker cleanup.
- [ ] Run the same targeted tests.

### Task 4: Rate Limit Retry Semantics

**Files:**
- Modify: `server/orchestrator/failure-router.js`
- Modify: `server/orchestrator/scheduler.js`
- Test: `tests/scheduler-modes.test.mjs`
- Test: `tests/assignment-reconciler.test.mjs`

- [ ] Write failing tests:
  - `FailureRouter` marks `AGENT_RATE_LIMITED` with `retryable: false` as failed.
  - Scheduler skips entries whose `metadata.retryDecision.untilTs` is in the future.
  - Reconciler stores rate-limit retry entries with a status that will not be immediately scheduled, or scheduler skips them until due.
- [ ] Run: `node --test tests/scheduler-modes.test.mjs tests/assignment-reconciler.test.mjs`
  Expected before implementation: new tests fail.
- [ ] Implement minimal route ordering and scheduler due-time gate.
- [ ] Run the same targeted tests.

### Task 5: Verification

**Files:**
- No additional files unless docs need behavior notes.

- [ ] Run targeted Node tests touched above.
- [ ] Run `npm test`.
- [ ] Run `cd web && npm test -- --run`.
- [ ] Run `npm run build:web` if server auth changes require frontend build verification.
- [ ] Report changed files, simplifications made, and remaining risks.
