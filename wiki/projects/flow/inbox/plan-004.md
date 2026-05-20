## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand `cpb doctor/report` readiness checks.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-004-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.1 doctor/report readiness slice.
- Preserve existing `cpb doctor` and report behavior while adding richer readiness checks and a machine-readable `--json` output path.
- Keep readiness checks deterministic, side-effect-light, and suitable for tests by isolating probes behind small helpers that can be stubbed or injected.
- Redact sensitive values from all human-readable and JSON output before returning or printing diagnostics.
- Add focused tests for the explicitly requested failure/readiness scenarios: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime support is enabled.

### Rejected
- Broad CLI redesign or unrelated cleanup | The directive requires only the P0.1 slice and explicitly says not to broaden scope.
- Introducing new runtime dependencies for probing or formatting | Existing project utilities and standard library APIs should be enough, and new dependencies would widen risk.
- Modifying fake/mock responders merely to make unrelated tests pass | Existing behavior must be preserved; update test doubles only where needed to represent the new doctor/report readiness contract.
- Failing hard on every warning condition | Disk space, stale resources, and provider backoff should be reported with severity/status while preserving existing command usability unless existing semantics already require nonzero exit.

### Scope

**目标**: Expand `cpb doctor/report` readiness checks for promotion P0.1, including `--json` output and checks for local toolchain, ACP adapter readiness, optional Rust runtime, Hub health, registry consistency, stale coordination state, provider backoff, disk-space warnings, and output redaction.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read only; confirm exact P0.1 wording and do not edit.
- CLI entrypoint for `cpb doctor` and/or `cpb report` — Add/route `--json`, preserve existing text output, and wire the expanded readiness checks.
- Existing doctor/report readiness module(s) — Add or extend structured check results for Node/npm, Git, ACP adapter presence/version/smoke readiness, optional Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- Existing Hub/registry/job/worker/lease/provider state modules — Reuse current read APIs for liveness and consistency checks; avoid new side effects beyond minimal smoke/readiness probes.
- Existing test files for CLI doctor/report/readiness — Add or adjust tests for JSON shape and the requested missing adapter/stale Hub/stale worker/rate limit/Rust unavailable scenarios.
- Test fixtures/helpers for doctor/report state, if present — Extend only as needed for the new readiness scenarios; do not rewrite unrelated fixtures.

**实现步骤**:
1. Read the P0.1 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and map each must-have into a concrete doctor/report check, preserving terminology from the plan where possible.
2. Locate the existing `cpb doctor` and `cpb report` command implementation and identify the current output contract, exit-code behavior, readiness result shape, and tests before editing.
3. Define a structured readiness result model if one does not already exist: each check should include a stable `id`, `label`, `status` such as `ok`/`warn`/`fail`/`skip`, a concise message, optional details, and redacted evidence.
4. Add `--json` support for doctor/report using the shared structured result model. JSON should include a summary, per-check results, and redacted details; text output should remain compatible with the existing human-readable behavior.
5. Add local toolchain checks:
   - Node executable availability and version.
   - npm executable availability and version.
   - Git executable availability and version.
   These checks should report missing tools clearly and avoid crashing if a command is unavailable.
6. Add ACP adapter readiness checks:
   - Detect adapter presence using the project’s existing adapter resolution path.
   - Report adapter version when available.
   - Perform the lightest existing smoke/readiness probe that proves the adapter can be invoked or initialized.
   - If the adapter is missing or smoke readiness fails, return a failed readiness check with redacted diagnostic detail.
7. Add Rust runtime readiness only when Rust support is enabled by the existing config/feature flag/environment. When enabled, verify the Rust runtime executable/library is available and report version/readiness if available; when disabled, return `skip` rather than `fail`.
8. Add Hub checks:
   - Verify Hub liveness using the existing connection or health-check path.
   - Verify Hub writability using the safest existing write/read/delete or temp/metadata probe available; avoid persistent user-visible state.
   - Detect stale Hub state according to existing timestamps/heartbeats and report it as `warn` or `fail` based on current command semantics.
9. Add registry consistency checks using existing registry APIs:
   - Detect missing, malformed, duplicate, or conflicting registry entries.
   - Confirm registered projects/workers/adapters referenced by doctor/report are internally consistent.
   - Report actionable messages without dumping sensitive paths/tokens beyond redacted safe context.
