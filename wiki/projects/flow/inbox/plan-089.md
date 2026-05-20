# Plan: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-089
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 readiness-check slice.
- Keep the change scoped to existing `cpb doctor` / report readiness-check surfaces and their tests; preserve current human-readable behavior while adding machine-readable `--json` output.
- Use existing command, diagnostic, logging, redaction, registry, hub, provider, and test helper patterns already present in the repository instead of introducing new dependencies or broad cleanup.
- Model readiness checks as structured findings with stable identifiers, severity/status, redacted detail, remediation text where applicable, and JSON-safe payloads.
- Ensure JSON output is deterministic and parseable, with all sensitive values redacted before serialization.
- Add focused regression tests for the required failure/warning scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad refactor of doctor/report internals | Outside P0.1 and risks unrelated behavior changes.
- Adding a new diagnostics framework or dependency | The slice should reuse existing patterns and stay reviewable.
- Replacing current text output with JSON-only output | Existing behavior must be preserved; `--json` is additive.
- Shelling out in tests to real Node/npm/Git/Rust/Hub services | Tests should use existing stubs/fakes or dependency injection to stay deterministic.
- Editing fake/mock assets only to force tests to pass | If a fake no longer represents the real workflow, report the mismatch and validate with a purpose-built test path.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for promotion-readiness P0.1, adding `--json` output and the required environment, adapter, runtime, Hub, registry, stale-state, provider-backoff, disk-space, and redaction coverage while preserving existing CLI behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Source-of-truth reference only; do not edit.
- Existing `cpb doctor` command module(s) — Add/route `--json`, assemble readiness checks, and preserve current text output.
- Existing report/readiness diagnostic module(s) — Extend structured checks for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- Existing ACP adapter integration/config module(s) — Expose adapter presence/version/smoke readiness using current adapter discovery conventions.
- Existing Hub client/state module(s) — Check Hub liveness and writability and detect stale Hub state without making destructive changes.
- Existing registry module(s) — Validate registry consistency using current persisted registry format and invariants.
- Existing job/worker/lease state module(s) — Detect stale jobs, workers, and leases using current TTL/staleness rules or add narrowly scoped constants where none exist.
- Existing provider/backoff module(s) — Surface active rate-limit/backoff state in readiness findings.
- Existing Rust runtime feature/config module(s) — Check Rust availability only when Rust runtime is enabled.
- Existing test files for CLI doctor/report/readiness diagnostics — Add or adjust focused tests for required scenarios and JSON output.

**实现步骤**:
1. Read the promotion readiness plan and locate the current `cpb doctor`, report, readiness, Hub, registry, adapter, provider, Rust runtime, and test modules.
   - Expected output: a minimal file map and confirmation of the exact existing extension points.
2. Add a structured readiness result shape if one already does not exist.
   - Include fields suitable for both text and JSON: stable `id`, `status`/`severity`, `message`, optional `details`, optional `remediation`, and optional redacted metadata.
   - Keep the shape local to current diagnostics/readiness boundaries.
3. Add `--json` support to the existing `cpb doctor` / report command path.
   - Preserve existing default text output.
   - Ensure `--json` prints valid JSON only, exits with the same success/failure semantics as text mode, and is deterministic enough for tests.
4. Implement environment readiness checks.
   - Node: report presence and version.
   - npm: report presence and version.
   - Git: report presence and version.
   - Disk space: warn when available space falls below the repository's existing warning threshold, or add a narrow constant if no threshold exists.
5. Implement ACP adapter readiness checks.
   - Check adapter presence using existing discovery/config.
   - Report adapter version when available.
   - Add a smoke-readiness check that verifies the adapter can be resolved/loaded or otherwise proves it is usable without performing irreversible side effects.
   - Missing adapter must be a test-covered failure/warning according to existing doctor severity conventions.
6. Implement Rust runtime readiness check.
   - Run only when the Rust runtime is enabled by existing config/feature flag.
   - Report unavailable Rust runtime as a readiness finding.
   - Do not require Rust when the Rust runtime is disabled.
