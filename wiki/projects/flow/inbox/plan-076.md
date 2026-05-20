## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-076-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, and implement only P0.1.
- Extend existing `cpb doctor` / report readiness surfaces rather than introducing a parallel readiness command.
- Add machine-readable `--json` output while preserving the existing human-readable output by default.
- Model readiness checks as structured check results with stable ids, severity, status, message, and redacted details so text and JSON output share one source of truth.
- Redact secrets and sensitive filesystem/user material in all output paths before rendering human or JSON reports.
- Keep tests focused on the requested P0.1 failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad CLI cleanup outside doctor/report readiness | explicitly out of scope for P0.1.
- Rewriting command registration or provider/runtime architecture | increases blast radius and is not required for readiness checks.
- Snapshot-only assertions for the full report | brittle; prefer targeted assertions over check ids, statuses, redaction, and JSON shape.
- Treating warnings as hard failures by default | P0.1 needs readiness signal without breaking existing behavior unless the current command already exits non-zero on failed checks.

### Scope

**目标**: Expand CPB doctor/report readiness coverage for promotion must-haves P0.1, with scoped implementation and regression tests while preserving current doctor/report behavior.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; use only the P0.1 requirements from this file.
- CLI doctor/report command implementation file(s) that currently own `cpb doctor` and report readiness output — add `--json`, route through structured readiness checks, and keep existing text output.
- Existing readiness/check helper module(s), if present — add or extend checks for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing CLI command tests for doctor/report — add targeted regression coverage for JSON output and P0.1 failure modes.
- Test fixture/helper files used by current doctor/report tests — adjust only where necessary to simulate requested readiness states without changing unrelated fake behavior.

**实现步骤**:
1. Inspect the promotion readiness plan and current `cpb doctor` / report command code. Confirm the existing command names, option parser, output renderer, exit-code behavior, and test style before editing.
2. Introduce a shared structured readiness result shape if one does not already exist. Use stable check ids such as `node`, `npm`, `git`, `acp.adapter`, `rust.runtime`, `hub.liveness`, `hub.writable`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, `disk.space`, and `redaction`.
3. Add `--json` support to the existing doctor/report command path. JSON output must be deterministic, redacted, and include overall status plus the list of check results. The default non-JSON output must remain compatible with current behavior.
4. Implement environment/tool checks:
   - Node and npm presence/version readiness.
   - Git presence/version readiness.
   - ACP adapter presence, version discovery, and a lightweight smoke-readiness check that does not perform destructive work.
   - Rust runtime readiness only when the Rust runtime is configured/enabled; if enabled and unavailable, emit a failed check; if disabled, emit skipped/not-applicable rather than failed.
5. Implement Hub and registry checks:
   - Hub liveness/readiness check using the project’s existing Hub client or health mechanism.
   - Hub writability check using the least invasive existing write/read or temp/probe mechanism available; clean up any probe data.
   - Registry consistency check using the existing registry source and invariants; report mismatches as warning or failure according to current readiness semantics.
6. Implement operational stale-state checks:
   - Detect stale jobs, workers, and leases using existing TTL/heartbeat/lease semantics.
   - Report counts and bounded identifiers only after applying redaction.
   - Avoid deleting or mutating stale records in `doctor`; this task is readiness reporting, not repair.
7. Implement provider and host-capacity checks:
   - Surface provider backoff/rate-limit state from existing provider metadata or retry/backoff store.
   - Emit disk-space warning when available space falls below the project’s existing threshold; if no threshold exists, choose a conservative warning threshold and keep it documented in code near the check.
8. Centralize redaction for both human and JSON output. Redact tokens, authorization headers, API keys, credentials, home-directory/user-specific absolute path material where existing conventions require it, and any provider error detail that may contain secrets.
9. Add or adjust tests using the existing test runner and mocking style:
   - `--json` output parses as JSON and includes expected status/check ids without unredacted secrets.
   - Missing ACP adapter is reported with the adapter check failed or warned according to current command semantics.
   - Stale Hub/liveness failure is reported without hanging.
   - Stale worker is detected and reported with a count or redacted identifier.
   - Provider rate limit/backoff is surfaced in doctor/report output.
   - Rust unavailable is reported only when Rust runtime is enabled, and is skipped/not applicable when disabled.
10. Run the relevant focused test suite first, then the normal project verification required for this CLI area. If any fake/test-double behavior no longer represents the real workflow, report the mismatch in the deliverable rather than mutating fake behavior just to force a pass.
11. Keep the final diff narrow. Do not perform unrelated cleanup, rename unrelated modules, update snapshots broadly, or add new dependencies unless absolutely unavoidable and explicitly justified.

**注意事项**:
- Preserve existing behavior for users who do not pass `--json`, including output ordering and exit-code semantics unless the existing code already defines readiness failure exits.
- Do not broaden into P0.2 or other promotion readiness items.
- Do not mutate Hub state except for a minimal writability probe that is safely cleaned up.
- Do not log or serialize secrets in test failures, JSON output, text output, or deliverable evidence.
- Prefer existing helpers for command execution, version parsing, Hub access, registry reads, provider state, and redaction before adding new utilities.

## Next-Action
Implement the scoped P0.1 changes above in `/Users/chengwen/dev/flow`, run the focused doctor/report tests and applicable project verification, then write `deliverable-076.md` with changed files, verification evidence, known risks, and any deviations from the plan.

## Acceptance-Criteria
- [ ] `cpb doctor` / report readiness still works in its existing default human-readable mode.
- [ ] `cpb doctor --json` or the existing equivalent doctor/report command supports valid redacted JSON output with overall readiness status and structured check results.
- [ ] JSON output includes readiness coverage for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime is checked only when enabled; enabled-but-unavailable Rust is reported, disabled Rust is not treated as a failure.
- [ ] Missing ACP adapter is reported by a targeted test.
- [ ] Stale Hub/liveness failure is reported by a targeted test without hangs or real external dependencies.
- [ ] Stale worker detection is reported by a targeted test.
- [ ] Provider rate-limit/backoff state is reported by a targeted test.
- [ ] Rust unavailable when enabled is reported by a targeted test.
- [ ] Output redaction is covered by tests and no unredacted secrets appear in human or JSON output.
- [ ] Existing doctor/report behavior and relevant tests remain passing.
- [ ] No unrelated cleanup, dependency additions, broad refactors, or unrelated snapshot churn are included.