10. Add stale coordination checks:
   - Detect stale jobs.
   - Detect stale workers.
   - Detect stale leases.
   Use existing TTL/heartbeat rules if present; otherwise define conservative thresholds local to the readiness module and document the rationale in code only if not self-evident.
11. Add provider backoff/rate-limit visibility:
   - Surface active provider backoff or rate-limit state as a readiness warning.
   - Include provider name and retry/backoff timing only after applying the redactor.
   - Do not clear or mutate backoff state from doctor/report.
12. Add disk-space warnings:
   - Check relevant writable locations used by CPB/Hub/cache/runtime state.
   - Warn when free space is below the existing threshold if one exists; otherwise use a conservative threshold constant in the readiness module.
   - Handle platforms that cannot report disk space by returning `skip` or `warn` without failing the command.
13. Add centralized redaction for doctor/report output:
   - Redact tokens, API keys, authorization headers, secrets, home-sensitive config values, and provider credentials from both text and JSON.
   - Apply redaction at the final formatting boundary and to any check details that may be serialized.
14. Add or adjust tests before/with implementation to cover:
   - `--json` returns valid structured JSON with summary and per-check statuses.
   - Missing ACP adapter is reported as a failed readiness check without an unhandled exception.
   - Stale Hub state is detected and reported.
   - Stale worker state is detected and reported.
   - Active provider rate limit/backoff is reported as a warning.
   - Rust runtime unavailable is reported when Rust is enabled, and skipped when Rust is disabled.
   - Redaction applies to JSON and text output.
15. Run the project’s existing focused test command(s) for doctor/report/readiness, then the standard relevant test suite. Fix production code issues rather than weakening tests or broadening fixtures.
16. Write `deliverable-004.md` after implementation with changed files, test evidence, any behavior-preservation notes, and remaining risks.

**注意事项**:
- Keep the diff scoped to P0.1 readiness work. Do not refactor unrelated CLI, Hub, registry, provider, or runtime code.
- Preserve existing command names, default text output, exit-code semantics, and public behavior unless the P0.1 source plan explicitly requires a change.
- Prefer existing helper APIs and project conventions over introducing a new framework for checks.
- Do not add dependencies unless the existing codebase already has no viable standard-library or local utility path.
- Ensure every diagnostic path is redacted before output; JSON output must not become a secret exfiltration path.
- Treat stale jobs/workers/leases and provider backoff as readiness signals, not cleanup commands.
- Rust runtime checks must be conditional on the existing enabled/disabled signal, not always required.

## Next-Action
Implement the P0.1 `cpb doctor/report` readiness expansion exactly as scoped above, run focused and relevant existing tests, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-004.md` with changed files, evidence, risks, and verification notes.

## Acceptance-Criteria
- [ ] `cpb doctor` and/or the existing report command supports `--json` where applicable, producing valid structured JSON with summary and per-check readiness results.
- [ ] Existing human-readable doctor/report behavior remains available and compatible unless the P0.1 source plan explicitly requires a change.
- [ ] Readiness checks include Node/npm availability and version reporting.
- [ ] Readiness checks include Git availability and version reporting.
- [ ] Readiness checks include ACP adapter presence, version where available, and smoke readiness.
- [ ] Rust runtime readiness is checked when Rust support is enabled and skipped when Rust support is disabled.
- [ ] Hub liveness and Hub writability are checked without leaving persistent probe artifacts.
- [ ] Registry consistency is checked and reports missing, malformed, duplicate, or conflicting state.
- [ ] Stale jobs, stale workers, and stale leases are detected and reported.
- [ ] Active provider backoff/rate-limit state is surfaced as a readiness warning without mutating provider state.
- [ ] Disk-space warnings are emitted for relevant CPB/Hub/runtime writable locations when below threshold.
- [ ] Text and JSON output redact secrets, tokens, credentials, authorization headers, and sensitive provider values.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.
- [ ] Tests cover JSON output shape and redaction for doctor/report readiness output.
- [ ] Focused doctor/report/readiness tests pass.
- [ ] Relevant existing regression tests pass.
- [ ] Implementation remains scoped to P0.1 and does not include unrelated cleanup or behavior changes.
