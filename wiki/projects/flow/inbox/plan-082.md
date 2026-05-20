# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-082-P0.1-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 readiness-check slice.
- Extend the existing `cpb doctor` / report readiness implementation in place rather than creating a new command surface.
- Add `--json` output as a machine-readable representation of the same readiness checks, preserving current human-readable output behavior by default.
- Model readiness findings with stable status/severity fields so tests can assert behavior without depending on exact prose.
- Redact secrets and sensitive connection details before any human or JSON output is emitted.
- Add focused regression tests for the required failure states: missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, and Rust runtime unavailable.

### Rejected
- Broad cleanup of doctor/report internals is out of scope because the directive explicitly limits implementation to P0.1.
- Adding new dependencies is rejected unless the existing project already has a local helper for the needed behavior.
- Rewriting unrelated readiness/report commands is rejected because existing behavior must be preserved.
- Snapshot-only verification is rejected because readiness output needs targeted assertions for statuses, redaction, and JSON shape.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for promotion readiness P0.1 while preserving existing command behavior and keeping implementation scoped to readiness diagnostics.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; use only the P0.1 requirements as implementation authority.
- Existing CLI command file for `cpb doctor` — add `--json`, wire new checks into the existing command path, and preserve default output.
- Existing report/readiness command or service file — reuse the same readiness-check engine so doctor and report do not drift.
- Existing readiness/doctor domain module, or a new narrowly scoped module next to it if no domain module exists — implement structured checks for toolchain, adapters, Hub, registry, workers/jobs/leases, provider backoff, disk space, Rust runtime, and redaction.
- Existing test files for CLI doctor/report readiness — extend with focused cases.
- New narrowly scoped test file next to existing doctor/readiness tests, only if no suitable test file exists — cover missing adapter, stale Hub, stale worker, rate limit/backoff, Rust unavailable, JSON output, and redaction.

**实现步骤**:
1. Read the P0.1 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and copy its concrete readiness expectations into a short internal checklist before editing; do not implement P1/P2 items.
2. Locate the existing `cpb doctor` and report readiness implementation. Identify the current output contract, current tests, and any helper modules that already inspect Hub, registry, jobs, workers, leases, providers, or runtimes.
3. Introduce or extend a structured readiness result shape with fields equivalent to `id`, `label`, `status`, `severity`, `summary`, `details`, and optional `remediation`. Keep this type local to the doctor/report readiness area unless an equivalent type already exists.
4. Implement Node/npm and Git checks using existing process/tooling helpers. Report missing or non-executable tools as actionable readiness failures, and report discovered versions in both human and JSON output.
5. Implement ACP adapter readiness: presence, version discovery when available, and a minimal smoke-readiness check that verifies the adapter can be invoked or resolved without starting unrelated workflows. Missing adapter must produce a failing readiness item.
6. Implement Rust runtime readiness only when Rust-backed functionality is enabled by existing config/env/feature flags. When enabled and unavailable, emit a failing readiness item; when disabled, emit skipped/not-applicable status rather than failure.
7. Implement Hub checks for liveness and writability using the existing Hub client/storage abstractions. Detect stale Hub state separately from unreachable Hub state so tests can assert stale Hub behavior.
8. Implement registry consistency checks using existing registry readers/writers. Detect mismatched, missing, duplicate, or dangling registry entries without mutating registry state during doctor/report.
9. Implement stale jobs, workers, and leases checks using the repository’s existing staleness thresholds if present; otherwise define small named constants in the readiness module and document that they are diagnostic thresholds. Stale worker coverage is required.
10. Implement provider backoff/rate-limit readiness by reading existing provider state. Active rate-limit/backoff should appear as warning or failing readiness according to existing severity conventions, with retry/backoff timing included after redaction.
11. Implement disk-space warnings for relevant writable paths such as Hub state, registry, logs, or workspace cache. Use an existing disk-space helper if present; otherwise keep the implementation minimal and platform-safe.
12. Add a single redaction utility at the readiness-output boundary if one does not already exist. It must scrub tokens, API keys, authorization headers, credentials in URLs, and sensitive env-like keys from both human and JSON output.
13. Add `--json` to `cpb doctor` and any report readiness command surface required by P0.1. JSON output must be deterministic, parseable, and free of ANSI formatting; default human output should remain compatible with existing tests.
14. Add or adjust tests with isolated fake fixtures/stubs for required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust runtime enabled but unavailable, JSON output shape, and redaction in human and JSON output.
15. Run the repository’s relevant unit tests for doctor/report readiness first, then the broader CLI test target if available. Fix implementation until tests pass without changing fake/mock assets merely to hide production regressions.
16. Write `wiki/projects/flow/outputs/deliverable-082.md` after implementation with changed files, test commands and outputs, behavior notes, and any remaining risks.

**注意事项**:
- Keep changes scoped to P0.1; do not implement other promotion-readiness plan sections.
- Preserve existing default human-readable `cpb doctor` behavior unless P0.1 explicitly requires an added readiness line.
- Do not mutate Hub, registry, jobs, workers, leases, or provider state during readiness checks.
- Prefer existing project helpers for command execution, config, Hub access, registry access, provider state, and redaction.
- Do not add dependencies unless the project already contains no viable local mechanism and the reason is documented in the deliverable.
- Do not edit snapshots, fixtures, mocks, or fake responders just to make tests pass after changing production behavior.
- Keep JSON field names stable and documented in tests.
- Ensure no secrets appear in assertion failures, terminal output, JSON output, or deliverable evidence.

## Next-Action
Implement P0.1 exactly as scoped above, starting from the promotion readiness plan source document. Run the focused readiness tests and the relevant CLI test target, then write `wiki/projects/flow/outputs/deliverable-082.md` with files changed, evidence, risks, and any follow-up recommendations.

## Acceptance-Criteria
- [ ] `cpb doctor --json` produces valid JSON with deterministic readiness check entries and no ANSI formatting.
- [ ] Existing default `cpb doctor` human output remains compatible with prior behavior while including the new P0.1 readiness checks.
- [ ] Doctor/report readiness includes Node version, npm version, Git version, ACP adapter presence, ACP adapter version when available, and ACP adapter smoke readiness.
- [ ] Rust runtime readiness is checked only when Rust-backed functionality is enabled; enabled-but-unavailable Rust is reported as a failing readiness item.
- [ ] Hub liveness and Hub writability are checked without mutating unrelated state.
- [ ] Stale Hub state is detected and covered by a test.
- [ ] Registry consistency problems are reported without modifying registry contents.
- [ ] Stale jobs, stale workers, and stale leases are reported with actionable readiness entries.
- [ ] Stale worker detection is covered by a test.
- [ ] Provider rate-limit/backoff state is reported with severity, provider identity, and retry timing after redaction.
- [ ] Provider rate-limit/backoff behavior is covered by a test.
- [ ] Disk-space warnings are emitted for relevant writable state paths when space is below the chosen threshold.
- [ ] Human and JSON outputs redact secrets, credentials, tokens, API keys, authorization headers, and sensitive URL credentials.
- [ ] Missing ACP adapter is covered by a test.
- [ ] Rust enabled but unavailable is covered by a test.
- [ ] Relevant doctor/report readiness tests pass.
- [ ] No unrelated cleanup, broad refactor, dependency churn, or behavior expansion outside P0.1 is included.
