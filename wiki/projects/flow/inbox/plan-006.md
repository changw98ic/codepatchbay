# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-006-P0.1-readiness-checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before editing. If this handoff conflicts with that document, follow the document for P0.1 and note the difference in the deliverable.
- Implement only P0.1 readiness expansion for `cpb doctor` and `cpb report`; do not pick up adjacent promotion-readiness items, cleanup, renames, or dependency changes.
- Preserve existing human-readable command behavior while adding readiness coverage and `--json` machine output.
- Prefer one shared readiness collection/model used by both `doctor` and `report`, with thin command-specific presentation layers.
- JSON output must be deterministic, parseable, redacted, and free of ANSI formatting or incidental log lines on stdout.
- Checks must cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- Tests must cover missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Adding new runtime dependencies for command parsing, semver, disk inspection, or redaction; use existing project helpers and platform APIs.
- Rewriting the command framework, registry, Hub, provider, or worker lifecycle code as part of this slice.
- Making Rust runtime availability mandatory when the Rust-backed path is disabled.
- Using real provider network calls, real external adapters, or persistent user machine state in tests.
- Updating fake responders, fixtures, snapshots, or test doubles merely to hide changed production behavior.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.1 scope.
- Existing `cpb doctor` command implementation file(s) — add readiness checks and `--json` output while preserving existing human output.
- Existing `cpb report` command implementation file(s) — expose the same readiness model in report output and add `--json`.
- Existing readiness, diagnostics, registry, Hub, provider, worker, lease, disk, command-runner, or redaction helper modules — extend only where needed for the listed checks.
- Existing tests for doctor/report/readiness/diagnostics plus new focused tests for the required missing/stale/rate-limit/Rust cases.
- `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-006.md` — execution deliverable after implementation.

### Evidence
- Planning-only handoff. No terminal commands were executed in this phase because the planner was constrained to no terminal execution.
- The executor must provide fresh test, lint, typecheck, and command-output evidence in `deliverable-006.md`.

### Risks
- Exact implementation file paths are intentionally left to executor discovery because this planning phase cannot run repository inspection commands.
- Existing command output may be snapshot-tested; preserve old text as much as possible and add new readiness lines in stable positions.
- Disk-space, process liveness, and stale-time checks can be flaky if they depend on wall-clock or host state; isolate them behind injectable helpers or existing test seams.
- Redaction must run on every human and JSON path, including error details, command output, env-derived paths/tokens, provider messages, adapter smoke output, and registry fields.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness diagnostics for promotion P0.1 only, including `--json` output and tests for required failure/warning scenarios, while preserving existing behavior.

**Implementation Steps**:

1. Read the source readiness plan and locate existing surfaces.
   - Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
   - Locate current `cpb doctor`, `cpb report`, readiness/diagnostics helpers, Hub state helpers, registry helpers, provider backoff state, worker/job/lease state, redaction helpers, and tests.
   - Record the exact changed files in `deliverable-006.md`.

2. Define or extend the shared readiness result model.
   - Use a stable schema such as `schemaVersion`, `generatedAt`, `status`, `summary`, `checks`, and optional `environment`.
   - Each check should have stable `id`, human `label`, `status` (`ok`, `warn`, `fail`, `skipped`), short `message`, optional redacted `details`, and optional remediation hint if the project already uses hints.
   - Roll up global status as `fail` if any required check fails, `warn` if no failures but warnings exist, otherwise `ok`.
   - Keep the model small and command-neutral so `doctor` and `report` do not diverge.

3. Implement environment/tool checks.
   - Node: report `process.version`; fail only if the existing project has a minimum version rule and the current version violates it.
   - npm: detect presence/version through the existing safe command-runner or helper seam; warn/fail consistently with existing doctor semantics when unavailable.
   - Git: detect presence/version through the existing helper seam; warn/fail consistently with current command expectations when unavailable.
   - ACP adapter: verify adapter presence, version availability, and smoke readiness through existing adapter discovery/config. Missing adapter must produce a failing readiness check. Smoke must be bounded, non-interactive, redacted, and use an existing capability/health/help path rather than a real provider workflow.
   - Rust runtime: only run when the Rust-backed runtime is enabled by existing config/env/feature flag. When enabled and unavailable, report a failing check; when disabled, emit `skipped` with a clear message.

