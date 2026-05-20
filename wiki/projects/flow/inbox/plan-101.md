# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1 expand cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-101
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, but implement only P0.1.
- Keep the change scoped to existing `cpb doctor` / `cpb report` readiness behavior and directly supporting tests.
- Add `--json` output for readiness reporting with a stable machine-readable schema while preserving existing human-readable output behavior.
- Centralize readiness collection behind the existing doctor/report path rather than creating a parallel command or unrelated health-check framework.
- Readiness checks must cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when Rust is enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and output redaction.
- Use severity/status values consistently so both human and JSON output can distinguish pass, warning, failure, and skipped/not-applicable checks.
- Add or adjust tests for the named P0.1 cases: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.

### Rejected
- Broad cleanup outside readiness checks | The task explicitly says not to broaden into unrelated cleanup.
- Making Rust a mandatory check in all environments | The task says Rust runtime readiness applies when enabled.
- Implementing JSON by scraping human output | This is brittle and risks leaking unredacted text; collect structured check results first, then render both formats.
- Updating fake/mock assets only to make tests pass | Existing project guidance forbids changing fakes or test doubles merely to mask production behavior changes.
- Adding new dependencies | Existing working agreements prohibit new dependencies without explicit request.

### Scope

**Goal**: Expand `cpb doctor` / `cpb report` readiness checks for promotion P0.1, with scoped implementation, regression tests, redacted output, and preserved existing behavior.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first and use only the P0.1 requirements relevant to doctor/report readiness.

**Files to modify**:
- Existing `cpb doctor` command implementation - add/route readiness checks and `--json` rendering.
- Existing `cpb report` command implementation - include the same readiness model or consume the shared readiness collector.
- Existing readiness/health/diagnostics helpers used by doctor/report - add checks for runtime tools, ACP adapter, Hub, registry, stale state, provider backoff, disk space, and redaction.
- Existing doctor/report tests - add regression coverage for new P0.1 readiness behavior and preserve existing behavior assertions.
- Existing test fixtures only when they model the real workflow being tested - do not weaken fakes just to satisfy changed output.

**Out of scope**:
- No unrelated refactors, CLI redesign, new command names, new dependencies, or promotion tasks outside P0.1.
- No changes to behavior unrelated to readiness reporting.
- No test snapshot churn unless the snapshot directly covers doctor/report output and the production behavior intentionally changed.

**Implementation steps**:
1. Read the promotion readiness plan and extract only the P0.1 doctor/report requirements. Record any exact names, enabled/disabled conditions, and expected severity semantics from that document before editing.
2. Locate the current `cpb doctor` and `cpb report` command paths and the tests that already exercise them. Identify the existing output contract so the human output can remain compatible except for the added readiness lines.
3. Add failing tests first for `cpb doctor --json` and, if report has its own flag/parser, `cpb report --json`. Assert the JSON includes a top-level readiness summary and individual check entries with stable fields such as `id`, `label`, `status`, `severity`, `message`, and optional `details` that are redacted.
4. Add failing tests for the required P0.1 scenarios:
   - Missing ACP adapter reports a failure with no secret-bearing paths/tokens in output.
   - Stale Hub state reports a warning or failure according to existing severity conventions.
   - Stale worker/job/lease state is detected and reported without deleting state.
   - Provider backoff or rate-limit state reports a warning with retry/backoff information redacted as needed.
   - Rust runtime unavailable reports skipped/not-applicable when Rust is disabled and warning/failure when Rust is enabled.
5. Implement a shared readiness result model if one does not already exist. Keep it small: one collector returning structured check results, plus renderers for human text and JSON.
6. Implement runtime tool checks:
   - Node and npm presence/version.
   - Git presence/version.
   - Rust runtime presence/version only when the existing configuration or environment says Rust support is enabled.
7. Implement ACP adapter readiness:
   - Presence check for the configured adapter.
   - Version check when version information is available.
   - Smoke readiness check using the lightest existing non-destructive adapter probe.
   - Clear failure when the adapter is missing or smoke readiness fails.
8. Implement Hub and registry checks:
   - Hub process/API liveness using existing Hub client/probe code.
   - Hub storage/writability using a non-destructive temp or dry-run write path if available.
   - Registry consistency using existing registry loading/validation functions.
   - Stale jobs, workers, and leases detection using existing state timestamps/heartbeat conventions.
9. Implement provider and disk checks:
   - Detect provider backoff/rate-limit state from existing provider status/state, not by making real provider calls.
   - Add disk-space warnings using existing filesystem utilities or standard library calls; warn before failure and avoid hardcoded platform-specific behavior where existing code already abstracts it.
10. Add redaction at the structured-result boundary so both human and JSON output are safe. Cover paths, tokens, API keys, bearer values, provider credentials, and adapter command arguments that may contain secrets.
11. Preserve existing exit-code behavior unless the promotion plan explicitly requires a new readiness exit policy. If new failures affect exit codes, keep warnings non-fatal and document the mapping in tests.
12. Run the focused doctor/report test suite first, then the relevant broader lint/type/test commands expected by this repo. Fix real production/test mismatches without broadening the diff.
13. Produce `deliverable-101.md` with changed files, test evidence, implementation notes, remaining risks, and any exact P0.1 requirement from the source plan that could not be implemented.

**Notes for implementation**:
- Prefer existing helpers and local command patterns over new abstractions.
- Keep check identifiers stable and concise, for example `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub_liveness`, `hub_writability`, `registry_consistency`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, and `disk_space`.
- Keep smoke checks non-destructive and bounded; do not start long-lived services or mutate Hub state except for a safe writability probe that cleans up after itself.
- If a dependency is unavailable in tests, inject command/probe providers through existing test seams instead of rewriting global state.
- Do not redact so aggressively that diagnostics become useless; preserve safe labels, versions, statuses, and counts.

## Next-Action
Implement only TASK-101 P0.1 as described above. Start by reading the promotion readiness plan, then update the existing doctor/report readiness path, add focused tests for the required failure modes, run verification, and write `deliverable-101.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with a readiness summary and per-check structured results.
- [ ] `cpb report --json` includes the expanded readiness results or otherwise exposes the same readiness model through the existing report contract.
- [ ] Human-readable `cpb doctor` / `cpb report` output preserves existing behavior while adding scoped readiness information.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is tested and reported as a readiness failure.
- [ ] Stale Hub state is tested and reported with the correct severity.
- [ ] Stale worker/job/lease state is tested and reported without destructive cleanup.
- [ ] Provider rate-limit/backoff state is tested and reported without making live provider calls.
- [ ] Rust unavailable is tested for both disabled and enabled Rust-runtime conditions.
- [ ] JSON and human output redact secrets, tokens, credentials, and sensitive adapter/provider arguments.
- [ ] Existing behavior unrelated to doctor/report readiness remains unchanged.
- [ ] No new dependencies are added.
- [ ] Focused doctor/report tests pass, and the repo-standard lint/type/test verification relevant to the touched files is run and reported in `deliverable-101.md`.
