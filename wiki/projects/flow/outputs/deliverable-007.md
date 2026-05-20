# Deliverable: P0.9a — Move CPB runtime state out of source tree into project runtime roots

## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: flow
- **Phase**: execute
- **Task-Ref**: GitHub issue #26 / plan-127
- **Timestamp**: 2026-05-20

## Summary

Separated CPB runtime writes from the source checkout into three distinct root concepts:

1. **CPB_EXECUTOR_ROOT** — immutable CPB app/release code (the source checkout)
2. **CPB_HUB_ROOT** — global Hub/control-plane data (defaults `~/.cpb/hub`)
3. **projectRuntimeRoot** — per-project runtime data (defaults `~/.cpb/projects/<projectId>`)

All new runtime writes for registered projects target `projectRuntimeRoot`. Legacy `wiki/projects/` and `cpb-task/` paths remain readable via fallback.

## Changed Files (issue #26 scope only)

| File | Change |
|------|--------|
| `server/services/runtime-root.js` | Added `cpbHome()`, `defaultProjectRuntimeRoot()`, `projectRuntimeRoot()`, `projectRuntimePath()`, `resolveDataRoot()`, `dataPath()` |
| `server/services/hub-registry.js` | `registerProject()` / `updateProject()` persist `projectRuntimeRoot`, defaulting to `~/.cpb/projects/<id>` |
| `server/services/artifact-locator.js` | New `resolveWikiDir()`, `resolveInboxDir()`, `resolveOutputsDir()`, `resolveArtifactPath()` — runtime root first, legacy fallback for reads |
| `server/routes/projects.js` | `GET /api/projects` reads from Hub registry; detail routes use artifact-locator with `req.cpbHubRoot` |
| `server/routes/hub.js` | `GET /hub/roots` reports `executorRoot`, `hubRoot`, `projectRuntimeRoots` separately |
| `server/services/diagnostics-bundle.js` | Diagnostic output includes `roots` object |
| `server/services/observability.js` | Observability summary includes `roots` object |
| `server/services/readiness-checks.js` | Readiness output includes `roots` with per-project runtime roots |
| `bridges/migrate-runtime-root.mjs` | Added `migrateToProjectRuntimeRoots()` with `--dry-run` and `--project-runtime` flags; added `wouldDelete` and `quarantineCandidates` report fields |
| `tests/routes-projects.test.mjs` | Updated all describe blocks with hubRoot setup for Hub-registry-backed routes |
| `tests/routes-hub.test.mjs` | Added tests for `/hub/roots` returning distinct root fields |
| `tests/runtime-root-separation.test.mjs` | **NEW** — 9 focused tests for acceptance criteria (AC1, AC3, AC4, AC5, AC6) |

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| AC1 | `registerProject()` defaults `projectRuntimeRoot` to `~/.cpb/projects/<projectId>` | PASS | `tests/runtime-root-separation.test.mjs` AC1 tests |
| AC2 | New writes use `projectRuntimeRoot` by default | PARTIAL | Runtime root primitives wired; artifact-locator routes through project runtime roots. Bridge scripts (CLI layer) not yet updated — deferred to follow-up |
| AC3 | Distinct root concepts in code and report output | PASS | `runtime-root.js` exports distinct functions; `/hub/roots`, diagnostics, readiness output include separate fields. AC3 tests pass |
| AC4 | `GET /api/projects` backed by Hub registry, not wiki scan | PASS | `projects.js` calls `listProjects(hubRoot)`; AC4 test confirms registry-backed listing |
| AC5 | Legacy `wiki/projects` data readable via fallback | PASS | `artifact-locator.js` resolves runtime root first, falls back to legacy; AC5 test confirms legacy read |
| AC6 | Migration `--dry-run` reports without changing files | PASS | `migrateToProjectRuntimeRoots()` with `dryRun:true` leaves files untouched; AC6 test verifies |
| AC7 | Focused tests prove no source-checkout runtime writes | PARTIAL | Core service layer tested; CLI bridge integration deferred |
| AC8 | Existing tests pass | PASS | See test evidence below |
| AC9 | Code style consistent | PASS | Follows existing filesystem/JSON service patterns |

## Test Evidence

### Focused tests (issue #26)
```
$ node --test tests/runtime-root-separation.test.mjs
9 tests, 9 pass, 0 fail
```

### Routes tests (regression)
```
$ node --test tests/routes-projects.test.mjs
82 tests, 82 pass, 0 fail
```

### Hub routes tests (regression)
```
$ node --test tests/routes-hub.test.mjs
7 tests, 7 pass, 0 fail
```

### Migration tests (regression)
```
$ node --test tests/migrate-runtime-root.test.mjs
4 tests, 4 pass, 0 fail
```

### Pre-existing failures (unrelated to this change)
- `tests/acp-client.test.mjs` — ENOENT on temp file (pre-existing)
- `tests/delete-guard.test.mjs` — regex mismatch on `[delete-blocked]` (pre-existing)

## Compatibility Risks

1. **Bridge scripts not yet updated**: `bridges/common.sh`, `bridges/run-phase.mjs`, `bridges/run-pipeline.mjs` still resolve paths through legacy `CPB_ROOT`. These need a follow-up task to propagate `CPB_HUB_ROOT` and project runtime roots into child processes.

2. **Job/event/lease stores**: `job-store.js`, `event-store.js`, `lease-manager.js` still write to `cpb-task/` under the executor root. These need updating to route writes through `projectRuntimeRoot` when a project context is available.

3. **Frontend**: `Dashboard.jsx` and `Project.jsx` consume `/api/projects` which is now Hub-registry-backed. UI behavior should be unchanged, but the data source switched from wiki scan to registry lookup.

## Acceptance-Criteria

- [x] A newly attached external project gets `projectRuntimeRoot` in the Hub registry, defaulting to `~/.cpb/projects/<projectId>`.
- [x] `CPB_EXECUTOR_ROOT`, `CPB_HUB_ROOT`, and `projectRuntimeRoot` are distinct concepts in code and report/readiness output.
- [x] `GET /api/projects` and the UI project list are backed by Hub registry plus project runtime roots, not by scanning `flow/wiki/projects`.
- [x] Legacy `cpb-task/` and `wiki/projects/` data remains readable when runtime-root data has not yet been migrated.
- [x] Migration/report command supports dry-run output showing planned moves, conflicts, and quarantine candidates without changing files.
- [x] Focused tests prove root separation behavior.
- [x] Relevant existing Node tests pass; pre-existing failures documented.
- [x] Code style remains consistent with existing filesystem/JSON service patterns.
- [ ] New runtime writes for all bridge scripts and job/event stores target `projectRuntimeRoot` — deferred to follow-up task.
