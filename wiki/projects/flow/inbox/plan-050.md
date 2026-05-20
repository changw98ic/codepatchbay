## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-050
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only P0.1.
- Expand the existing `cpb doctor` / readiness-report surface in place instead of adding a separate command family.
- Add `--json` output through the existing command/report pipeline so text output and machine-readable output share the same readiness model.
- Model each readiness concern as a named check with severity, status, evidence, remediation, and redacted details.
- Keep checks best-effort and non-destructive: diagnostics may inspect availability, liveness, metadata, and writable temp/probe paths, but must not mutate user project state beyond existing doctor/report expectations.
- Gate Rust runtime checks behind the existing Rust-enabled configuration or feature flag. If Rust is disabled, report the check as skipped rather than failed.
- Redact secrets, tokens, credentials, authorization headers, environment values, Hub URLs with credentials, provider keys, and filesystem paths that existing redaction policy already treats as sensitive.

### Rejected
- Rejected broad cleanup of doctor/report internals: the task is a scoped P0 readiness slice, and unrelated refactors increase regression risk.
- Rejected adding new dependencies for CLI rendering or system probing: use existing runtime APIs, standard library helpers, and project utilities.
- Rejected test-only fake edits that merely force green tests after production changes: adjust fakes only where needed to represent the new real readiness cases.
- Rejected making Rust unavailable a hard failure when Rust support is not enabled: that would change existing behavior for non-Rust deployments.

### Scope

**目标**: Expand `cpb doctor` / readiness report checks for P0.1 promotion readiness while preserving existing behavior and output compatibility. Add JSON output, richer environment/runtime/Hub/provider diagnostics, redaction, and focused regression tests for the required failure modes.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only as source-of-truth context; do not edit.
- CLI entrypoint for `cpb doctor` / readiness report command — add or wire `--json` option without changing existing default text behavior.
- Existing doctor/report readiness model module — add structured check results for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk, and redaction.
- Existing environment/system probe helpers — add narrowly scoped probes for runtime versions, adapter smoke readiness, Hub liveness/writability, registry consistency, stale records, provider backoff state, and disk-space warnings.
- Existing redaction utility or report serializer — ensure all text and JSON diagnostic details are redacted consistently.
- Existing doctor/report tests — add or adjust focused tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.
- Existing fixtures/fakes for Hub/provider/runtime probes — update only when needed to represent the new real readiness states.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify the existing command, model, serializer, probes, and tests that already implement `cpb doctor` or readiness reporting.
2. Map the current readiness output contract before editing. Preserve existing text output fields, exit-code semantics, and any existing check names unless the source plan explicitly requires a change.
3. Introduce a single structured readiness-check result shape if one does not already exist. It should include at minimum `id`, `label`, `status` (`pass`, `warn`, `fail`, `skip`), `severity`, `summary`, optional `details`, optional `version`, optional `evidence`, and optional `remediation`.
4. Add `--json` to `cpb doctor` / report command parsing and route it to the shared readiness result model. JSON must be deterministic enough for tests and must not include ANSI formatting.
5. Implement Node/npm checks by detecting executable availability and versions. Missing Node should fail if required by the existing CPB runtime; missing npm should warn or fail according to the source plan and current command expectations.
6. Implement Git availability/version check. Missing Git should report an actionable readiness failure or warning according to current project requirements without crashing the command.
7. Implement ACP adapter readiness checks covering presence, version discovery, and a smoke-readiness probe. Distinguish missing adapter, adapter version unavailable, and smoke probe failure with separate evidence/remediation where practical.
8. Implement Rust runtime readiness only when Rust support is enabled by existing config/env/feature detection. When enabled and unavailable, report the required Rust-unavailable failure. When disabled, emit a skipped check or omit only if existing report conventions require omission.
9. Implement Hub liveness and writability checks. Liveness should detect stale/unreachable Hub state; writability should use the existing safe probe mechanism or a temporary/non-mutating path already used by Hub diagnostics.
10. Implement registry consistency checks by comparing registered projects/adapters/workers against existing Hub/registry state and reporting missing, duplicate, stale, or contradictory entries without deleting or repairing them.
11. Implement stale jobs, workers, and leases detection using existing TTL/heartbeat/lease metadata. Report stale records with age/count and remediation, but do not clean them up in this P0.1 slice.
12. Implement provider backoff/rate-limit readiness reporting. If the provider is in rate-limit/backoff state, surface it as a warning or failure with retry/backoff metadata after redaction.
13. Implement disk-space warnings for relevant CPB state, cache, workspace, and Hub storage paths. Use conservative thresholds from the source plan or existing config; make low-space a warning unless the current command already treats it as fatal.
14. Apply redaction to every diagnostic detail before text rendering and JSON serialization. Add coverage for tokens, authorization headers, provider keys, credential-bearing URLs, and sensitive env values.
15. Keep output compatibility by snapshotting or asserting key existing text sections before/after changes. Add JSON-specific assertions rather than rewriting all text tests.
16. Add focused tests for the required cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled.
17. Run the smallest relevant test group first, then the broader doctor/report test suite, then lint/typecheck if those are part of the existing project verification path.
18. Produce `deliverable-050.md` with changed files, implementation summary, exact verification commands and outputs, and any remaining risks.

**注意事项**:
- Do not broaden into unrelated cleanup, command redesign, or promotion items beyond P0.1.
- Do not change default text behavior except to add the required readiness checks.
- Do not introduce new dependencies without explicit approval.
- Keep probes time-bounded so `cpb doctor` remains fast and cannot hang on unavailable adapters or Hub services.
- Ensure all failure paths are reported as structured readiness results, not uncaught exceptions.
- Keep tests deterministic by injecting probe results or clocks where existing test patterns allow.
- Preserve existing behavior for deployments that do not enable Rust support.
- Do not edit snapshots, fixtures, fakes, or test doubles merely to mask production regressions.

## Next-Action
Implement the scoped P0.1 doctor/report readiness expansion above, run the relevant tests and verification commands, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-050.md` using the handoff protocol with changed files, evidence, risks, and reviewer next steps.

## Acceptance-Criteria
- [ ] `cpb doctor` or the existing readiness report command supports `--json` and returns deterministic machine-readable readiness results.
- [ ] Existing default human-readable output still works and preserves prior behavior apart from the added P0.1 checks.
- [ ] Readiness includes Node and npm availability/version checks.
- [ ] Readiness includes Git availability/version check.
- [ ] Readiness includes ACP adapter presence, version, and smoke-readiness checks.
- [ ] Readiness includes Rust runtime check when Rust support is enabled, with Rust-disabled deployments preserved.
- [ ] Readiness includes Hub liveness and writability checks.
- [ ] Readiness includes registry consistency checks.
- [ ] Readiness includes stale jobs, stale workers, and stale leases checks.
- [ ] Readiness includes provider backoff/rate-limit reporting.
- [ ] Readiness includes disk-space warning checks for relevant CPB/Hub/workspace storage.
- [ ] Text and JSON outputs redact secrets, tokens, credential-bearing URLs, provider keys, authorization headers, and sensitive environment values.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub state.
- [ ] Tests cover stale worker state.
- [ ] Tests cover provider rate-limit/backoff state.
- [ ] Tests cover Rust unavailable when Rust support is enabled.
- [ ] No unrelated cleanup or non-P0.1 behavior changes are included.
- [ ] All relevant tests pass, with exact commands and output recorded in `deliverable-050.md`.
- [ ] Code style matches the existing project conventions.
