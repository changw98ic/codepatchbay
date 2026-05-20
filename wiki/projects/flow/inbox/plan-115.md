# Plan 115: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; implement only P0.1 cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-115-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only its P0.1 slice.
- Expand the existing `cpb doctor` / readiness report surface instead of creating a parallel diagnostic command.
- Preserve existing human-readable output and add machine-readable `--json` output with the same underlying check results.
- Model every readiness probe as a structured result with severity, status, redacted detail, and actionable remediation so CLI and JSON output cannot drift.
- Keep checks advisory unless an existing command already fails hard for the same condition; preserve current behavior for existing passing environments.
- Redact secrets, tokens, credentials, home-directory-sensitive paths where already redacted by project conventions, and provider payloads before any terminal or JSON output.
- Add focused tests for required P0.1 regressions: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 | The primary directive requires only this P0 slice.
- New top-level readiness command | It would broaden the CLI surface and risk diverging from existing `cpb doctor/report` behavior.
- Snapshot-only coverage for CLI output | It is brittle and can miss JSON contract regressions; assert structured fields directly where possible.
- Mock updates that merely force tests green | Existing fake/test-double behavior must stay representative of the real workflow.
- Unrelated cleanup/refactor while touching diagnostics | The task explicitly forbids unrelated cleanup.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for promotion readiness P0.1, including `--json` output and required environment, adapter, Hub, registry, worker/job/lease, provider, disk, Rust-runtime, and redaction checks, while preserving existing behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read before implementation and use only the P0.1 section as the authoritative scope.
- CLI entrypoint for `cpb doctor` / report readiness command — Add or wire `--json`, preserve existing text output, and route both through shared readiness results.
- Readiness/doctor implementation module — Add checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and output redaction.
- ACP adapter discovery/version/smoke helper module, if one already exists — Reuse it for presence/version/smoke readiness instead of adding duplicate adapter detection.
- Hub client/storage module used by doctor/report — Reuse existing liveness, writeability, registry, job, worker, and lease metadata APIs where available.
- Provider/backoff state module — Expose read-only readiness signal for active backoff/rate-limit state without changing retry behavior.
- Rust runtime configuration/helper module — Report unavailable Rust runtime only when the Rust runtime is enabled by config/env.
- Test files covering `cpb doctor` / readiness output — Add/adjust focused tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, JSON output shape, and redaction.

**实现步骤**:
1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify the exact P0.1 acceptance language before editing. Do not implement P0.2 or lower-priority items.
2. Locate the current `cpb doctor` / report command, its existing readiness checks, and the test suite that covers them. Record any pre-existing output contract before changing it.
3. Introduce a shared readiness result type if one does not already exist. Include at minimum: stable check id, label, status (`pass`, `warn`, `fail`, or existing project equivalent), severity, redacted details, remediation, and optional machine-readable metadata.
4. Wire `cpb doctor --json` to emit structured JSON derived from the shared readiness results. Keep existing default text output compatible with current tests and users.
5. Add environment checks for Node/npm and Git availability/version using existing process/command abstractions or testable adapters. Mark missing required tooling as failure and outdated/non-ideal versions as warning only if the source plan specifies thresholds.
6. Add ACP adapter readiness checks: presence, version reporting, and smoke-readiness. The smoke check should use an existing adapter probe or the lightest non-destructive handshake available; it must not mutate project state.
7. Add Rust runtime readiness only when enabled. If enabled and unavailable, report the required failure/warning according to the source plan; if disabled, report skipped/not-applicable without failing readiness.
8. Add Hub checks for liveness and writability. Writability must use an existing safe health/write probe or a temporary no-op/ephemeral write path that cleans up through existing APIs.
9. Add registry consistency checks using existing registry load/validate APIs. Report missing, duplicate, malformed, or unreachable entries with redacted identifiers.
10. Add stale-state checks for jobs, workers, and leases. Use project-defined age thresholds from the source plan if present; otherwise use existing constants already used by Hub/worker cleanup logic. Do not invent unrelated cleanup behavior.
11. Add provider backoff/rate-limit readiness reporting. Surface active backoff as a warning with retry timing if available; redact provider payloads and credentials.
12. Add disk-space warnings for relevant writable locations: Hub state, registry/config, logs/cache, and project workspace if the current doctor already knows them. Warn only; do not delete files.
13. Centralize redaction for all doctor/report output. Reuse existing redaction utilities first; otherwise add a small local redaction helper covered by tests.
14. Add focused tests without broad snapshot churn:
    - missing ACP adapter is reported in text and JSON
    - stale Hub liveness/writability condition is reported
    - stale worker or stale lease is reported with actionable remediation
    - provider rate-limit/backoff is reported and redacted
    - Rust runtime enabled but unavailable is reported
    - `--json` output is parseable and contains stable check ids/statuses
    - secrets/tokens/provider credentials are not present in text or JSON
