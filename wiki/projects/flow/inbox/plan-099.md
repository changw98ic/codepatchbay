# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-099-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Keep the change scoped to `cpb doctor` / readiness report behavior and the directly required tests.
- Add `--json` output as a stable machine-readable readiness report while preserving existing human-readable output by default.
- Model readiness as structured checks with severity/status fields so CLI text and JSON output derive from the same result set.
- Redact secrets and sensitive paths/tokens before emitting either human-readable or JSON output.
- Prefer existing project patterns, helpers, fixtures, and test style; do not add dependencies unless the existing codebase already has the needed package.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — explicitly out of scope.
- Unrelated cleanup, command rewrites, CLI redesign, or registry/hub architectural changes — violates the requested narrow slice.
- Test-only fake updates that mask production regressions — existing behavior must be preserved and verified through purpose-built readiness tests.
- Shelling out with ad hoc parsing where existing runtime helpers already expose Node/npm/Git/Rust/adapter/hub state — reuse current abstractions first.

### Scope

**Goal**: Expand `cpb doctor` / report readiness checks for P0.1 so operators can get both human and `--json` readiness diagnostics covering runtime tools, adapters, hub state, registry consistency, stale runtime records, provider backoff, disk space, Rust availability when enabled, and safe redaction.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — confirm P0.1 details before editing and do not implement outside that slice.

**Likely files to inspect first**:
- CLI entrypoints for `cpb doctor`, `cpb report`, or readiness commands — locate the exact command parser and output path.
- Existing doctor/readiness modules — extend in place instead of creating parallel logic.
- Existing hub/client modules — reuse liveness, writability, jobs, workers, leases, and registry APIs.
- Existing provider/backoff modules — expose or query current rate-limit/backoff state without changing provider behavior.
- Existing ACP adapter integration modules — check adapter presence, version discovery, and smoke readiness using current adapter resolution paths.
- Existing Rust runtime feature/config modules — check only when the Rust runtime is enabled by config/env/feature flag.
- Existing tests for CLI output, doctor/report, hub state, registry, adapter, provider rate limits, and Rust runtime gating.

**Implementation steps**:
1. Read the P0.1 section of the promotion readiness plan and map each required check to the current command/module/test owner.
2. Find the existing `cpb doctor` and report/readiness implementation. Identify whether `report` is a separate command or an option/path behind `doctor`; extend the existing command surface rather than adding a new top-level command unless the code already has that shape.
3. Define or extend a structured readiness result type with fields such as `id`, `label`, `status`, `severity`, `message`, `details`, `remediation`, and optional `redacted` metadata. Use existing naming/status conventions if present.
4. Add `--json` support to the doctor/report command path. JSON should be deterministic, parseable, and include all checks. Human-readable output should remain the default and should preserve current behavior except for the newly added readiness lines/warnings.
5. Implement Node/npm and Git checks using existing tool/version detection helpers where available. Report missing executables, version lookup failures, and versions below project-supported minimums if the source plan or existing constants define minimums.
6. Implement ACP adapter checks for presence, version, and smoke readiness. Presence should fail clearly when the adapter cannot be resolved. Version should be included when available. Smoke readiness should be a low-cost readiness probe that does not mutate user state.
7. Implement Rust runtime readiness only when the Rust runtime is enabled. When enabled and unavailable, report a failing or warning status according to existing severity conventions. When disabled, report skipped/not-applicable rather than failing.
8. Implement Hub liveness and writability checks using existing hub APIs. Liveness should distinguish unreachable/stale Hub from healthy Hub. Writability should verify the configured state location or Hub write path without destructive writes; if a probe file/record is needed, clean it up.
9. Implement registry consistency checks using existing registry loading/validation logic. Detect missing/corrupt registry entries, inconsistent project references, and mismatches between Hub/project registry state without rewriting registry data during doctor.
10. Implement stale jobs, workers, and leases checks. Use existing TTL/heartbeat semantics if present. Report stale worker records separately from stale jobs and stale leases so the user can act on each class.
11. Implement provider backoff/rate-limit readiness. Surface active provider backoff state, remaining delay or reset time when known, and provider identity after redaction. This should be diagnostic only and must not reset or bypass backoff.
12. Implement disk-space warnings for the relevant project, cache, registry, and Hub/state paths. Use existing thresholds if present; otherwise choose conservative warning-only thresholds localized to the doctor module and document them in code only if not self-evident.
13. Add a shared redaction pass for all readiness output. Redact tokens, API keys, auth headers, secret-looking environment values, user home-sensitive credential paths, and provider payload snippets before text/JSON emission.
14. Keep output stable for tests: deterministic check ordering, stable check IDs, stable status vocabulary, and no wall-clock dependent strings unless tests can inject a clock.
15. Add/adjust tests for the required cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime enabled but unavailable. Include at least one `--json` assertion that proves the output parses and secrets are redacted.
16. Run the narrow relevant test suite first, then the project-standard lint/typecheck/test commands required by the repository. If a full suite is too slow or unrelated failures exist, capture the exact commands and failures in the deliverable.

