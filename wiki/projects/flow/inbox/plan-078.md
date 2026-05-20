## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-078
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as authoritative for P0.1 scope and avoid implementing any other P0/P1/P2 readiness items.
- Expand the existing `cpb doctor` / readiness report path rather than introducing a separate diagnostic command.
- Add `--json` output as a stable machine-readable form while preserving existing human-readable output behavior.
- Model readiness checks as structured results with severity, code, message, evidence, and redacted metadata so human and JSON renderers share one source of truth.
- Keep checks best-effort and non-destructive: diagnostics may inspect state, probe liveness, and perform safe smoke checks, but must not mutate user project state beyond any existing doctor behavior.
- Redact secrets, tokens, provider keys, auth headers, and sensitive filesystem/user data before rendering human or JSON output.
- Add focused tests for the requested failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Rejected broad promotion-readiness implementation beyond P0.1 because the task explicitly limits this handoff to one P0 slice.
- Rejected adding unrelated cleanup/refactors because the task requires scoped changes and existing behavior preservation.
- Rejected shelling out directly from tests without fakes/mocks because readiness checks must be deterministic and testable across CI environments.
- Rejected JSON-only implementation because existing doctor/report users likely depend on current human-readable output.
- Rejected emitting raw command output or environment dumps because readiness reporting must include redaction.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for P0.1 promotion readiness with human and `--json` output, covering runtime/tool prerequisites, ACP adapter readiness, Hub and registry health, stale operational state, provider backoff, disk-space warnings, redaction, and targeted regression tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read-only source of truth for P0.1 scope; do not modify.
- Existing CLI entry for `cpb doctor` / report command — Add or wire `--json` flag and route through shared readiness result rendering.
- Existing readiness/doctor implementation module(s) — Add checks for Node/npm, Git, ACP adapter, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- Existing config/runtime detection module(s) — Reuse current configuration and feature-flag patterns to determine whether Rust runtime checks are enabled.
- Existing Hub client/state module(s) — Reuse current Hub liveness, filesystem/state, registry, job, worker, and lease access patterns.
- Existing provider/backoff module(s) — Surface current backoff/rate-limit state without changing provider behavior.
- Existing redaction utility module(s), or the closest local utility location if none exists — Centralize readiness output redaction before rendering.
- Existing doctor/report test file(s), or nearest CLI/readiness test location — Add/adjust tests for JSON output and required failure/warning scenarios.

**实现步骤**:
1. Inspect the promotion readiness plan and current doctor/report code paths.
   - Confirm exact P0.1 language in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
   - Locate the current `cpb doctor` command, report command if separate, readiness check types, CLI argument parser, and tests.
   - Identify existing patterns for command execution, dependency detection, Hub access, registry reads, provider state, logging, and redaction.

2. Define a shared readiness result shape if one does not already exist.
   - Use the existing project style and type system.
   - Include at minimum: check id/code, label, status (`pass`, `warn`, `fail`, or equivalent existing statuses), severity, message, optional remediation, and redacted evidence/details.
   - Preserve existing exit-code semantics unless the current project already has an explicit doctor failure policy that must be extended.

3. Add or extend `--json` output for `cpb doctor` / report.
   - Parse `--json` using the existing CLI framework.
   - Human output should remain the default and preserve current content where practical.
   - JSON output should be deterministic, redacted, and suitable for tests.
   - Include an overall summary/status plus the list of check results.

4. Implement Node/npm and Git readiness checks.
   - Use existing command-runner or environment probe abstractions so tests can inject responses.
   - Report presence and version when available.
   - Missing or unparseable tool versions should produce actionable fail/warn results aligned with current doctor severity conventions.
   - Do not add a new runtime dependency.

5. Implement ACP adapter readiness checks.
   - Check adapter presence using existing adapter resolution/config conventions.
   - Report adapter version when discoverable.
   - Add a smoke-readiness probe that verifies the adapter can be invoked or initialized in the safest existing way.
   - Missing adapter must be covered by a test and should produce a clear failure with remediation.

6. Implement Rust runtime readiness only when enabled.
   - Detect the existing Rust-runtime enablement flag/config path.
   - When disabled, report skipped/not-applicable according to existing readiness conventions or omit if that is how current doctor handles disabled features.
   - When enabled, verify Rust runtime availability using the existing runtime detection path.
   - Rust unavailable must be covered by a test and should not affect non-Rust configurations.

7. Implement Hub liveness and writability checks.
   - Reuse existing CPB Hub client/state access rather than creating parallel filesystem logic.
   - Verify liveness with the safest existing ping/status method.
   - Verify writability with an existing safe writable-state check or temporary write pattern already used by the project.
   - A stale/unavailable Hub scenario must be covered by a test.

