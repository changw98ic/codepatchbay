## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-098-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth, but implement only P0.1.
- Expand existing `cpb doctor` and/or `cpb report` readiness logic in place rather than adding a parallel readiness subsystem.
- Preserve existing human-readable output and exit behavior unless the P0.1 plan explicitly requires a stricter readiness failure.
- Add `--json` output using a stable structured schema suitable for tests and automation.
- Readiness checks should be composable check results with severity, status, evidence, remediation, and redacted diagnostic details.
- Redaction is part of the feature, not a presentation afterthought: all output paths that can expose tokens, API keys, auth headers, URLs with credentials, or provider secrets must pass through one shared redaction path before printing or JSON serialization.
- Tests must cover the explicitly requested failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad cleanup or unrelated doctor/report refactors | The primary directive requires this P0 slice only.
- Replacing current CLI output wholesale | Existing behavior must be preserved; `--json` should be additive.
- Adding new dependencies for command discovery, semver parsing, disk checks, or redaction | The repo instruction says no new dependencies without explicit request.
- Mutating fake/mock tests only to force green tests | If a fake no longer reflects the real readiness workflow, update production-facing test scaffolding intentionally and document why.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` readiness coverage for promotion P0.1 while preserving existing behavior and adding targeted automated tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read first; source of truth for P0.1 wording, expected severity, and any readiness/report contract details.
- CLI entrypoint files for `cpb doctor` and `cpb report` — Add/route the `--json` option and wire readiness checks into existing command flow.
- Existing doctor/report readiness modules — Extend the current check model instead of creating a duplicate system.
- Existing ACP adapter discovery/version/smoke-readiness code — Reuse current adapter resolution where possible; add a readiness check for missing adapter, version evidence, and smoke readiness.
- Existing Hub client/state modules — Reuse existing Hub liveness, filesystem/path, registry, job, worker, and lease primitives for readiness checks.
- Existing provider/backoff modules — Surface provider rate-limit/backoff state without changing provider behavior.
- Existing Rust runtime configuration/probe modules — Check Rust availability only when Rust runtime is enabled.
- Existing test files for doctor/report/CLI readiness — Add or adjust tests for the requested scenarios with minimal fixture changes.
- Test helpers/fixtures only where needed — Add narrowly scoped helpers for fake clock, stale timestamps, filesystem writability, and command/runtime probe outcomes.

**实现步骤**:
1. Read the P0.1 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and record any exact status names, severity rules, JSON shape expectations, and non-goals before editing.
2. Locate the existing `cpb doctor` and `cpb report` command paths, readiness/check abstractions, output formatting, and test coverage. Identify the smallest shared place to add readiness checks so both commands remain consistent.
3. Define or extend a readiness result contract if one already exists. Each check should expose at least `id`, `label`, `status`, `severity`, `summary`, `evidence`, `remediation`, and optional `details`. Keep statuses machine-stable, such as `ok`, `warn`, `fail`, and `skip`.
4. Add `--json` to the relevant command parser(s). Human output should remain the default. JSON output should serialize the same readiness result data, include an overall status, and avoid ANSI/color formatting.
5. Implement Node/npm and Git checks by reusing existing process/runtime utilities. Report command presence and version when available. Missing required tooling should fail; suspicious or unavailable version evidence should warn only if existing behavior already treats it as non-fatal.
6. Implement ACP adapter readiness:
   - Detect adapter presence through the existing adapter discovery path.
   - Include adapter name/path and version evidence when available.
   - Add a lightweight smoke readiness probe that does not perform destructive work.
   - Redact paths or diagnostic strings if they can contain credentials.
   - Missing adapter must be covered by a failing readiness test.
7. Implement Rust runtime readiness only behind the existing Rust-enabled configuration flag. When enabled, check required binary/runtime availability and version evidence. When disabled, return `skip` rather than warning. Add the Rust-unavailable test for the enabled case.
8. Implement Hub liveness and writability checks using existing Hub paths/configuration:
   - Verify the Hub responds or can be reached through the existing local mechanism.
   - Verify required Hub storage paths are writable with non-destructive create/remove or existing safe writability helpers.
   - Surface stale Hub state using the repo's timestamp/heartbeat conventions.
   - Add a stale-Hub test.
9. Implement registry consistency checks. Compare registered projects/adapters/workers/jobs against the existing registry schema and flag missing referenced paths, malformed entries, duplicate IDs, or broken references. Keep repair out of scope unless current doctor/report already has a repair mode.
10. Implement stale jobs, workers, and leases checks using existing heartbeat/lease TTL conventions. Report stale workers and abandoned leases as warnings or failures according to the promotion plan. Add the stale-worker test explicitly requested.
11. Implement provider backoff readiness. Surface active rate-limit/backoff state with provider name, retry/backoff timing, and redacted diagnostics. Do not alter retry behavior. Add the rate-limit/backoff test.
12. Implement disk-space warnings for relevant Hub/project/runtime paths. Use existing filesystem utilities or platform APIs already in the repo. Treat low disk as warning unless the P0.1 source plan says it is fatal.
13. Add a shared redaction helper or extend the existing one. Apply it to all human and JSON output evidence/details. Tests should assert that obvious secret patterns do not leak in both output modes.
14. Update tests:
   - `--json` emits parseable JSON with overall status and check entries.
   - Missing ACP adapter is reported.
   - Stale Hub state is reported.
   - Stale worker state is reported.
   - Provider rate-limit/backoff state is reported.
   - Rust unavailable is reported only when Rust runtime is enabled.
   - Redaction applies to human and JSON output.
   - Existing doctor/report baseline behavior remains intact.
15. Run the repo's focused doctor/report tests first, then the standard verification suite required by this project. If a full suite is too slow or blocked, capture the exact command, failure, and reason in the deliverable.
16. Write `deliverable-098.md` after implementation with changed files, tests run, evidence, and any remaining risks.

**注意事项**:
- Keep changes scoped to P0.1. Do not implement neighboring promotion readiness items from the source plan.
- Do not broaden into unrelated cleanup, CLI restructuring, formatting churn, dependency updates, or snapshot rewrites.
- Preserve existing behavior for non-JSON output unless a new readiness check naturally adds an additional line/status.
- Avoid destructive probes. Smoke checks must not mutate user projects, registry state, providers, or Hub data beyond safe temporary writability probes.
- Make stale-state tests deterministic with fake time or injectable clocks rather than sleeping.
- Keep provider tests local; do not call real providers.
- If existing fixtures/fakes conflict with the real workflow, document the mismatch instead of weakening production checks.

## Next-Action
Implement only TASK-098 P0.1 according to the steps above. Start by reading the promotion readiness source plan, then make the smallest production and test changes needed for expanded `cpb doctor` / `cpb report` readiness checks. Run focused and standard verification. When complete, write `deliverable-098.md` with the changed files, evidence, and risks.

## Acceptance-Criteria
- [ ] `cpb doctor` and/or `cpb report` support additive `--json` output for readiness results without breaking default human-readable output.
- [ ] Readiness output includes Node/npm and Git presence/version checks.
- [ ] Readiness output includes ACP adapter presence, version evidence, and non-destructive smoke readiness.
- [ ] Rust runtime readiness is checked when Rust runtime is enabled and skipped when disabled.
- [ ] Hub readiness includes liveness, storage writability, and stale Hub detection.
- [ ] Registry consistency is checked for malformed, duplicate, missing, or broken references using the existing registry schema.
- [ ] Stale jobs, workers, and leases are detected using existing heartbeat/TTL conventions.
- [ ] Provider backoff/rate-limit state is surfaced without changing provider retry behavior.
- [ ] Disk-space warnings are emitted for relevant Hub/project/runtime paths.
- [ ] Human and JSON output redact secrets, credentials, API keys, auth headers, and credential-bearing URLs.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust unavailable when enabled, `--json` shape, and redaction.
- [ ] Existing doctor/report behavior and tests continue to pass.
- [ ] No unrelated cleanup, dependency additions, fixture churn, or broad refactors are included.
