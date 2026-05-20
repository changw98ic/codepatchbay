# Plan 010 - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement P0.1 cpb doctor/report readiness checks

Task reference: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand `cpb doctor`/`cpb report` readiness checks. Include `--json` output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-010-P0.1-promotion-readiness-doctor-report
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authority for P0.1 wording, required severities, thresholds, and any naming already specified there.
- Keep implementation scoped to the existing `cpb doctor` and `cpb report` readiness surface; do not add unrelated cleanup, new runtime features, or broad CLI restructuring.
- Implement one shared readiness collector/data model used by both commands, then render it through existing human-readable output and a new `--json` output path.
- Preserve current default text behavior and exit-code semantics unless the promotion readiness plan explicitly requires a P0.1 change.
- Make each readiness check dependency-injectable for tests: clock, filesystem, command runner, Hub client, registry reader, config reader, provider backoff reader, and disk-space reader.
- `--json` output must be valid machine-readable JSON with no ANSI formatting and with redaction applied before writing to stdout/stderr.
- Stale jobs, workers, leases, registry inconsistencies, provider backoff/rate limits, and disk pressure are reporting checks only; P0.1 must not reap, repair, mutate, or clear state as a side effect.

### Rejected
- Rejected broad refactors of the CLI command structure: the source task is a P0.1 readiness expansion, not a cleanup pass.
- Rejected adding dependencies for JSON rendering, command execution, or redaction: use existing project utilities and platform APIs.
- Rejected live provider/model calls for readiness: provider backoff should inspect existing local state/config, not create external traffic.
- Rejected destructive Hub/registry probes: writability checks must use a temporary probe through existing storage APIs and clean up after themselves.
- Rejected changing fake/mock fixtures merely to hide failures: test doubles may be adjusted only when they model the new readiness behavior under test.

### Scope

**Target**: Expand `cpb doctor` and `cpb report` so promotion readiness failures are visible in both human and JSON output, with focused regression coverage for the P0.1 failure modes.

**Required source-of-truth file**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; map every P0.1 bullet to either implementation, an existing behavior reference, or an explicit not-applicable note in the deliverable.

**Implementation discovery targets**:
- Existing `cpb doctor` command module and tests.
- Existing `cpb report` command module and tests.
- Existing config/loading utilities for ACP adapter, Rust runtime enablement, Hub connection/state, registry state, worker/job/lease state, provider backoff state, and redaction.
- Existing command/process execution helper, if present, so version/smoke checks share timeouts and error handling.

**Expected changed areas**:
- The current CLI command files for `doctor` and `report`, only enough to wire the shared readiness collector and `--json`.
- A shared readiness module near the current CLI diagnostics/reporting code.
- Existing or adjacent tests for doctor/report readiness output and collector behavior.
- No docs, snapshots, fixtures, generated files, or unrelated modules unless the existing test harness requires a narrowly scoped fixture for one of the requested cases.

**Implementation steps**:
1. Read the promotion readiness plan and write a P0.1 checklist for yourself before editing. Confirm whether it defines check severities, disk thresholds, stale-state thresholds, JSON field names, or command-specific exit-code requirements.
2. Locate the existing `cpb doctor` and `cpb report` command implementations and current tests. Add focused failing tests first for the required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when enabled.
3. Define a shared readiness result shape compatible with existing output. Use stable check IDs such as `tool.node`, `tool.npm`, `tool.git`, `adapter.acp.presence`, `adapter.acp.version`, `adapter.acp.smoke`, `runtime.rust`, `hub.liveness`, `hub.writability`, `hub.staleness`, `registry.consistency`, `state.jobs.stale`, `state.workers.stale`, `state.leases.stale`, `provider.backoff`, and `system.disk`.
4. Add `--json` support to both commands. The JSON should include at least `schemaVersion`, `command`, `ok`, `generatedAt`, `summary`, and `checks`; each check should include `id`, `status` (`pass`, `warn`, `fail`, or `skip`), `message`, and redacted `details` when useful.
5. Implement Node/npm/Git checks. Use the running Node version where possible, existing package engine constraints when available, and bounded local version commands for npm/Git. Missing required tools should produce deterministic `fail` results; optional or non-blocking issues should follow the promotion plan severity.
6. Implement ACP adapter checks. Verify configured/default adapter presence, report adapter version with a bounded local command or existing API, and run only a non-mutating smoke readiness probe. Missing adapter must fail the requested test without throwing an uncaught exception.
7. Implement Rust runtime readiness only when Rust runtime support is enabled by current config/feature flags. If disabled, emit `skip`; if enabled but binary/runtime is unavailable, emit the promotion-plan severity and satisfy the Rust-unavailable test.
8. Implement Hub readiness. Check liveness, stale heartbeat/metadata, and writability through existing Hub/storage abstractions. Writability must create only a temporary probe and remove it. If Hub is unavailable, dependent registry/state checks should become clear `skip` or `fail` results according to the source plan rather than cascading stack traces.
9. Implement registry and state consistency checks. Detect orphaned or duplicate registry entries, missing referenced records, malformed active jobs, stale jobs, stale workers, and stale leases using the project’s existing state readers. Report findings without mutating state.
10. Implement provider backoff readiness. Inspect local provider backoff/rate-limit state and report active backoff with retry timing and provider identity after redaction. The rate-limit test must prove no token, API key, Authorization header, or credential-bearing URL appears in text or JSON output.
11. Implement disk-space warnings using existing filesystem/platform helpers. Use thresholds from the source plan if present; otherwise use the project’s existing warning convention. Disk pressure should warn, not crash the command.
12. Centralize redaction for readiness output before any renderer writes. Redact secrets in keys/values for tokens, API keys, passwords, secrets, Authorization/Bearer headers, credentialed URLs, and provider-specific config. Apply redaction consistently to human output, JSON, errors, and debug details.
13. Re-run the full relevant test set for doctor/report/readiness. Then run the project’s standard lint/typecheck/test commands if they are normally required for CLI changes and practical in the environment.
14. Self-review the diff against this plan and the promotion readiness plan. Remove incidental cleanup, confirm no behavior outside P0.1 changed, and write `deliverable-010.md` with changed files, verification output, source-plan mapping, and remaining risks.

