## Handoff: codex -> claude

# Plan-008: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-008-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation authority and implement only P0.1.
- Extend the existing `cpb doctor` and/or `cpb report` readiness path in place instead of introducing a parallel readiness framework.
- Add structured readiness result data once, then render it through both human-readable output and `--json` output to avoid divergent behavior.
- Model each check as a named readiness item with status, severity, message, optional details, and remediation, while redacting secrets before any output is printed or serialized.
- Preserve existing command behavior by keeping current text output valid unless `--json` is explicitly requested.
- Tests must cover the required P0.1 failure modes with deterministic fakes or injected probes, not by mutating fake responders only to force green tests.

### Rejected
- Broad cleanup of CLI, Hub, provider, registry, or runtime internals | Outside the P0.1 slice and explicitly disallowed.
- Adding new dependencies for CLI formatting, system probing, or JSON output | Not required; keep the diff scoped and reversible.
- Shelling out directly from tests without isolation | Creates flaky environment-coupled tests for Node/npm/Git/Rust readiness.
- Printing raw environment variables, tokens, URLs with credentials, or provider payloads in diagnostics | Violates the redaction requirement.

### Scope

**Goal**: Expand CPB readiness diagnostics for `cpb doctor`/`cpb report` so the promotion readiness P0.1 checks are available in human output and `--json`, preserve existing behavior, and add focused tests for the required degraded states.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read P0.1 before editing and do not implement P1/P2 or unrelated cleanup.

**Likely files to inspect and update**:
- CLI command entry for `cpb doctor` — add or route `--json`, invoke expanded readiness checks, preserve human output.
- CLI command entry for `cpb report` — include the same readiness result shape or call the same shared collector if report already aggregates diagnostics.
- Existing readiness/doctor/report helper module — add checks for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale state, provider backoff, disk space, and redaction.
- Hub/state/registry/provider modules used by the current doctor/report path — read only enough to use existing APIs for liveness, writability, registry consistency, workers, jobs, leases, and provider backoff.
- Existing CLI tests for doctor/report — extend with `--json` assertions and required degraded-state fixtures.
- Add a new focused readiness test file only if the existing test layout has no natural doctor/report test home.

**Implementation steps**:
1. Read the P0.1 section of the promotion readiness plan and the current `cpb doctor`/`cpb report` implementation. Record the exact existing output and exit-code behavior before changing code.
2. Identify the current diagnostic boundary. If doctor/report already collect health checks, extend that collector. If they duplicate logic, create one small shared readiness collector in the existing CLI/diagnostics area and route both commands through it.
3. Define a stable JSON schema for `--json` output:
   - top-level command metadata: command name, timestamp, overall status, summary counts, and checks array;
   - each check: `id`, `label`, `status` (`ok`, `warn`, `fail`, `skipped`), `severity`, `message`, optional `details`, optional `remediation`;
   - no unredacted secrets in any field.
4. Add `--json` parsing for the affected command(s) using the repo's existing CLI option style. Human output remains the default; JSON output writes valid JSON only, with no progress text mixed into stdout.
5. Implement Node/npm readiness checks by using existing command/probe utilities where present. Report Node and npm presence and versions; fail or warn consistently with current doctor severity conventions when either is missing.
6. Implement Git readiness by checking presence and version. Reuse existing process runner abstraction if available so tests can fake command results.
7. Implement ACP adapter readiness:
   - detect configured/expected ACP adapter presence;
   - report adapter version when available;
   - perform a minimal smoke-readiness probe that does not mutate project state;
   - return an actionable failure when the adapter is missing.
8. Implement Rust runtime readiness only when Rust-backed execution is enabled by config or environment. If disabled, emit `skipped`. If enabled and runtime/tooling is unavailable, emit the required warning/failure without crashing.
9. Implement Hub liveness and writability checks using existing Hub APIs or state paths. Distinguish unreachable/stale Hub from non-writable Hub storage, and include remediation text.
10. Implement registry consistency checks using existing registry read/validation APIs. Detect malformed, missing, or inconsistent entries without rewriting registry state from doctor/report.
11. Implement stale jobs, workers, and leases checks. Use existing TTL/heartbeat semantics where available; otherwise derive staleness from existing timestamps conservatively and document the threshold in code or test names.
12. Implement provider backoff/rate-limit readiness. Surface when a provider is currently backed off or rate limited, including provider id/name and retry timing after redaction. Do not trigger live provider calls solely for doctor/report.
13. Implement disk-space warnings for relevant CPB data paths, Hub paths, or project paths using the repo's existing filesystem utilities if available. Warn below the current project threshold or introduce a small local constant if no threshold exists.
14. Add a central redaction pass for all readiness output. Cover environment-style secrets, bearer/API tokens, credentialed URLs, and provider payload fragments before rendering human output or JSON.
15. Add or update tests for:
   - `--json` output is parseable and contains the expanded readiness check ids;
   - missing ACP adapter;
   - stale Hub;
   - stale worker;
   - provider rate limit/backoff;
   - Rust enabled but unavailable;
   - redaction in human output and JSON;
   - existing default human output behavior still works.
16. Run the targeted doctor/report test suite first, then the repo's standard lint/typecheck/test commands expected for this area. Fix implementation issues without widening scope.
17. Write the execute deliverable with changed files, verification commands and output summaries, behavior notes, and any remaining risks.

**Notes and guardrails**:
- Keep all changes inside the P0.1 readiness diagnostics surface.
- Do not refactor unrelated command parsing, provider execution, Hub lifecycle, registry persistence, or worker orchestration.
- Do not make doctor/report mutate Hub, registry, leases, workers, jobs, or provider state except for harmless read-only smoke probes already supported by existing APIs.
- Prefer dependency injection or existing probe abstractions so tests do not depend on the developer machine having missing tools.
- If exit-code semantics already exist, preserve them. If none exist for warnings, do not introduce a breaking nonzero exit for warnings without clear support in the source plan.
- JSON field names should be stable and documented in tests because other CPB surfaces may consume them.

## Next-Action
Implement P0.1 exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. After implementation and verification, write `deliverable-008.md` with changed files, evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only, with top-level metadata, summary counts, overall status, and named readiness checks.
- [ ] `cpb report` includes the expanded readiness diagnostics, and if `--json` is supported for report it emits the same redacted readiness data shape.
- [ ] Default human-readable doctor/report output still works and preserves existing behavior except for the added readiness checks.
- [ ] Readiness covers Node presence/version and npm presence/version.
- [ ] Readiness covers Git presence/version.
- [ ] Readiness covers ACP adapter presence, version when available, and non-mutating smoke readiness.
- [ ] Missing ACP adapter is reported with a deterministic status, message, and remediation.
- [ ] Rust runtime readiness is checked only when Rust-backed execution is enabled; Rust unavailable is reported without crashing.
- [ ] Hub liveness and Hub storage writability are checked separately.
- [ ] Stale Hub state is detected and covered by tests.
- [ ] Registry consistency is checked without mutating registry state.
- [ ] Stale jobs, workers, and leases are surfaced, with stale worker covered by tests.
- [ ] Provider backoff/rate-limit state is surfaced without making live provider calls, with rate limit covered by tests.
- [ ] Disk-space warning is emitted for low-space relevant CPB paths.
- [ ] Human output and JSON output redact tokens, credentials, API keys, bearer values, and credentialed URLs.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust enabled but unavailable, redaction, and JSON parseability.
- [ ] Existing doctor/report tests continue to pass.
- [ ] No unrelated cleanup, dependency additions, or behavior changes outside P0.1 are included.
- [ ] Deliverable includes exact test commands run and summarized results.
