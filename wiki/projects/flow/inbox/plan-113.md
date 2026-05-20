## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-113
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for wording, scope, and priority, but implement only P0.1.
- Expand the existing `cpb doctor` / readiness report path rather than creating a separate readiness command.
- Add machine-readable `--json` output while preserving existing human-readable output as the default behavior.
- Model readiness checks as structured results with severity, stable IDs, redacted messages, and optional remediation hints so CLI and JSON output share one source of truth.
- Include redaction as part of report generation, not as a caller responsibility.
- Add focused tests for required failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when Rust is enabled.
- Keep the change scoped to readiness/doctor/report code and directly related tests.

### Rejected
- Rejected broad cleanup or CLI restructuring because the directive explicitly limits this slice to P0.1.
- Rejected changing fake/mock responders only to make tests pass; test doubles may be adjusted only where they directly represent readiness dependencies for this P0.1 slice.
- Rejected introducing new dependencies for process checks, disk checks, or JSON formatting; use existing project utilities and standard runtime APIs.
- Rejected making Rust runtime checks unconditional because the requirement says Rust runtime readiness applies when enabled.
- Rejected leaking raw environment values, tokens, adapter paths with embedded credentials, provider keys, Hub URLs containing credentials, or command output secrets in either text or JSON reports.

### Scope

**目标**: Implement P0.1 by expanding `cpb doctor` / readiness report checks to cover runtime prerequisites, adapter readiness, Hub health, registry and stale-state consistency, provider backoff, disk warnings, JSON output, redaction, and regression tests while preserving current behavior outside this readiness surface.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; use it to confirm exact P0.1 boundaries before editing.
- CLI entrypoint for `cpb doctor` / report readiness command — add or wire `--json` without changing default output semantics.
- Existing doctor/readiness report module(s) — add structured check definitions and shared report rendering.
- Existing environment/runtime utility module(s), if present — reuse for Node/npm, Git, Rust, disk, process, and filesystem checks.
- Existing ACP adapter discovery module(s), if present — reuse to detect adapter presence/version and perform a smoke-readiness check.
- Existing Hub client/state module(s), if present — reuse to check liveness, writability, registry consistency, stale jobs/workers/leases, and provider backoff state.
- Existing redaction/secrets utility, if present — reuse or minimally extend for report-safe text and JSON output.
- Readiness/doctor test files — add or adjust focused tests for JSON shape and required failure scenarios.

**实现步骤**:
1. Read the promotion readiness plan and identify the exact P0.1 acceptance language. Confirm no P1/P2 or unrelated cleanup items are being pulled into this change.
2. Locate the existing `cpb doctor` and report readiness implementation, its CLI option parsing, and its current tests. Preserve the current default text output and exit-code behavior unless the P0.1 source plan explicitly requires a change.
3. Introduce a shared structured readiness result shape if one does not already exist. Each check should produce a stable `id`, `status` such as `ok` / `warning` / `error` / `skipped`, short redacted `message`, optional redacted `details`, and optional remediation metadata. Use existing project naming conventions.
4. Add `--json` support to `cpb doctor` / report readiness. JSON output should be deterministic, parseable, redacted, and include overall status plus the per-check results. Do not print extra human text when `--json` is selected.
5. Add Node/npm and Git checks. Verify executable presence and version collection using existing command/runtime helpers where available. Missing required tooling should become an error; unsupported or suspicious versions should follow the source plan's severity guidance.
6. Add ACP adapter readiness checks. Cover adapter presence, version visibility when available, and a minimal smoke-readiness path that verifies the adapter can be discovered/invoked far enough to prove readiness without performing destructive work.
7. Add Rust runtime readiness gated on the existing Rust-enabled configuration flag or equivalent project setting. When Rust is disabled, report skipped/omitted according to existing report style. When enabled and unavailable, report the required error.
8. Add Hub readiness checks for liveness and writability. Use existing Hub APIs/state files where possible. Writability should prove the Hub can write to its expected state location without corrupting existing state; prefer existing temp/probe conventions if present.
9. Add registry consistency checks. Validate that registered projects/workers/providers referenced by readiness state are internally consistent and point to expected existing records. Report inconsistencies without attempting repair in this P0.1 slice.
10. Add stale-state checks for jobs, workers, and leases. Reuse existing timeout/TTL definitions if present. If no central constants exist, add narrowly scoped constants near readiness logic and document why they match the source plan.
11. Add provider backoff/rate-limit checks. Surface active provider backoff or rate-limit state as a warning or error according to the source plan. Ensure provider names and messages are redacted if they can contain secret material.
12. Add disk-space warnings for relevant state/cache/work directories. Use the existing filesystem abstraction if present. Keep thresholds aligned with the source plan or existing project conventions.
13. Apply redaction consistently to all text and JSON output. Include tests or assertions that secrets in environment variables, Hub config, provider config, adapter output, and URLs are not emitted raw.
14. Add/adjust tests for the required scenarios: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled. Include at least one `--json` test that parses the output and verifies stable status/check IDs rather than brittle full snapshots.
15. Run the relevant doctor/readiness test suite, plus lint/typecheck commands normally used by this repository. If any broader suite failure is unrelated, record it clearly in the deliverable with command output and do not mask it by editing unrelated tests.
16. Self-review the diff for scope creep. Remove unrelated cleanup, formatting churn, or behavior changes not needed for P0.1.