**Notes and constraints**:
- Keep checks bounded with timeouts. A broken adapter, Git binary, npm binary, Hub, or Rust runtime must not hang `cpb doctor` or `cpb report`.
- Do not call remote providers or external networks for readiness. Local Hub health is acceptable when it is the existing CPB Hub endpoint.
- Preserve existing behavior for normal healthy environments. Existing doctor/report text may gain new readiness rows, but current successful workflows should remain successful.
- If existing command semantics conflict with the source plan, follow the source plan and document the conflict in `deliverable-010.md`.
- If any requested check already exists, reuse it and add coverage rather than duplicating logic.

### Evidence
- Planning-only handoff created under the requested inbox path.
- No terminal commands were executed by Codex during this planning phase, per constraint.
- Implementation evidence must be supplied by Claude in `deliverable-010.md` after code changes and tests.

### Risks
- The exact command/module paths were not inspected in this planning phase because terminal execution was prohibited. Claude must discover and record the actual changed paths before editing.
- Severity and threshold choices may already be specified in the promotion readiness plan; do not invent alternatives without first checking that document.
- Hub writability and adapter smoke probes can accidentally become side-effectful if implemented through low-level file/process calls. Use existing safe abstractions and clean up temporary probes.
- JSON output can leak secrets if redaction is applied only to text output. Redaction must happen before renderer selection or at a shared serialization boundary.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only TASK-010 P0.1 as described above, run focused and relevant project verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-010.md` using the handshake protocol for `claude -> codex`, Phase: `execute`.

## Acceptance-Criteria
- [ ] The implementation explicitly maps every P0.1 readiness requirement from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` to code, test coverage, or an explained existing behavior.
- [ ] `cpb doctor --json` emits valid JSON with redacted details, deterministic check IDs, summary counts, and no ANSI/control formatting.
- [ ] `cpb report --json` emits valid JSON with the same readiness schema or a documented compatible embedding of that schema.
- [ ] Default human-readable `cpb doctor` and `cpb report` output still works and preserves existing behavior except for the scoped readiness additions.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence, ACP adapter version, ACP adapter smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, Hub staleness, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate limits, and disk-space warnings.
- [ ] Missing ACP adapter is reported as a readiness failure without an uncaught exception, and has focused test coverage.
- [ ] Stale Hub state is reported deterministically, and has focused test coverage.
- [ ] Stale worker state is reported deterministically, and has focused test coverage.
- [ ] Active provider rate limit/backoff is reported without leaking secrets, and has focused test coverage.
- [ ] Rust runtime unavailable while Rust support is enabled is reported deterministically, while disabled Rust support is skipped, and the unavailable case has focused test coverage.
- [ ] Redaction tests prove tokens, API keys, Authorization/Bearer values, passwords, secrets, and credentialed URLs do not appear in JSON or human readiness output.
- [ ] Checks use bounded timeouts and do not perform destructive repair/reap/cleanup actions.
- [ ] Relevant doctor/report/readiness tests pass, plus the project’s standard lint/typecheck/test verification required for a CLI change.
- [ ] The final deliverable lists changed files, verification commands and outputs, simplifications or reuse decisions, and remaining risks.
