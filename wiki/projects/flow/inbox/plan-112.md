## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-112
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative requirement document before editing any production code.
- Implement only P0.1 readiness expansion for `cpb doctor` / `cpb report`; do not perform unrelated cleanup, CLI rewrites, dependency changes, formatting sweeps, or broader promotion tasks.
- Preserve existing human-readable command behavior while adding machine-readable `--json` output.
- Centralize readiness check collection behind a reusable result model so `doctor`, `report`, human output, JSON output, and tests exercise the same checks.
- All readiness output must redact secrets and sensitive paths/tokens consistently in both text and JSON.
- Tests must cover the specified P0.1 failure modes with deterministic fakes/stubs rather than relying on the developer machine environment.

### Rejected
- Rejected implementing other P0/P1/P2 items from the promotion plan because the task explicitly scopes this handoff to P0.1 only.
- Rejected adding new runtime dependencies because the workspace guidance requires no new dependencies without an explicit request.
- Rejected shelling out directly from tests to real Node, npm, Git, Rust, Hub, or providers because that would make readiness tests machine-dependent and flaky.
- Rejected modifying fake/mock tests merely to hide production changes; fakes may be adjusted only when they are purpose-built fixtures for the new readiness scenarios.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` readiness diagnostics for promotion P0.1, including `--json`, required local tool checks, adapter readiness, optional Rust readiness, Hub state, registry/state consistency, stale runtime records, provider backoff/rate-limit visibility, disk-space warnings, redaction, and focused regression tests.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read first. Implement only the P0.1 requirements. If this plan file and the source document disagree, follow the source document and record the deviation in the deliverable.

**Likely involved files**:
- CLI command entrypoints for `cpb doctor` and `cpb report` — add/route `--json` and call the shared readiness collector.
- Existing readiness/doctor/report modules, or a new narrowly scoped module near them — implement structured checks and result aggregation.
- Existing Hub/client/state modules — add non-destructive liveness, writability, stale job/worker/lease, registry consistency, and stale Hub detection checks by reusing existing APIs.
- Existing provider/backoff modules — expose read-only readiness state for rate-limit/backoff warnings without changing provider behavior.
- Existing ACP adapter integration/config modules — check adapter presence, discover version when available, and perform a lightweight smoke-readiness probe that does not mutate user data.
- Existing Rust runtime feature/config module — check Rust runtime only when enabled and report unavailable/misconfigured status as a warning or error according to existing readiness severity patterns.
- Existing redaction/sanitization utilities — reuse them for all text and JSON output; add a helper only if no shared sanitizer exists.
- Existing CLI tests for doctor/report plus focused new tests — cover `--json` schema and the required failure/warning scenarios.

**Implementation steps**:
1. Read the promotion readiness plan and map only P0.1 into a local checklist.
   - Confirm the required severity semantics for each check: error, warning, or info.
   - Identify existing doctor/report tests and current command output expectations before editing.

2. Locate the current `cpb doctor` and `cpb report` implementation.
   - Preserve existing flags and default text output.
   - Add `--json` parsing to both commands if both commands expose readiness data, or to the command(s) required by the source plan.
   - Ensure unknown flags and existing command exit behavior remain compatible.

3. Introduce or extend a shared readiness result model.
   - Shape each check as structured data with stable fields such as `id`, `label`, `status`, `severity`, `message`, `details`, and optional `remediation`.
   - Include aggregate summary fields for JSON such as total checks, counts by status/severity, and overall readiness.
   - Keep IDs stable and explicit, for example `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub_liveness`, `hub_writability`, `registry_consistency`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, and `disk_space`.

4. Implement local tool readiness checks.
   - Check Node presence and version.
   - Check npm presence and version.
   - Check Git presence and version.
   - Use existing command-runner/process abstraction if present so tests can stub results.
   - Do not make version thresholds stricter than the source plan or existing project requirements.

5. Implement ACP adapter readiness.
   - Detect adapter presence through the project’s existing adapter configuration/discovery path.
   - Report adapter version when available.
   - Add a smoke-readiness check that validates the adapter can be resolved/initialized or queried in a lightweight read-only way.
   - Return a clear missing-adapter result without crashing when the adapter is absent.

6. Implement Rust runtime readiness only when enabled.
   - Reuse existing feature flag/config detection for Rust runtime enablement.
   - When enabled, verify the runtime binary/library/path is available and runnable enough for a smoke-readiness result.
   - When disabled, report skipped/info status rather than warning.
   - Preserve existing non-Rust workflows.

7. Implement Hub and registry checks.
   - Check Hub liveness using the existing Hub client/health path.
   - Check Hub writability with the lightest non-destructive write/read/delete or existing capability probe available. Avoid leaving persistent records behind.
   - Detect stale Hub state according to existing timestamps/heartbeat conventions.
   - Validate registry consistency between configured registry/project records and Hub-known project/session/worker records.

8. Implement stale jobs, workers, and leases checks.
   - Reuse existing state storage APIs and stale thresholds from production code where available.
   - Report stale jobs, stale workers, and stale leases separately so operators can see the specific failure domain.
   - Include counts and redacted identifiers in JSON details.
   - Do not automatically delete or mutate stale records in doctor/report.

9. Implement provider backoff/rate-limit visibility.
   - Read current provider backoff/rate-limit state from existing provider state/cache.
   - Report active backoff, retry-after, or rate-limit status as a warning with provider name redacted if it can contain user data.
   - Do not reset backoff or change provider scheduling behavior.

10. Implement disk-space warnings.
   - Check relevant storage locations already used by CPB/Hub/state/registry.
   - Warn below the threshold defined in the source plan or the existing project convention.
   - Include free/required space in JSON details without exposing sensitive absolute paths unless existing doctor output already does so safely.

11. Apply redaction to all readiness output.
   - Ensure tokens, API keys, auth headers, bearer strings, secrets, home-directory-sensitive paths, and provider credentials are redacted before formatting.
   - Add regression coverage proving both text and JSON paths redact sensitive values.
   - Prefer existing sanitizer utilities; if adding one, keep it small and colocated with current output/reporting utilities.

12. Add/adjust tests for the required P0.1 scenarios.
   - Missing ACP adapter: command returns structured failed/error readiness without throwing.
   - Stale Hub: stale Hub state is reported with the correct severity and JSON id.
   - Stale worker: stale worker records are reported without cleanup side effects.
   - Rate limit/provider backoff: active backoff is reported as a warning with retry metadata and redacted sensitive values.
   - Rust unavailable: when Rust runtime is enabled but unavailable, readiness reports the expected warning/error; when disabled, the check is skipped/info.
   - `--json`: output parses as JSON, contains stable check IDs, aggregate status, and no unredacted secrets.

13. Run focused verification.
   - Run the relevant unit tests for doctor/report/readiness.
   - Run the existing CLI test suite that covers `cpb doctor` and `cpb report`.
   - Run lint/typecheck/build commands that are standard for this repository if available.
   - Do not update snapshots broadly; only update expected output snapshots when they directly represent the intended new P0.1 output.

**注意事项**:
- Keep the diff small and localized to readiness/doctor/report surfaces.
- Preserve existing behavior for default human-readable output except for the intentional addition of new readiness rows/warnings.
- Do not change runtime cleanup behavior; doctor/report must diagnose stale records, not repair them.
- Do not introduce new dependencies.
- Avoid relying on actual machine-installed Node/npm/Git/Rust in tests; use fakes or dependency injection.
- If a check cannot be implemented exactly because an underlying API does not exist, add the smallest read-only adapter needed and document the gap in the deliverable.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above. After implementation, run focused tests and standard verification, then write `deliverable-112.md` with changed files, test evidence, simplifications made, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation first reconciles against `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and remains limited to P0.1.
- [ ] `cpb doctor` and/or `cpb report` support `--json` as required by the source plan, with valid parseable JSON and stable readiness check IDs.
- [ ] Readiness checks include Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Default human-readable output remains backward compatible except for the newly required readiness diagnostics.
- [ ] Missing ACP adapter is reported as a structured readiness failure/error without an uncaught exception.
- [ ] Stale Hub state is detected and reported with the expected severity.
- [ ] Stale worker records are detected and reported without mutating or deleting worker state.
- [ ] Active provider rate-limit/backoff state is reported with retry/backoff details and no behavior change to provider scheduling.
- [ ] Rust unavailable is reported only when Rust runtime is enabled; disabled Rust runtime produces skipped/info behavior rather than a failure.
- [ ] All text and JSON output goes through redaction and tests prove representative secrets/tokens/credentials are not leaked.
- [ ] Tests are added or adjusted for missing adapter, stale Hub, stale worker, rate limit/provider backoff, Rust unavailable, and `--json` output.
- [ ] Existing behavior is preserved for unrelated doctor/report functionality.
- [ ] Relevant tests, lint/typecheck/build verification pass, or any unavailable verification is explicitly documented in `deliverable-112.md`.
- [ ] Code style remains consistent with the existing project and no unrelated cleanup or dependency additions are included.