**注意事项**:
- Do not implement any promotion-readiness item outside P0.1.
- Do not broaden into unrelated cleanup, command restructuring, UI changes, or dependency upgrades.
- Preserve current human-readable doctor/report behavior unless the P0.1 plan explicitly says otherwise.
- `--json` must be useful for automation: no mixed logs, no raw secrets, deterministic keys, and stable check IDs.
- Readiness checks should report findings; they should not mutate registry, repair stale state, clear leases, or alter provider backoff.
- Smoke checks must be non-destructive and safe to run repeatedly.
- Be careful with tests that use fake Hub/adapter/provider state. Update them only to represent the new readiness contract, not to paper over production behavior.
- If the source plan defines exact severity names, thresholds, check IDs, or output shape, follow it over this plan.

## Next-Action
Implement the scoped P0.1 readiness expansion described above, run focused and relevant repository verification, then write `deliverable-113.md` for Codex review. The deliverable must list changed files, summarize the readiness checks added, include test evidence, and call out any known verification gaps or source-plan ambiguities.

## Acceptance-Criteria
- [ ] `cpb doctor` / report readiness still supports the existing default human-readable behavior.
- [ ] `cpb doctor` / report readiness supports `--json` with parseable, deterministic, redacted structured output.
- [ ] Readiness output includes checks for Node/npm presence/version.
- [ ] Readiness output includes checks for Git presence/version.
- [ ] Readiness output includes ACP adapter presence, version visibility when available, and non-destructive smoke readiness.
- [ ] Readiness output includes Rust runtime readiness only when Rust support is enabled, and reports Rust unavailable as required.
- [ ] Readiness output includes Hub liveness and writability checks.
- [ ] Readiness output includes registry consistency checks.
- [ ] Readiness output includes stale jobs, stale workers, and stale leases checks.
- [ ] Readiness output includes provider backoff/rate-limit state.
- [ ] Readiness output includes disk-space warnings for relevant state/cache/work locations.
- [ ] Text and JSON output redact secrets, credentials, tokens, provider keys, and credential-bearing URLs.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub.
- [ ] Tests cover stale worker.
- [ ] Tests cover provider rate limit/backoff.
- [ ] Tests cover Rust unavailable when Rust is enabled.
- [ ] Tests cover `--json` output by parsing JSON and asserting stable fields.
- [ ] No unrelated cleanup, dependency additions, or P1/P2 promotion-readiness work is included.
- [ ] All relevant tests pass, or any unrelated failures are documented with evidence in `deliverable-113.md`.
- [ ] Code style remains consistent with existing project patterns.