7. Implement Hub readiness checks.
   - Check liveness through the existing Hub health/status path.
   - Check writability through the least invasive existing write probe or a temp/probe mechanism that cleans up after itself.
   - Detect stale Hub state using existing timestamp/heartbeat/state metadata.
   - Cover stale Hub behavior with a focused test.
8. Implement registry consistency checks.
   - Validate persisted registry entries against the current registry invariants.
   - Report missing, duplicate, orphaned, or internally inconsistent records with redacted details.
   - Avoid mutating or repairing registry state in doctor/report.
9. Implement stale jobs/workers/leases checks.
   - Use existing job, worker, and lease TTL or heartbeat semantics.
   - Report stale jobs, stale workers, and stale leases separately with stable IDs.
   - Cover stale worker behavior with a focused test.
10. Implement provider backoff/rate-limit readiness.
    - Surface active provider backoff and rate-limit state as warning or degraded status using existing provider/backoff state.
    - Cover rate-limit/backoff behavior with a focused test.
11. Apply redaction consistently.
    - Reuse existing redaction helpers.
    - Ensure text and JSON output do not expose tokens, API keys, credentials, private URLs with embedded credentials, home-directory-sensitive paths where existing policy redacts them, or raw provider secrets.
    - Add or update tests that assert sensitive sample values are absent from `--json` and text output.
12. Add/adjust tests.
    - Include `--json` parseability and schema/content coverage.
    - Include required scenario tests: missing adapter, stale Hub, stale worker, rate limit/provider backoff, Rust unavailable when enabled.
    - Add focused tests for Node/npm/Git and disk-space warnings if existing test coverage does not already prove them.
13. Run the repository's relevant test commands and any existing lint/typecheck commands for this slice.
    - If a broad suite is too expensive, run the narrow doctor/report/readiness suites first, then the standard verification command expected by the project.
14. Write `deliverable-089.md` after implementation.
    - Include changed files, simplifications made, test evidence, known gaps, and any source-plan details that could not be implemented without widening scope.

**注意事项**:
- Do not broaden into unrelated cleanup, renames, formatting sweeps, dependency changes, or command restructuring.
- Do not edit the promotion readiness plan unless explicitly instructed.
- Preserve current non-JSON CLI output and exit behavior except where P0.1 readiness checks intentionally add new findings.
- Keep all readiness probes read-only or reversible; doctor/report must not repair state.
- Use dependency injection, existing fakes, temp directories, or local state fixtures for tests instead of relying on the developer machine's real environment.
- If an existing fake/test double conflicts with the intended real workflow, report the mismatch in the deliverable rather than weakening production behavior.

## Next-Action
Implement the scoped P0.1 readiness-check expansion above, run focused and standard verification, then write `deliverable-089.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor` / report retains existing default human-readable behavior.
- [ ] `cpb doctor` / report supports `--json` and emits valid, deterministic, redacted JSON.
- [ ] JSON output includes structured readiness findings with stable IDs, status/severity, messages, and relevant redacted details.
- [ ] Readiness checks include Node presence/version and npm presence/version.
- [ ] Readiness checks include Git presence/version.
- [ ] Readiness checks include ACP adapter presence, adapter version when available, and smoke readiness.
- [ ] Readiness checks include Rust runtime availability only when Rust runtime is enabled.
- [ ] Readiness checks include Hub liveness and writability.
- [ ] Readiness checks include registry consistency validation.
- [ ] Readiness checks include stale jobs, stale workers, and stale leases.
- [ ] Readiness checks include provider rate-limit/backoff state.
- [ ] Readiness checks include disk-space warnings.
- [ ] Text and JSON outputs redact secrets and sensitive values.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub.
- [ ] Tests cover stale worker.
- [ ] Tests cover provider rate-limit/backoff.
- [ ] Tests cover Rust unavailable when Rust runtime is enabled.
- [ ] Relevant doctor/report/readiness tests pass.
- [ ] Relevant lint/typecheck/static checks pass, or any unavailable checks are explicitly reported in `deliverable-089.md`.
- [ ] Changed files are limited to this P0.1 slice and preserve existing behavior outside the new readiness checks.