4. Implement CPB state checks.
   - Hub liveness: detect reachable/running Hub using existing Hub metadata, pid/socket/heartbeat, or client ping helpers. Stale Hub state must be reported distinctly from "Hub not configured".
   - Hub writability: verify required Hub/project state directories can be written using an existing temp-file or write-probe helper and clean up after the probe.
   - Registry consistency: compare registry entries against expected project/workspace/adapter/Hub references and report missing, duplicate, dangling, or conflicting records.
   - Stale jobs/workers/leases: use existing timeout/heartbeat constants where available. Report stale jobs, stale workers, and expired/abandoned leases without deleting or repairing them in this slice.
   - Provider backoff/rate-limit: surface current provider backoff/rate-limit state from existing provider state. Rate-limited providers must produce at least a warning with redacted provider details and retry timing if available.
   - Disk space: check relevant project/Hub/cache paths using existing filesystem APIs. Emit warnings below the existing or newly local threshold; do not fail unless existing doctor policy already fails on critically low disk.

5. Add `--json` output to `cpb doctor` and `cpb report`.
   - Respect existing option parsing and help style.
   - `--json` must write only JSON to stdout; warnings/debug logs must not corrupt stdout.
   - Human output should remain compatible with existing expectations, adding the new readiness checks in a stable order.
   - Use the same readiness collector for both commands and adapt only the final presentation layer.

6. Apply redaction consistently.
   - Reuse or extend existing redaction utilities.
   - Redact tokens, API keys, authorization headers, provider credentials, user secrets, adapter command output that may contain credentials, and sensitive env-derived values.
   - Redaction must apply before rendering human output and before serializing JSON.
   - Add at least one test proving secret-like values do not appear in JSON or human diagnostics.

7. Add focused tests before/with implementation.
   - Missing ACP adapter: doctor/report readiness reports adapter presence failure and JSON contains the expected check id/status.
   - Stale Hub: simulated stale Hub metadata/heartbeat reports stale Hub state without attempting cleanup.
   - Stale worker: simulated stale worker/heartbeat reports stale worker readiness issue.
   - Provider rate limit/backoff: simulated provider state reports warning/failure according to existing severity policy and includes redacted retry details.
   - Rust unavailable: with Rust runtime enabled, unavailable Rust runtime reports failure; with Rust disabled, the Rust check is skipped.
   - JSON mode: both `cpb doctor --json` and `cpb report --json` parse successfully and contain the same readiness check ids/status rollup.
   - Existing behavior: existing human-output tests continue to pass after adjusting only for intentional new readiness lines.

8. Verify and hand off.
   - Run the narrow doctor/report/readiness test files first, then the relevant full test suite, lint, and typecheck commands used by this repo.
   - Manually run or test-equivalent exercise `cpb doctor --json` and `cpb report --json` and include parse evidence.
   - Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-006.md` with changed files, test evidence, known risks, and any source-plan interpretation notes.

**Notes**:
- Keep changes scoped to P0.1. Do not modify unrelated promotion readiness items.
- Prefer deletion or reuse over new abstractions, but introduce a small shared collector if doctor/report would otherwise duplicate readiness logic.
- Do not auto-repair Hub/registry/stale worker state in this slice; report readiness only.
- Do not add new dependencies.

## Next-Action
Implement P0.1 exactly as scoped above. Start by reading the source readiness plan, discover the current doctor/report implementation, add or adjust focused tests, implement the shared readiness checks and `--json` output, run verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-006.md`.

## Acceptance-Criteria
- [ ] Executor confirms `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read and P0.1 was followed as source of truth.
- [ ] `cpb doctor --json` emits parseable, deterministic, redacted JSON to stdout with no ANSI codes or incidental log lines.
- [ ] `cpb report --json` emits parseable, deterministic, redacted JSON to stdout with no ANSI codes or incidental log lines.
- [ ] Human-readable `cpb doctor` and `cpb report` behavior is preserved except for intentional added readiness checks.
- [ ] Readiness includes Node/npm and Git presence/version checks.
- [ ] Readiness includes ACP adapter presence, version, and bounded smoke readiness checks.
- [ ] Readiness checks Rust runtime only when Rust is enabled, fails when enabled and unavailable, and skips when disabled.
- [ ] Readiness includes Hub liveness and Hub writability checks, including stale Hub detection.
- [ ] Readiness includes registry consistency checks for dangling, duplicate, missing, or conflicting records covered by existing data model.
- [ ] Readiness includes stale jobs, stale workers, and stale leases checks without mutating or repairing state.
- [ ] Readiness includes provider backoff/rate-limit state with redacted details.
- [ ] Readiness includes disk-space warnings for relevant project/Hub/cache paths.
- [ ] Redaction covers human output, JSON output, command-output details, provider details, adapter details, and environment-derived secrets.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, and Rust unavailable when enabled.
- [ ] Tests cover JSON output for both doctor and report, including parseability, status rollup, check ids, and redaction.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, refactor, or promotion-readiness scope is included.
- [ ] Relevant lint, typecheck, and test commands pass, with exact command evidence captured in `deliverable-006.md`.
- [ ] Code style follows existing project patterns and all changed files are listed in `deliverable-006.md`.
