## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-011
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.1 readiness-check slice.
- Extend the existing `cpb doctor` and report readiness surfaces instead of creating a new command or unrelated health subsystem.
- Add a machine-readable `--json` output path while preserving the current human-readable output as the default behavior.
- Represent readiness checks as structured results with stable IDs, severity/status, human message, optional metadata, and redacted diagnostics.
- Keep ACP adapter checks non-destructive: detect presence/version and run only the smallest available smoke-readiness check that does not mutate user state.
- Gate Rust runtime checks behind the existing Rust-enabled configuration or runtime flag; when Rust is disabled, report skipped/not-applicable rather than failure.
- Treat Hub checks as readiness probes for liveness and writable state, including stale Hub/job/worker/lease detection, without deleting or repairing state in this P0.1 slice.
- Add tests that cover both CLI/report behavior and structured result details for the explicitly requested failure modes.

### Rejected
- Broaden into automated repair of stale jobs/workers/leases; P0.1 asks for readiness checks and warnings, not mutation.
- Replace existing doctor/report formatting wholesale; that risks behavior drift outside the requested P0 slice.
- Introduce new runtime dependencies for system probing or JSON formatting; use existing project utilities and standard libraries.
- Edit fake/mock fixtures only to force green tests; update tests only where they verify the new intended doctor/report readiness behavior.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for promotion-readiness P0.1 while preserving existing behavior, adding JSON output, redaction, and focused tests for requested readiness failures.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the P0.1 scope; do not modify.
- Existing CLI entrypoint for `cpb doctor` — add `--json` flag parsing and route output through shared readiness result serialization.
- Existing report/readiness command or report generation module — include the expanded readiness checks in report output without changing unrelated report sections.
- Existing doctor/readiness check module(s) — add Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale state, provider backoff, disk-space, and redaction checks.
- Existing configuration/runtime detection module(s) — reuse current project settings to decide whether Rust runtime checks are enabled and where Hub/registry/provider state lives.
- Existing test files for CLI doctor/report behavior — add focused coverage for `--json`, redaction, and requested failure cases.
- New test file only if no suitable doctor/report test file exists — keep it colocated with the existing test style and limited to P0.1 readiness checks.

**实现步骤**:
1. Inspect the promotion readiness plan and existing `cpb doctor` / report implementation.
   - Confirm the exact existing command names, output format, configuration helpers, Hub paths, registry state, provider backoff state, and test framework.
   - Identify the smallest shared readiness-result shape already present; if none exists, introduce a narrow internal type local to doctor/report readiness.

2. Add or extend structured readiness result modeling.
   - Use stable check IDs such as `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub`, `registry`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, `disk_space`.
   - Preserve existing pass/fail semantics and add warning/skipped statuses only where they already match project conventions or are necessary for P0.1.
   - Ensure each result can render to both the current human output and JSON without duplicating check logic.

3. Implement `cpb doctor --json`.
   - Keep plain `cpb doctor` output compatible with existing tests and user expectations.
   - Emit valid JSON only on stdout for `--json`, with no banners, progress text, ANSI escapes, or unredacted secrets.
   - Include enough fields for automation: overall status, generated timestamp if existing patterns allow it, check list, status/severity/message, and redacted metadata.

4. Implement Node/npm and Git readiness checks.
   - Detect executable availability and version using existing command/process helpers.
   - Report missing executable as a failing or warning readiness result according to existing doctor severity conventions.
   - Do not install, update, or modify Node/npm/Git.

5. Implement ACP adapter readiness checks.
   - Check adapter presence using the project’s existing ACP adapter resolution path.
   - Capture adapter version when available.
   - Add a smoke-readiness probe that verifies the adapter can be invoked or initialized without mutating project/user state.
   - Surface missing adapter as a clear readiness failure in both human and JSON output.

6. Implement Rust runtime readiness when enabled.
   - Reuse existing Rust-enabled config/feature flag detection.
   - When enabled, verify required Rust runtime binary/library availability and minimum smoke readiness.
   - When disabled, mark the check skipped/not-applicable rather than failed.
   - Cover the Rust-enabled-but-unavailable path in tests.

7. Implement Hub liveness and writability checks.
   - Probe the configured Hub location/process using existing Hub client/state helpers.
   - Verify the Hub is reachable/alive and that the required state directory or backing store is writable.
   - Detect stale Hub state without attempting repair.
   - Keep error messages actionable but redact paths/tokens where project redaction rules require it.