15. Run the relevant test suite, lint/typecheck if present, and any existing doctor/report verification commands. If a full test suite is too expensive, run the narrow tests plus the nearest existing CLI test target and document the gap.
16. Produce `deliverable-115.md` following the execute-to-review handoff format, including changed files, exact verification commands/output, and any remaining risks.

**注意事项**:
- Only implement P0.1 from the promotion readiness plan. Do not broaden into unrelated cleanup, UI changes, packaging work, or lower-priority readiness tasks.
- Preserve existing CLI behavior by default. `--json` is additive unless the source plan explicitly says otherwise.
- Do not make production behavior depend on test-only fakes. If an existing fake no longer represents the intended real workflow, report the mismatch in the deliverable and add a purpose-built verification path.
- Keep probes non-destructive. Doctor/report checks may inspect and perform safe health probes, but must not repair, reset, delete, or migrate state.
- Keep result ids stable and human-readable so future promotion gates can depend on them.
- Treat stale jobs, stale workers, and stale leases as readiness findings, not as automatic cleanup triggers.
- Redaction must apply before formatting text and before JSON serialization.
- If the source plan defines exact thresholds, labels, or severity levels, use those values over any assumptions in this handoff.

## Next-Action
Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement the scoped `cpb doctor/report` readiness expansion above, run focused verification, and write `deliverable-115.md` for Codex review.

## Acceptance-Criteria
- [ ] Implementation is limited to P0.1 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] `cpb doctor` / report retains existing default human-readable behavior for currently supported checks.
- [ ] `cpb doctor --json` or the existing equivalent report command emits parseable JSON derived from the same readiness results as text output.
- [ ] JSON output includes stable check ids, status/severity, redacted detail, remediation/action, and any relevant metadata for all P0.1 checks.
- [ ] Readiness includes Node/npm availability/version checks.
- [ ] Readiness includes Git availability/version checks.
- [ ] Readiness includes ACP adapter presence, version, and smoke-readiness checks.
- [ ] Readiness includes Rust runtime availability only when Rust runtime is enabled, and disabled runtime does not fail readiness.
- [ ] Readiness includes Hub liveness and writability checks.
- [ ] Readiness includes registry consistency checks.
- [ ] Readiness includes stale jobs, stale workers, and stale leases checks.
- [ ] Readiness includes provider backoff/rate-limit checks.
- [ ] Readiness includes disk-space warning checks for relevant writable paths.
- [ ] Text and JSON outputs redact secrets, tokens, credentials, and provider-sensitive values.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub liveness or writability.
- [ ] Tests cover stale worker and/or stale lease detection.
- [ ] Tests cover provider rate-limit/backoff reporting and redaction.
- [ ] Tests cover Rust runtime enabled but unavailable.
- [ ] Tests cover `--json` parseability and core schema fields.
- [ ] Existing behavior outside P0.1 is preserved.
- [ ] Relevant lint/typecheck/tests pass, or any unrun verification is explicitly documented in `deliverable-115.md`.