8. Implement registry consistency checks.
   - Validate that registered projects/adapters/workers reference existing, coherent state according to current registry schema.
   - Detect missing, duplicate, malformed, or conflicting registry entries.
   - Keep this check read-only.
   - Produce warnings or failures consistent with current doctor severity policy.

9. Implement stale jobs, workers, and leases checks.
   - Use existing timestamp/heartbeat/TTL conventions from Hub or worker state.
   - Detect stale jobs, stale workers, and expired/orphaned leases without altering them.
   - Include enough redacted evidence to identify the stale object class and age.
   - Stale worker must be covered by a test; include stale job/lease coverage if nearby tests make it cheap and focused.

10. Implement provider backoff/rate-limit readiness check.
   - Surface current provider backoff state from existing provider/runtime state.
   - Treat active rate limit/backoff as a warning or failure according to existing user-impact severity rules.
   - Redact provider identifiers or secrets where needed.
   - Rate limit/backoff must be covered by a test.

11. Implement disk-space warnings.
   - Check free space for the relevant Hub/project/cache/output locations already used by CPB.
   - Prefer existing filesystem/stat helpers.
   - Emit warnings below the project’s existing threshold if one exists; otherwise choose a conservative threshold and keep it local/configurable if the codebase already supports config.
   - Avoid failing hard unless existing doctor behavior treats disk exhaustion as failure.

12. Add redaction coverage across all readiness output.
   - Route both human and JSON rendering through the same redaction step or guarantee both call a shared redactor.
   - Cover obvious secret patterns: API keys, bearer tokens, auth headers, provider keys, credentials in URLs, and sensitive env var values.
   - Add a focused test if existing redaction tests do not already cover readiness output.

13. Add or adjust tests without weakening existing tests.
   - Add tests for `--json` schema/shape and redaction.
   - Add tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.
   - Use existing fakes/fixtures only to model real workflow behavior; do not modify fake responders merely to force tests green.
   - Preserve current doctor/report behavior tests and update expected output only where the new P0.1 checks intentionally add lines/fields.

14. Verify locally and prepare the execute deliverable.
   - Run the project’s relevant doctor/report tests first, then broader lint/typecheck/test commands expected for this repository.
   - Capture exact commands and outcomes in the deliverable.
   - If any verification cannot run, document the blocker and residual risk honestly.

**注意事项**:
- Keep implementation limited to P0.1 readiness checks; do not implement other promotion readiness plan items.
- Preserve existing `cpb doctor` behavior, output defaults, and exit semantics unless the P0.1 source plan explicitly requires a change.
- Prefer extending existing modules and utilities over adding new abstractions.
- Do not introduce new dependencies.
- Do not make readiness checks mutate Hub/registry/job/worker/lease state.
- Do not expose secrets, raw provider credentials, auth headers, full tokens, or sensitive environment values in either human or JSON output.
- Keep tests deterministic by injecting command, filesystem, Hub, provider, and runtime probes through existing test seams.
- If stale thresholds already exist, reuse them; if not, define the smallest local constant needed and document the rationale in code only if non-obvious.

## Next-Action
按照上述步骤实现 P0.1 的 `cpb doctor` / report readiness expansion, run focused and relevant broader verification, then write `deliverable-078.md` with changed files, test evidence, behavior notes, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation is scoped only to P0.1 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] `cpb doctor` / report supports `--json` output while preserving existing default human-readable behavior.
- [ ] JSON output includes an overall status/summary and structured, redacted readiness check results.
- [ ] Readiness checks include Node and npm presence/version.
- [ ] Readiness checks include Git presence/version.
- [ ] Readiness checks include ACP adapter presence, version when available, and smoke readiness.
- [ ] Readiness checks include Rust runtime availability only when Rust runtime is enabled.
- [ ] Readiness checks include Hub liveness and writability.
- [ ] Readiness checks include registry consistency.
- [ ] Readiness checks include stale jobs, workers, and leases using existing heartbeat/TTL conventions.
- [ ] Readiness checks include provider backoff/rate-limit state.
- [ ] Readiness checks include disk-space warnings for relevant CPB/Hub/project paths.
- [ ] Human and JSON readiness output redact secrets and sensitive values.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale/unavailable Hub.
- [ ] Tests cover stale worker.
- [ ] Tests cover provider rate limit/backoff.
- [ ] Tests cover Rust unavailable when Rust runtime is enabled.
- [ ] Existing behavior tests for doctor/report remain valid or are adjusted only for intentional P0.1 output additions.
- [ ] No unrelated cleanup, broad refactor, new dependency, or non-P0.1 feature work is included.
- [ ] Relevant lint, typecheck, and test commands pass, or any inability to run them is documented with a concrete blocker.
- [ ] `deliverable-078.md` follows the established handshake protocol and includes changed files, evidence, and risks.