**Concrete readiness checks to cover**:
- Node presence and version.
- npm presence and version.
- Git presence and version.
- ACP adapter presence.
- ACP adapter version.
- ACP adapter smoke readiness.
- Rust runtime availability when enabled.
- Hub liveness.
- Hub writability.
- Registry consistency.
- Stale jobs.
- Stale workers.
- Stale leases.
- Provider backoff / rate limit state.
- Disk-space warnings.
- Redaction across human and JSON output.

**Test cases to add or update**:
- `cpb doctor --json` returns valid JSON with stable status/check fields and includes the new readiness checks.
- Missing ACP adapter produces a failing readiness check and a useful remediation message without crashing.
- Stale Hub state is detected and reported separately from a live but non-writable Hub.
- Stale worker records are detected using the existing heartbeat/TTL semantics.
- Provider rate-limit/backoff state is surfaced in doctor/report output and does not mutate provider state.
- Rust runtime enabled but unavailable is reported as unavailable; Rust runtime disabled is skipped/not-applicable rather than failed.
- Redaction removes secrets from both text and JSON output.

**Notes and pitfalls**:
- Preserve existing default `cpb doctor` output contract unless tests or existing docs explicitly require a small additive warning/check line.
- Avoid broad cleanup in registry, hub, provider, or adapter modules. Add narrow helper functions only where the doctor/report code needs observable state.
- Do not make doctor mutate registry, clear leases, reset provider backoff, install adapters, or start/stop Hub processes.
- Keep smoke checks cheap and bounded; tests should stub time, file system state, provider state, and adapter resolution rather than depending on the host machine.
- If current tests use fake LLM/provider responders, do not change them merely to pass. Add readiness-specific fixtures/stubs instead.

## Next-Action
Implement the P0.1 `cpb doctor` / report readiness expansion exactly as scoped above, run the relevant tests and project-standard verification, then write `deliverable-099.md` with changed files, evidence, remaining risks, and any verification gaps.

## Acceptance-Criteria
- [ ] `cpb doctor` or the existing report readiness command supports `--json` output without breaking existing default human-readable output.
- [ ] JSON output is valid, deterministic, redacted, and includes structured results for all P0.1 readiness checks.
- [ ] Readiness covers Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is reported as a readiness failure or warning with remediation and no crash.
- [ ] Stale Hub state is detected and distinguished from Hub writability failure.
- [ ] Stale worker records are detected using existing heartbeat/TTL semantics.
- [ ] Provider rate-limit/backoff state is reported without mutating or bypassing the backoff.
- [ ] Rust runtime enabled but unavailable is reported; disabled Rust runtime is skipped/not-applicable rather than failed.
- [ ] Secrets and sensitive values are redacted in both human-readable and JSON output.
- [ ] Tests are added or adjusted for missing adapter, stale Hub, stale worker, rate limit/backoff, Rust unavailable, `--json`, and redaction.
- [ ] Existing behavior outside this P0.1 slice is preserved.
- [ ] No unrelated cleanup or promotion-readiness work beyond P0.1 is included.
- [ ] All relevant tests pass, or any pre-existing/unrelated failures are documented with exact evidence in `deliverable-099.md`.
