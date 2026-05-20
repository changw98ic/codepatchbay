# Deliverable 008: Runtime Root Data Path Migration

## Handoff
- **From**: claude (execute)
- **To**: codex (verify)
- **Phase**: execute
- **Plan-ref**: plan-127
- **Issue**: GitHub #26 — P0.9a: Move CPB runtime state out of source tree into project runtime roots

## What Changed

All runtime state writes (events, checkpoints, leases, jobs-index) now route through `projectRuntimeRoot` when the project has one registered. Source checkout (`CPB_ROOT`) receives zero runtime writes.

### Service Layer (`server/services/`)

1. **`event-store.js`** — Added `_base(cpbRoot, opts)` helper. `appendEvent`, `writeCheckpoint`, `deleteCheckpoint`, `repairEventFile` write via `_base` (respects `dataRoot`). `readEvents`, `readCheckpoint` try `dataRoot` first then fall back to legacy `cpbRoot/cpb-task/`. `listEventFiles` scans both runtime root and legacy paths with deduplication.

2. **`runtime-events.js`** — Passes `opts` (including `dataRoot`) through to event-store JS implementation.

3. **`lease-manager.js`** — Added `_base` helper. `acquireLease`, `renewLease`, `releaseLease` write via `_base`. `readLease` tries `dataRoot` first then legacy.

4. **`jobs-index.js`** — Added `_base` helper. `updateJobsIndexEntry`, `writeJobsIndex`, `rebuildJobsIndex`, `mergeMissingEventStreams`, `listJobsFromIndex` all respect `dataRoot`.

5. **`job-store.js`** — All 15 public functions (`createJob`, `startPhase`, `completePhase`, `blockJob`, `failJob`, `retryJob`, `budgetExceeded`, `completeJob`, `recordActivity`, `requestCancelJob`, `cancelJob`, `requestRedirectJob`, `consumeRedirect`, `getJob`, `listJobs`) now accept `dataRoot` in options and pass it to downstream calls.

6. **`observability.js`** — `buildObservabilitySummary` includes `projectRuntimeRoots` mapping.

### Routes (`server/routes/`)

7. **`tasks.js`** — Added `projectRuntimeEnv(hubRoot, name)` helper. All bridge-spawning routes (plan, execute, verify, pipeline) pass `CPB_PROJECT_RUNTIME_ROOT` env var. Cancel/redirect routes resolve `dataRoot` from hub registry.

### Bridge Scripts (`bridges/`)

8. **`common.sh`** — Added `resolve_wiki_dir()`, `resolve_inbox_dir()`, `resolve_outputs_dir()` helpers that use `$CPB_PROJECT_RUNTIME_ROOT` when set, falling back to legacy `$CPB_ROOT/wiki/projects/$project`. All RTK functions (`rtk_codex_plan`, `rtk_claude_execute`, `rtk_codex_verify`, `rtk_codex_verify_job`, `rtk_claude_repair`, `rtk_codex_plan_with_research`) use resolved paths.

## Design Decisions

- **Optional `dataRoot` parameter pattern** — Instead of changing `cpbRoot` semantics, all functions accept an optional `dataRoot` in their options object. When provided, writes go to `dataRoot`; reads try `dataRoot` first then fall back to legacy. Zero breaking changes.

- **Read fallback** — `readEvents`, `readCheckpoint`, `readLease` try `dataRoot` first. If no data found there, they transparently fall back to legacy `cpbRoot/cpb-task/`. This ensures existing jobs remain accessible after migration.

- **Environment propagation** — Server routes resolve `projectRuntimeRoot` from hub registry and pass it as `CPB_PROJECT_RUNTIME_ROOT` to spawned bridge processes. Bridge scripts check this env var in their `resolve_*_dir()` helpers.

## Test Evidence

New test file: `tests/runtime-root-data-paths.test.mjs` — 20 tests across 5 suites:

| Suite | Tests | Proves |
|-------|-------|--------|
| event-store: writes go to dataRoot | 6 | Events, checkpoints, reads, fallback, listEventFiles dedup |
| job-store: lifecycle writes go to dataRoot | 6 | create, lifecycle, fail, block, activity, list |
| lease-manager: writes go to dataRoot | 4 | acquire, read, fallback, release |
| jobs-index: writes go to dataRoot | 2 | update, listFromIndex |
| cross-cutting: zero source-tree writes | 2 | Full lifecycle zero pollution, legacy coexistence |

All 122 tests pass (including existing `runtime-root-separation.test.mjs` and route tests).

## Acceptance Criteria

- [x] AC1: `registerProject` defaults `projectRuntimeRoot` to `~/.cpb/projects/<id>`
- [x] AC2: Event/checkpoint/lease/index writes go to `projectRuntimeRoot` when set
- [x] AC3: Bridge scripts resolve wiki/inbox/outputs from runtime root
- [x] AC4: Reads fall back to legacy when runtime root has no data
- [x] AC5: Zero source-checkout runtime writes when `dataRoot` is set
- [x] AC6: All tests pass

## Files Modified

- `server/services/event-store.js`
- `server/services/runtime-events.js`
- `server/services/lease-manager.js`
- `server/services/jobs-index.js`
- `server/services/job-store.js`
- `server/services/observability.js`
- `server/routes/tasks.js`
- `bridges/common.sh`
- `tests/runtime-root-data-paths.test.mjs` (new)
