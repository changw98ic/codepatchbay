## Handoff: codex -> claude

# Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-003-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Extend the existing `cpb doctor` / `cpb report` readiness path instead of adding a parallel readiness command.
- Add a shared readiness result model that can render both existing human output and new `--json` output.
- Preserve default human output and existing exit-code semantics except where newly detected failures must contribute to the existing failure status.
- Use dependency injection or existing test seams for filesystem, command execution, time, Hub state, registry state, provider state, and disk-space reads so tests do not depend on the host machine.
- Keep all checks non-destructive: diagnostics may read state and may perform a bounded temp-file write/delete only to prove Hub writability.
- Redact sensitive data before both human and JSON rendering.

### Rejected
- Rewriting the CLI, Hub, registry, provider, or worker architecture for this slice | P0.1 is a readiness-check expansion only.
- Adding new runtime dependencies for semver, disk stats, command execution, or redaction | the task requires a scoped implementation and existing behavior preservation.
- Making Rust globally required | Rust readiness is checked only when the existing configuration says the Rust runtime is enabled.
- Auto-cleaning stale jobs, workers, leases, or provider backoff state during `doctor` / `report` | diagnostics should report readiness, not mutate operational state.
- Editing unrelated mocks, snapshots, fixtures, or fake responders just to force existing tests to pass | new or adjusted tests should cover the real P0.1 behavior through purpose-built seams.

### Scope

**目标**: Expand CPB promotion-readiness diagnostics for `cpb doctor` and `cpb report` with machine-readable JSON output and the P0.1 readiness checks listed in the source promotion plan, while preserving current behavior outside this slice.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; source of truth for P0.1 wording and boundaries.
- Existing CLI command module(s) that register or implement `cpb doctor` — add `--json` support and wire expanded readiness checks.
- Existing CLI command module(s) that register or implement `cpb report` — add matching readiness JSON support if this command already exists.
- Existing readiness/doctor/report helper module(s), or a new helper colocated with them — define the shared readiness result model, collectors, status aggregation, and redaction.
- Existing Hub state/client module(s) used by the CLI — read liveness, heartbeat, and writability state through existing APIs.
- Existing registry module(s) used by the CLI — validate registry consistency through existing APIs.
- Existing job/worker/lease state module(s) — detect stale jobs, workers, and leases using current TTL/heartbeat constants where available.
- Existing provider/backoff state module(s) — report active provider rate-limit/backoff readiness.
- Existing CLI/readiness tests — add focused unit and CLI tests for the new behavior.

**实现步骤**:
1. Read the source promotion-readiness plan and confirm the P0.1 checklist. Do not implement P0.2+ items or unrelated cleanup.
2. Locate the current `cpb doctor` and `cpb report` command implementations, their existing readiness helpers, and adjacent tests. Record exact modified paths in the final deliverable.
3. Add or extend a shared readiness result shape:
   - top-level fields: `schemaVersion`, `generatedAt`, `status`, `checks`.
   - check fields: `id`, `category`, `status`, `summary`, optional `details`, optional `remediation`.
   - statuses should map cleanly to existing CLI semantics; use the project’s existing naming if it already has `ok`/`warn`/`fail` or equivalent.
   - aggregate status must reflect the highest severity among checks.
4. Add `--json` output for `cpb doctor` and `cpb report`:
   - JSON output must be valid JSON on stdout with no ANSI color, progress text, stack traces, or human-only decoration.
   - Human output remains the default and should continue to include existing information.
   - Exit codes must follow the existing readiness failure semantics for both human and JSON modes.
