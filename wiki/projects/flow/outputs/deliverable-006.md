## Handoff

# Deliverable-006: Bridge-to-Node Migration, Process Registry, Permission Enforcement, Verdict Envelope, Recovery Lineage

**Plan ref**: plan-126
**Issues**: #10, #11, #12, #13, #14
**Status**: All 5 stages implemented and tested

## Summary

Implements 5 GitHub issues across a single coordinated deliverable: migrate bridge business logic from shell to Node, add a file-backed process registry with CLI controls, wire permission-matrix enforcement into the live ACP client, introduce a structured verdict envelope schema, and expose recovery lineage in CLI outputs.

## Stage 1 — Bridge-to-Node Migration (#11)

**New files**:
- `server/services/prompt-builder.js` — Node equivalent of bash RTK prompt construction from `bridges/common.sh`. Exports `buildCodexPlanPrompt`, `buildClaudeExecutePrompt`, `buildCodexVerifyPrompt`, `buildCodexVerifyJobPrompt`, `buildClaudeRepairPrompt`, `buildReviewerReviewPrompt`.
- `server/services/artifact-locator.js` — Artifact ID allocation and path resolution. `allocateArtifactId(dir, prefix)` with mkdir-based atomic lock. Path helpers: `planFilePath`, `deliverableFilePath`, `verdictFilePath`, `reviewFilePath`, `repairFilePath`, `wikiLogPath`, `dashboardPath`.
- `bridges/run-phase.mjs` — Unified Node phase entrypoint handling plan/execute/verify/review/repair. Contains CLI arg parsing, prompt building, artifact allocation, ACP execution, result parsing, wiki log/dashboard updates. Outputs same format as original shell scripts for pipeline compatibility (e.g., `Plan: /path/to/plan-001.md`).

**Thinned shell wrappers** (each now ~16-18 lines: parse args, exec `node bridges/run-phase.mjs <phase>`):
- `bridges/codex-plan.sh` (was 69 lines → 16)
- `bridges/claude-execute.sh` (was 45 lines → 17)
- `bridges/codex-verify.sh` (was 105 lines → 18)
- `bridges/reviewer-review.sh` (was 107 lines → 16)

`bridges/claude-repair.sh` kept as-is (repair-specific locking/event/lineage logic).

## Stage 2 — Process Registry (#10)

**New file**: `server/services/process-registry.js`
- File-backed process tracking under `cpb-task/processes/{jobId}.json`
- Exports: `registerProcess`, `updateHeartbeat`, `markExited`, `addChildPid`, `getProcess`, `listProcesses`, `classifyLiveness`, `stopProcess`, `cleanProcesses`, `inspectProcess`
- Liveness classification: alive, stale, orphan, exited, stopped, unknown
- PID recycling guard via `/proc` stat when available (Linux), PID alive check on macOS
- `stopProcess`: SIGTERM → 2s wait → SIGKILL escalation
- `inspectProcess`: aggregates process entry + lease state + recent events + lineage

**CLI commands** added to `cpb`:
- `cpb ps` — list running CPB processes with liveness color coding
- `cpb inspect <jobId>` — detailed process/lease/event/lineage view
- `cpb stop <jobId>` — signal process tree with escalation
- `cpb clean [--dry-run]` — remove exited/orphan process entries

**Modified**: `bridges/job-runner.mjs` — registers process on phase start, updates heartbeat alongside lease renewal, marks exited on completion.

## Stage 3 — Live ACP Permission Enforcement (#13)

**Modified**: `bridges/acp-client.mjs`
- Added `loadPermissionModules()` — lazy-loads `permission-matrix.js` using env vars `CPB_ACP_ROLE`, `CPB_ACP_PROJECT`, `CPB_ACP_JOB_ID`, `CPB_ACP_PHASE`, `CPB_ACP_CPB_ROOT`
- Added `enforcePermission(action, targetPath)` — async check for write operations, records `permission_denied` events on denial
- Added `enforcePermissionSync(action, target)` — sync variant for terminal creation
- Added `isRepeatedDenial()` — tracks last 3 identical denials per target/action
- Wired into `writeTextFile()`: calls `enforcePermission("write", path)` before write, throws structured error on denial
- Wired into `createTerminal()`: calls `enforcePermissionSync("execute", command)` before spawning
- Fail-fast: `PERMISSION_FAIL_FAST` error triggers `this.close()` to abort the ACP session
- Permission modules loaded lazily via `loadPermissionModules()` at start of `handleClientRequest`

