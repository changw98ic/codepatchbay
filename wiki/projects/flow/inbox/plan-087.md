# Plan 087 - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement P0.1: expand cpb doctor/report readiness checks.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-087
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, but implement only P0.1.
- Expand existing `cpb doctor` and `cpb report` readiness behavior in place; do not create a parallel readiness framework or broaden into unrelated cleanup.
- Add `--json` output for machine-readable readiness results while preserving existing human-readable output behavior.
- Model readiness checks as structured checks with stable ids, severity/status, human summary, optional details, and redacted diagnostics.
- Cover these readiness domains: Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and output redaction.
- Add or adjust focused tests for the required P0.1 failure modes: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled.
- Preserve existing behavior for callers that do not pass `--json`; only add new findings or warnings where P0.1 explicitly requires them.

### Rejected
- Rejected implementing other promotion-readiness items from the source plan; this handoff is limited to P0.1.
- Rejected replacing the current CLI/report architecture wholesale; keep the diff small and local to existing doctor/report paths.
- Rejected adding new runtime dependencies for checks that can be implemented with existing Node, filesystem, process, and project utilities.
- Rejected test fixture rewrites merely to make tests pass; update tests only where new P0.1 behavior changes expected readiness output.

### Scope

**Goal**: Implement P0.1 by expanding `cpb doctor` and `cpb report` readiness checks with structured JSON output, required environment/service checks, redaction, and focused regression coverage while preserving current non-JSON behavior.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first and use only the P0.1 requirements from that plan.

**Expected involved files**:
- Existing `cpb doctor` command implementation - add/route readiness checks and `--json` output.
- Existing `cpb report` command implementation - include the same readiness result model or call the shared readiness collector.
- Existing CLI option/parser definitions for `cpb doctor` and `cpb report` - register `--json` where missing without changing existing flags.
- Existing readiness/health/diagnostics utilities, if present - extend rather than duplicate.
- Existing Hub client/state/registry/job/worker/lease/provider utilities - reuse for liveness, writability, consistency, stale-state, and backoff checks.
- Existing tests for CLI doctor/report/readiness behavior - extend current coverage.
- New focused tests only if no suitable existing test file covers a required P0.1 scenario.

**Implementation steps**:
1. Read the P0.1 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then locate the existing `cpb doctor` and `cpb report` command implementations and their tests.
2. Identify the current output contract for `cpb doctor` and `cpb report`; preserve it for default human output and add an explicit `--json` path.
3. Introduce or extend a shared readiness result type with stable fields: `id`, `label`, `status`, `severity`, `summary`, `details`, and `remediation` where the project style supports it.
4. Implement Node/npm checks using the current runtime and package-manager availability/version data already accessible in the CLI environment.
5. Implement Git checks for command availability and repository readiness using existing Git helpers where available.
6. Implement ACP adapter readiness checks for presence, version discovery, and a bounded smoke-readiness probe; if the adapter is missing or the smoke probe cannot run, report a structured degraded/fail status instead of throwing.
7. Implement Rust runtime readiness only when the relevant Rust feature/config/runtime path is enabled; when enabled and unavailable, emit the required warning/failure covered by tests.
8. Implement Hub liveness and writability checks using existing Hub connection/state paths; distinguish unreachable/stale Hub from writable Hub and avoid mutating production state beyond a safe probe.
9. Implement registry consistency checks against the existing registry source of truth and report mismatches or unreadable state as structured readiness findings.
10. Implement stale jobs, stale workers, and stale leases detection using the project's existing age/heartbeat/status semantics; keep thresholds centralized or colocated with existing constants.
11. Implement provider backoff/rate-limit readiness so active provider cooldowns are reported with redacted provider identity/details and remaining retry/backoff information where available.
12. Implement disk-space warnings for relevant writable paths, including Hub/state/cache/output locations used by the CLI; warn before hard failure thresholds.
13. Add a redaction pass for both human and JSON readiness output so secrets, tokens, auth headers, API keys, home-directory-sensitive values, and provider credentials are not emitted.
14. Wire `cpb report --json` and `cpb doctor --json` to return a deterministic machine-readable object containing overall status plus the readiness checks; keep ordering stable for tests.
15. Add or adjust tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.
16. Add regression assertions that non-JSON output still works and that JSON output is parseable, deterministic, and redacted.
17. Run the relevant unit/integration tests for the changed CLI/readiness surface, then run the normal project lint/typecheck/test commands expected for this area.
18. Write `deliverable-087.md` summarizing changed files, verification evidence, behavior preserved, and any remaining risks.

**Notes**:
- Keep the implementation scoped to P0.1. Do not implement other P0/P1/P2 items from the promotion readiness plan.
- Prefer shared collector logic so `doctor` and `report` cannot drift, but avoid broad architectural cleanup.
- If a check depends on optional external tools or services, failure to inspect should become a readiness finding, not an uncaught CLI crash.
- JSON output must be suitable for automation: valid JSON only on stdout for `--json`, with diagnostics either included as structured redacted fields or sent through the project's established logging path.
- Human output should remain readable and compatible with current usage; new warnings are acceptable only for P0.1 readiness domains.
- Do not modify fake/mock tests, fixtures, snapshots, or test doubles solely to mask a production behavior change. Update them only to represent the new required readiness cases.

## Next-Action
Implement the scoped P0.1 readiness expansion above, run focused and standard verification, then write `deliverable-087.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid parseable JSON with an overall readiness status and stable structured check entries.
- [ ] `cpb report --json` includes the expanded readiness checks or the same shared readiness result model used by `doctor`.
- [ ] Default non-JSON `cpb doctor` and `cpb report` behavior remains compatible with existing human-readable output.
- [ ] Readiness checks cover Node/npm availability/version, Git availability/readiness, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is reported as a structured readiness failure/degraded check and is covered by a test.
- [ ] Stale Hub state is detected and covered by a test.
- [ ] Stale worker state is detected and covered by a test.
- [ ] Provider rate limit/backoff state is detected and covered by a test.
- [ ] Rust unavailable while Rust runtime support is enabled is detected and covered by a test.
- [ ] Readiness output redacts secrets, tokens, auth headers, API keys, provider credentials, and sensitive local paths in both JSON and human output.
- [ ] JSON output ordering and field names are deterministic enough for tests and downstream automation.
- [ ] Optional/missing tools or services produce readiness findings instead of uncaught exceptions.
- [ ] No unrelated cleanup, dependency additions, broad refactors, or non-P0.1 promotion-readiness work is included.
- [ ] Relevant CLI/readiness tests pass.
- [ ] Project lint/typecheck/test commands relevant to the touched area pass, or any inability to run them is documented in `deliverable-087.md`.
- [ ] Final deliverable lists changed files, verification evidence, simplifications made, and remaining risks.