5. Implement readiness collectors for:
   - Node runtime version from the current process.
   - npm availability/version through the existing safe command-runner pattern.
   - Git availability/version through the existing safe command-runner pattern.
   - ACP adapter presence, version, and smoke readiness. Use configured adapter path/name, run a bounded non-destructive version check, and use an existing adapter smoke/help/doctor command if available. Do not start a real long-running session.
   - Rust runtime only when the existing feature flag/configuration enables it. If disabled, return skipped/ok according to existing conventions. If enabled but unavailable, report failure.
   - Hub liveness and writability. Use existing Hub connection/state APIs for liveness/heartbeat; prove writability with a bounded temp marker write/delete only where the Hub is filesystem-backed and this is consistent with existing patterns.
   - Registry consistency. Validate parseability, duplicate identifiers, missing required fields, and references to missing projects/workspaces using existing registry APIs.
   - Stale jobs, workers, and leases. Use existing heartbeat/TTL constants when present; otherwise introduce a narrowly scoped constant in the readiness helper and document it in code.
   - Provider backoff/rate-limit state. Active rate-limit/backoff should be surfaced as a warning unless existing behavior treats it as a failure.
   - Disk-space warnings for Hub/work/cache locations. Prefer existing disk-space helpers; otherwise use standard platform APIs without new dependencies. Use conservative warning/failure thresholds and keep them centralized.
6. Implement redaction once and apply it before all renderers:
   - redact tokens, API keys, auth headers, credentials embedded in URLs, provider secrets, and sensitive environment values.
   - preserve enough non-sensitive context for remediation, such as command names, check ids, and basename-level paths where appropriate.
   - ensure redaction applies recursively to nested JSON details and human text.
7. Add/adjust tests with fake providers rather than host-dependent commands:
   - missing ACP adapter reports a failing adapter check and valid JSON in `--json` mode.
   - stale Hub liveness/heartbeat or unwritable Hub reports the expected failing readiness check.
   - stale worker/lease state is reported with the intended readiness severity.
   - provider rate-limit/backoff state is reported as warning with retry timing/details redacted as needed.
   - Rust unavailable reports failure when the Rust runtime is enabled and skipped/ok when disabled.
   - JSON output is parseable, contains all expected check ids/categories, contains no ANSI decoration, and redacts secrets.
   - Existing human-output behavior and existing tests continue to pass.
8. Run the project’s relevant verification commands after implementation. At minimum, run the focused CLI/readiness tests first, then the broader test/lint/typecheck commands that are standard for this repository.

**注意事项**:
- Keep the implementation scoped to P0.1; do not refactor unrelated CLI plumbing, registry persistence, provider behavior, or worker lifecycle code.
- Do not make checks destructive. Stale jobs/workers/leases and backoff state are reported, not cleaned.
- Prefer existing helpers, constants, and CLI option patterns.
- If a command or state source does not exist exactly as named above, integrate with the nearest existing doctor/report readiness surface instead of creating a second architecture.
- If `cpb report` has a broader report contract, add readiness JSON in the smallest compatible way and document any existing contract constraints in the deliverable.

## Next-Action
Implement the scoped P0.1 readiness expansion described above, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-003.md` using the handshake protocol with exact changed files, evidence, risks, and any source-plan constraints encountered.

## Acceptance-Criteria
- [ ] The source promotion-readiness plan was read and only P0.1 was implemented.
- [ ] `cpb doctor --json` emits valid, redacted, machine-readable readiness JSON with aggregate status and per-check details.
- [ ] `cpb report --json` emits compatible redacted readiness JSON, or the deliverable explains the existing report contract if the command requires a narrower integration.
- [ ] Default human output for `cpb doctor` and `cpb report` remains available and preserves existing behavior apart from the new readiness checks.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is covered by a failing test.
- [ ] Stale Hub liveness/heartbeat or unwritable Hub is covered by a failing test.
- [ ] Stale worker or lease state is covered by a test.
- [ ] Provider rate-limit/backoff state is covered by a test.
- [ ] Rust unavailable while Rust runtime is enabled is covered by a failing test; Rust disabled does not fail readiness.
- [ ] JSON and human renderers redact secrets, credentials, auth headers, tokens, and sensitive environment values.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, broad refactor, or P0.2+ work is included.
- [ ] Focused readiness/CLI tests pass.
- [ ] Standard repository verification for this change passes, or any unavailable verification is documented with a concrete blocker.

## Self-Review
- The plan is scoped to the exact P0.1 task and does not request implementation outside doctor/report readiness.
- The plan gives concrete checks, tests, and output contracts while leaving unknown file discovery to the executor because this planning phase could not run repository inspection commands.
- The plan preserves behavior by requiring reuse of existing CLI semantics, helper patterns, and exit-code behavior.