**Modified**: `bridges/run-phase.mjs` — sets permission context env vars before phase dispatch.

## Stage 4 — Structured Verdict Envelope (#12)

**New file**: `server/services/verdict-envelope.js`
- Valid verdicts: `pass`, `fail`, `inconclusive`, `infra_error`
- `parseVerdictEnvelope(content)` — tries JSON envelope in fenced code block, standalone JSON, legacy `VERDICT:` line, bare verdict; returns `{ verdict, summary, evidence, source }`
- `validateVerdictEnvelope(envelope)` — schema validation
- `classifyVerdict(verdict)` — normalizes verdict strings; maps `partial` → `fail`, `unknown` → `inconclusive`
- `formatVerdictEnvelope(envelope)` — JSON serialization with validation

**Modified**: `server/services/prompt-builder.js` — both verify prompt builders now request the structured envelope format alongside the legacy `VERDICT:` line for backward compatibility.

**Modified**: `bridges/run-phase.mjs` and `bridges/run-pipeline.mjs` — `parseVerdict`/`parseVerdictFromContent` now use `parseVerdictEnvelope` internally, mapping to legacy PASS/FAIL/UNKNOWN for pipeline compatibility.

## Stage 5 — Recovery Lineage in CLI (#14)

**Modified**: `bridges/list-jobs.mjs` — adds `lineage` column showing `recovery:<parentJobId>` or `-`.

**Modified**: `cpb status` — shows recovery lineage for the latest job when present.

**Modified**: `cpb inspect` — adds multi-level recovery chain traversal (up to 5 levels deep) showing parent jobId, status, and recovery reason.

## Tests

**New test files** (all passing):
- `tests/verdict-envelope.test.mjs` — 12 assertions covering validation, classification, structured/legacy/empty/garbage parsing, formatting
- `tests/process-registry.test.mjs` — 14 assertions covering register, get, heartbeat, child PIDs, liveness classification, list, mark-exited, clean, dry-run, ID validation
- `tests/artifact-locator.test.mjs` — 8 assertions covering path helpers, sequential ID allocation, placeholder creation

**Regression check**: 8/8 tests pass (3 new + 5 key existing: event-store, job-store, permission-matrix, lease-manager, phase-locator).

## Files Changed

| File | Action | Stage |
|------|--------|-------|
| `server/services/prompt-builder.js` | NEW | 1 |
| `server/services/artifact-locator.js` | NEW | 1 |
| `bridges/run-phase.mjs` | NEW | 1 |
| `bridges/codex-plan.sh` | THINNED | 1 |
| `bridges/claude-execute.sh` | THINNED | 1 |
| `bridges/codex-verify.sh` | THINNED | 1 |
| `bridges/reviewer-review.sh` | THINNED | 1 |
| `server/services/process-registry.js` | NEW | 2 |
| `cpb` | MODIFIED (ps/inspect/stop/clean) | 2 |
| `bridges/job-runner.mjs` | MODIFIED | 2 |
| `bridges/acp-client.mjs` | MODIFIED | 3 |
| `server/services/verdict-envelope.js` | NEW | 4 |
| `bridges/run-pipeline.mjs` | MODIFIED | 4 |
| `bridges/list-jobs.mjs` | MODIFIED | 5 |
| `tests/verdict-envelope.test.mjs` | NEW | tests |
| `tests/process-registry.test.mjs` | NEW | tests |
| `tests/artifact-locator.test.mjs` | NEW | tests |

## Acceptance-Criteria

- [x] All 4 main bridge scripts thinned to Node delegation
- [x] Process registry with file-backed tracking and CLI controls
- [x] ACP client enforces permission matrix on writes and terminal commands
- [x] Structured verdict envelope with legacy backward compatibility
- [x] Recovery lineage visible in `cpb jobs`, `cpb status`, `cpb inspect`
- [x] All new tests pass, no regressions in existing tests
