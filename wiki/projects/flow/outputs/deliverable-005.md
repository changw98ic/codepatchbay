## Handoff: claude -> codex

- **From**: claude
- **To**: codex
- **Project**: flow
- **Phase**: execute
- **Task-Ref**: plan-009 (GitHub issue #1)
- **Timestamp**: 2026-05-19T10:15:00+08:00

### Implemented

Fixed all 4 blocking gaps identified in verdict-004:

1. **`cmd_status` argument parsing infinite loop**: The `*) [ -z "$project" ] && project="$1" || shift ;;` pattern never shifted when `$project` was empty (because `project="$1"` succeeds, so `|| shift` is skipped). Changed to `if [ -z "$project" ]; then project="$1"; fi; shift` so `shift` always runs. `cpb status <project> --json` no longer hangs.

2. **Status queue matching reports unrelated entries**: The fallback `entries.find(e => e.projectId === project && e.status === 'in_progress')` could match any in_progress entry for the project, even from a different job lineage. Replaced with lineage-only matching: `entries.find(e => e.metadata?.originJobId === latest.jobId || e.metadata?.jobId === latest.jobId)`, consistent with `cancel-redirect.mjs` (lines 94-97).

3. **Placeholder B tests replaced with real assertions**: The two repair-input isolation tests that just called `assert.ok(true)` now:
   - B1: Reads `common.sh`, verifies the `rtk_claude_repair` prompt contains a `## Locators` section, includes "Treat copied summaries as stale", and does NOT contain `VERDICT:` content.
   - B2: Reads `run-pipeline.mjs`, verifies `verifyArgs` array contains only `[project, deliverableId]` (no `execResult`/`planResult`), and that the fix phase receives `[project, planId, verdictPath]` (file path locator, not content).

4. **Cancel-redirect end-to-end test (C2)**: Added a new test section that spawns `cancel-redirect.mjs` as a real subprocess with `CPB_ROOT`/`CPB_HUB_ROOT` env vars, sets up a job with lease and queue entry linked by `originJobId`, runs cancel, then asserts: job status is `cancelled`, lease file is gone, and queue entry status is `cancelled`. This exercises the actual `convergeCancel` path through the real implementation rather than calling individual service functions.

### Files Changed

- `cpb` — Fixed `cmd_status` argument parsing (line 955) and status JSON queue matching (lines 1029-1031)
- `tests/issue-001-hardening.test.mjs` — Replaced placeholder B tests with real assertions; added `spawn` import; added C2 cancel-redirect end-to-end test

### Evidence

**Focused hardening tests** (28/28 pass):
```
✔ A: ACP verifier/repair tool denial policy (7 tests)
✔ A2: ACP tool denial with normalized names and param inspection (6 tests)
✔ A3: ACP tool denial audit event (1 test)
✔ B: Repair input isolation (2 tests)
✔ C: Cancel during fix-* phase convergence (2 tests)
✔ D: Queue/durable/lease consistency after cancel (4 tests)
✔ D2: Cancel queue matching is lineage-specific (2 tests)
✔ C2: cancel-redirect.mjs end-to-end convergence (1 test)
✔ E: Status heartbeat and observability fields (3 tests)
ℹ tests 28, pass 28, fail 0
```

**Related service tests** (43/43 pass):
```
tests/cancel-redirect.test.mjs
tests/cancel-enforcement.test.mjs
tests/hub-queue.test.mjs
tests/reconcile.test.mjs
tests/job-store.test.mjs
tests/lease-manager.test.mjs
ℹ tests 43, pass 43, fail 0
```

**Key fix — cmd_status parsing**:
```bash
# Before (infinite loop when $project is empty):
*) [ -z "$project" ] && project="$1" || shift ;;
# After (always shifts):
*) if [ -z "$project" ]; then project="$1"; fi; shift ;;
```

**Key fix — status queue lineage matching**:
```javascript
// Before (could match unrelated in_progress entry):
const match = entries.find(e => e.metadata?.originJobId === latest.jobId) ||
              entries.find(e => e.projectId === project && e.status === 'in_progress') || null;
// After (lineage-only, matches cancel-redirect.mjs pattern):
const match = entries.find(e =>
  e.metadata?.originJobId === latest.jobId || e.metadata?.jobId === latest.jobId
) || null;
```

### Unresolved
- None. All 4 blocking gaps from verdict-004 are addressed.

### Risks
- The C2 end-to-end test spawns a real subprocess; if `cancel-redirect.mjs` import paths change, the test will need updating.
- The B tests assert on source code text patterns (e.g., `## Locators`, `const verifyArgs`). If the prompt or args are restructured, test strings need updating — but that's intentional: the assertions guard against accidental regression of the isolation invariant.

## Next-Action
Verify the 4 fixes satisfy the remaining Acceptance-Criteria from plan-009.md. Specifically:
- [ ] B tests now assert repair-input isolation over actual source (not `assert.ok(true)`)
- [ ] `cpb status <project> --json` emits valid JSON without hanging
- [ ] Status JSON queue field matches only by lineage, not unrelated in_progress entries
- [ ] Cancel-redirect path is tested end-to-end through the real subprocess

## Acceptance-Criteria
- [ ] ACP launch policy denies verifier `computer-use` and equivalent UI/desktop tool attempts before side effects occur
- [ ] A denied ACP tool attempt is recorded as a CPB audit event with job id, phase, agent, tool, and denial reason
- [ ] External repair is launched with locators/log-code context only, not an authoritative precomputed evidence payload
- [ ] Cancelling a running `fix-*` phase terminates owned runner/ACP children and persists a terminal job state
- [ ] After cancellation, there is no active lease for the cancelled job
- [ ] After cancellation, queue status, durable job state, and `cpb status` agree on the terminal outcome
- [ ] A scoped reconcile/recover command can converge one requested job without mutating unrelated stale jobs
- [ ] `cpb status --json` emits valid machine-readable JSON
- [ ] Status JSON separates active phase, lease heartbeat, lease expiry, owner PID/liveness, queue claim heartbeat, and queue `updatedAt`
- [ ] Focused tests cover verifier tool denial, repair input isolation, cancel during `fix-*`, queue/durable consistency after cancel, and heartbeat/status observability
- [ ] All relevant existing tests and new focused tests pass
- [ ] Code style remains consistent with the existing project and the diff stays narrowly scoped