8. Implement registry consistency checks.
   - Validate that the Hub registry/project registry entries are internally consistent with the current project attachment.
   - Detect missing, duplicate, orphaned, or malformed registry entries only within the existing registry model.
   - Report inconsistencies as readiness warnings/failures without rewriting registry state.

9. Implement stale jobs/workers/leases checks.
   - Reuse existing state files/tables and timeout/staleness definitions if present.
   - If no single timeout exists, add a narrow constant near the readiness check and document it through the check message, not broad docs.
   - Report stale job, worker, and lease counts plus redacted identifiers in JSON metadata.
   - Add specific test coverage for stale worker detection and stale Hub/state detection.

10. Implement provider backoff readiness.
   - Inspect existing provider/rate-limit/backoff state.
   - Report active backoff or rate-limit cooldown as a warning/failure consistent with existing severity policy.
   - Include provider name and remaining cooldown when safe, with secrets redacted.
   - Add test coverage for rate-limit/backoff reporting.

11. Implement disk-space warnings.
   - Check available disk space for the project/HUB/state paths using existing filesystem utilities or standard library calls.
   - Warn below the project’s existing threshold if one exists; otherwise use a conservative internal threshold and keep it configurable only if current patterns already support that.
   - Avoid noisy failures when disk-space probing is unsupported; return skipped/warning with a diagnostic reason.

12. Apply redaction consistently.
   - Route all readiness messages and JSON metadata through existing redaction utilities.
   - Redact tokens, API keys, auth headers, provider credentials, home-sensitive paths if existing policy requires it, and adapter command arguments that may contain secrets.
   - Add a regression test that proves JSON output does not leak a representative secret.

13. Add and adjust tests for the requested P0.1 cases.
   - Missing ACP adapter appears in doctor/report and `--json`.
   - Stale Hub/state is detected without mutation.
   - Stale worker is detected and counted.
   - Provider rate limit/backoff is reported with redacted metadata.
   - Rust runtime enabled but unavailable is reported correctly.
   - `cpb doctor --json` parses as JSON and contains the expanded checks.
   - Existing doctor/report behavior still passes.

14. Run focused verification after implementation.
   - Run the existing doctor/report test suite and any new focused tests.
   - Run the project’s normal lint/typecheck/test commands required for this touched area.
   - Manually verify, if feasible, `cpb doctor` human output and `cpb doctor --json` JSON output against a controlled fixture or temporary state.

**注意事项**:
- Do not implement other promotion readiness items beyond P0.1.
- Do not add cleanup/refactor work except the minimum extraction needed to share readiness checks between doctor and report.
- Do not mutate Hub, registry, jobs, workers, leases, provider backoff, or runtime installation state during checks.
- Do not introduce new dependencies.
- Preserve existing command exit-code behavior unless existing tests or the promotion plan explicitly require a readiness-failure exit-code change.
- Keep JSON schema stable and documented in tests through assertions on explicit keys.
- Prefer existing project utilities for command execution, redaction, filesystem paths, Hub clients, and registry parsing.

## Next-Action
Implement the scoped P0.1 readiness-check expansion exactly as described above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Keep changes limited to the existing doctor/report readiness path, add focused tests, run verification, then write `deliverable-011.md` with changed files, evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` exists, emits parseable JSON only, and preserves default human-readable `cpb doctor` behavior.
- [ ] Doctor/report readiness output includes Node, npm, Git, ACP adapter, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warning, and redaction coverage.
- [ ] Missing ACP adapter is reported in human and JSON readiness output with a stable check ID and actionable redacted message.
- [ ] Stale Hub/state is detected and reported without mutating or repairing Hub state.
- [ ] Stale worker detection reports count/details safely and is covered by a focused test.
- [ ] Provider rate-limit/backoff state is reported with sensitive values redacted and is covered by a focused test.
- [ ] Rust runtime enabled but unavailable is reported correctly; Rust disabled is skipped/not-applicable rather than failed.
- [ ] Registry consistency failures are represented as readiness results without rewriting registry state.
- [ ] Disk-space warnings are emitted below threshold and do not crash on unsupported platforms.
- [ ] Readiness JSON output contains no representative secrets, tokens, auth headers, or unredacted sensitive adapter/provider values.
- [ ] Tests cover missing adapter, stale Hub/state, stale worker, rate limit/backoff, Rust unavailable, `--json` serialization, and redaction.
- [ ] Existing doctor/report tests continue to pass.
- [ ] Implementation changes remain scoped to P0.1 and do not broaden into unrelated cleanup or other promotion-readiness slices.
