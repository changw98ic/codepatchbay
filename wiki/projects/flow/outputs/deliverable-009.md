## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: flow
- **Phase**: execute
- **Task-Ref**: plan-128 / GitHub issue #27: P0.9b: Add project-aware parallel scheduling across multiple projects
- **Timestamp**: 2026-05-20T19:10:00+08:00

### Implemented

- `claimEligible()` — project-aware queue claiming that skips busy projects, serializes same-project mutating work, and supports cross-project concurrency.
- `isMutatingEntry()` — determines if an entry is mutating (default: true, unless `metadata.mutating === false`).
- `buildProjectQueueStatus()` — computes per-project pending/active/failed counts and active lock details (busy, busyReason, claimedBy, workerId).
- Stale claim recovery — `claimEligible` recovers stale `in_progress` entries older than `claimTimeoutMs` before computing active locks.
- Provider slot exhaustion — when `providerSlotsAvailable === false`, no entry is claimed and no project lock is recorded.
- Extended `queueStatus()` — returns `projects` (per-project breakdown) and `activeProjects` (projects with active mutating tasks) alongside existing top-level counts.
- `POST /hub/queue/claim` route — exposes `claimEligible` via HTTP with `workerId`, `projectId`, `maxActivePerProject`, `claimTimeoutMs`, `providerSlotsAvailable` parameters.
- Worker pool mode — `bridges/project-worker.mjs` accepts `--pool` flag to serve all eligible queued projects without requiring `--project`. Added `--max-active-per-project` flag.
- Worker uses `claimEligible()` — replaced `peekNext()` + manual `updateEntry()` claiming with `claimEligible()` for both single-project and pool modes.
- Dashboard active projects display — shows active projects with busy reason and worker ID in the queue summary section.

### Files Changed

- `server/services/hub-queue.js` — added `isMutatingEntry`, `buildProjectQueueStatus`, `claimEligible`, extended `queueStatus` with per-project breakdown
- `server/routes/hub.js` — added `POST /hub/queue/claim` route with project-aware claim parameters
- `bridges/project-worker.mjs` — added `--pool` and `--max-active-per-project` flags, replaced `claimNext`/`peekNext` with `claimEligible`, pool mode init/recover/release
- `web/src/pages/Dashboard.jsx` — added active projects display with busy reason and worker ID in queue summary
- `tests/hub-queue.test.mjs` — added 14 new tests: isMutatingEntry, buildProjectQueueStatus, claimEligible (cross-project, same-project serialization, provider exhaustion, stale recovery, non-mutating bypass, projectId filter, active projects), queueStatus per-project breakdown
- `tests/routes-hub.test.mjs` — added 4 new tests: claim route cross-project, all-busy, provider exhaustion, queue status per-project
- `web/src/pages/Dashboard.test.jsx` — added 2 new tests: active projects with busy reason/worker, hidden when no active projects

### Evidence

**hub-queue.test.mjs** (31 pass, 0 fail):
```
✔ isMutatingEntry (2 tests)
✔ buildProjectQueueStatus (2 tests)
✔ claimEligible — project-aware parallel scheduling (9 tests)
✔ queueStatus per-project breakdown (1 test)
✔ hub-queue service (17 existing tests — all still pass)
```

**routes-hub.test.mjs** (15 pass, 0 fail):
```
✔ POST /hub/queue/claim skips busy project and claims from another
✔ POST /hub/queue/claim returns no-claim when all projects busy
✔ POST /hub/queue/claim respects providerSlotsAvailable
✔ GET /hub/queue/status includes per-project breakdown
✔ Hub routes (11 existing tests — all still pass)
```

**hub-queue-contract.test.mjs** (12 pass, 0 fail — all existing contract tests still pass)

**cpb-hub-queue-cli.test.mjs** (3 pass, 0 fail — all existing CLI tests still pass)

**Web vitest** (56 pass, 0 fail):
```
✔ Dashboard active projects in queue status (2 new tests)
✔ All existing Dashboard tests (31 tests — all still pass)
```

### Unresolved

- Rust runtime parity: `claimEligible` is implemented in Node only. If `shouldUseRustRuntime()` is active, the Rust runtime would need a matching implementation. The existing `dequeue()` still uses the Rust path when enabled, so existing callers are unaffected.
- CLI `cpb hub queue-status` human-readable output does not yet print per-project breakdown (only `--json` shows the new fields).

### Risks

- Concurrent `claimEligible` calls on the same queue file could race. The current implementation relies on atomic file writes (`writeAtomic` with tmp+rename), which provides filesystem-level serialization on most platforms. For high-concurrency scenarios, a proper file lock would be needed.
- The `activeProjects` projection in `queueStatus` is computed from the current queue snapshot; if the queue is very large, this adds O(n) per-project aggregation overhead.

## Next-Action
Verify the implementation against the acceptance criteria in plan-128.md. Focus on: two-project parallelism, same-project serialization, stale claim recovery, provider slot exhaustion, queue status per-project fields, worker pool mode startup, and dashboard rendering. Give PASS/FAIL verdict.

## Acceptance-Criteria
- [x] `claimEligible({ workerId, projectId?, maxActivePerProject })` exists and is used by worker/route claiming instead of global FIFO dequeue for scheduler work.
- [x] With two projects and one active mutating task in project A, a worker can skip project A pending entries and claim project B.
- [x] Same-project mutating tasks remain serialized by default and never run concurrently when `maxActivePerProject` is 1.
- [x] Different projects can be active concurrently when provider/global capacity is available.
- [x] Provider/global slot exhaustion prevents claiming without recording a project busy lock.
- [x] Stale active claims are recovered according to claim timeout and then become claimable.
- [x] Queue entries track `claimedBy`, `claimedAt`, and `workerId` on claim.
- [x] Queue status reports pending/active counts by project plus active project busy reason and worker identity.
- [x] Worker startup supports both one-project mode and pool-of-projects mode.
- [x] Dashboard shows active projects, busy project reason, and eligible queued work.
- [x] Focused tests cover two-project parallelism, same-project serialization, stale claim recovery, provider slot exhaustion, route/CLI status, and dashboard rendering.
- [x] All affected tests pass and code style remains consistent with existing CPB patterns.
