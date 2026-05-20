# Plan 102: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth and implement only P0.1 cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-102 / P0.1 promotion readiness doctor-report checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only its P0.1 slice.
- Scope the change to the existing `cpb doctor` and `cpb report` readiness surfaces, the shared readiness helpers they already use or naturally own, and adjacent tests.
- Add `--json` output for the readiness report path without changing existing human-readable output semantics except to include the new readiness checks.
- Use one shared readiness result shape for both human and JSON output: stable check IDs, severity/status, redacted message/details, remediation where existing style supports it, and an aggregate pass/fail value.
- Make all probes fail-soft: one failing readiness probe must produce a failed/warned check, not crash the whole command.
- Centralize redaction before output so human and JSON modes cannot leak tokens, API keys, auth headers, credentials, or sensitive local paths already treated as secrets by the project.
- Preserve existing behavior and test fixtures unless the fixture itself is part of the readiness behavior under test.

### Rejected
- Rejected broad promotion-readiness cleanup beyond P0.1 because the task explicitly forbids unrelated cleanup.
- Rejected adding new dependencies for command probing, JSON formatting, redaction, or disk checks unless the source plan explicitly requires it and there is no existing project utility.
- Rejected replacing existing doctor/report command architecture with a parallel implementation; extend the current command registration and readiness model instead.
- Rejected modifying fake LLM responders, mock providers, broad snapshots, or unrelated fixtures merely to make tests pass.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness diagnostics for P0.1 only, including `--json` output and checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and output redaction.

**Source files and edit boundaries**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; use as source of truth; do not edit.
- Existing files that register or implement `cpb doctor` and `cpb report` — edit only the current command surfaces, not a new parallel CLI.
- Existing readiness/diagnostics/report helper files used by those commands — extend or add a small adjacent helper only if no suitable shared helper exists.
- Existing tests adjacent to `cpb doctor`, `cpb report`, readiness diagnostics, Hub state, registry state, ACP adapter probing, provider backoff, or Rust runtime checks — add focused tests there.
- Do not edit unrelated cleanup targets, unrelated command tests, fake LLM responders, broad snapshots, fixtures, or test doubles unless the source plan specifically identifies them as part of P0.1.

**Implementation steps**:
1. Read the source plan and identify exact P0.1 requirements. Confirm whether the plan defines expected severity levels, JSON field names, thresholds, or runtime enablement flags; follow those names over any wording in this handoff.
2. Locate the existing `cpb doctor` and `cpb report` command implementations and their tests. Trace the current readiness/report data flow before editing so the new checks reuse existing command parsing, output rendering, logging, and test helpers.
3. Define or extend a typed readiness check result with stable IDs such as `node`, `npm`, `git`, `acp-adapter`, `rust-runtime`, `hub-liveness`, `hub-writability`, `registry-consistency`, `stale-jobs`, `stale-workers`, `stale-leases`, `provider-backoff`, and `disk-space`. Keep the schema small and predictable: status, severity, message, optional details, optional remediation, and optional redacted raw probe metadata.
4. Add `--json` to the relevant doctor/report CLI options. JSON mode must print only machine-readable JSON, with no ANSI color, progress text, stack traces, or mixed human output. Preserve the current default human output and exit-code behavior unless the source plan says otherwise.
5. Implement Node/npm and Git probes using existing command-runner/process utilities with short timeouts and injectable dependencies for tests. Node can use the current runtime version; npm and Git should verify binary availability and version readiness without performing network or repository-mutating operations.
6. Implement ACP adapter readiness by checking configured adapter presence, version discoverability, and smoke readiness. The smoke probe must be non-destructive and must not call a real provider unless the existing adapter contract already has an offline/dry-run/handshake readiness path.
7. Implement Rust runtime readiness only when Rust support is enabled by the existing config/env/feature flag. When enabled, report missing or unusable Rust runtime as a readiness failure; when disabled, report skipped/info or omit the check according to existing doctor/report conventions.
8. Implement Hub liveness and writability probes against the existing CPB Hub connection/storage abstraction. Writability should use a temporary readiness probe artifact or existing health-check method and clean it up; stale or unreachable Hub state must produce a clear failed/warned check instead of throwing.
9. Implement registry consistency checks that compare the current registry/index/state representations already used by CPB. Report missing entries, duplicate/conflicting entries, unresolvable project references, or adapter/runtime references that cannot be reconciled.
10. Implement stale jobs, workers, and leases checks using existing TTL/heartbeat/lease semantics. Prefer read-only diagnostics; do not auto-delete or repair stale state as part of P0.1 unless the source plan explicitly requires repair.
11. Implement provider backoff/rate-limit readiness by reading the existing provider/backoff state. Report affected provider, retry-after/backoff timing, and severity while redacting provider keys, authorization material, request payloads, and sensitive endpoint details.
12. Implement disk-space warnings for the workspace, Hub state directory, temp/cache directory, and any other path named by the source plan. Use existing filesystem utilities where available, with warning thresholds from the source plan or current project conventions.
13. Add one redaction pass that is applied to every human and JSON output path. Include tests that prove common secret shapes are not emitted: API keys/tokens, `Authorization` headers, credentials embedded in URLs, and sensitive provider/adapter config values.
14. Add or adjust tests for the required P0.1 cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, JSON output shape, and redaction. Use dependency injection or existing fakes around probes; do not shell out to the real machine in unit tests.
15. Run the focused readiness/CLI tests first, then the project-standard lint/typecheck/test commands. If a broad command is too expensive or unavailable, record the exact blocker in the deliverable and include the focused passing evidence.

**Notes for implementation**:
- Keep the diff small and scoped. Prefer extending existing readiness helpers over adding a new framework.
- Do not broaden into P0.2/P1 items from the promotion plan.
- Do not mutate Hub/registry state except for a deliberately temporary writability probe that is cleaned up.
- Keep probe timeouts short so `cpb doctor` and `cpb report` remain usable when tools are missing or unhealthy.
- If existing output has an established severity vocabulary, use it instead of inventing a new one.
- If JSON output already exists elsewhere in the CLI, match that schema and option behavior.

### Evidence
- Planning-only phase. No terminal commands were executed.
- This handoff is based on the exact P0.1 task directive provided by the requester and requires Claude to read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` before implementation.

### Risks
- Exact implementation file paths are intentionally not guessed here because this planning phase is constrained from executing repository inspection commands. Claude must identify the current command and test files before editing.
- JSON schema details may already be defined in the promotion readiness plan or existing CLI conventions; those take precedence over this handoff's suggested field names.
- Hub, registry, provider backoff, and Rust runtime checks may have existing fakes or state stores; tests should reuse them rather than inventing parallel test infrastructure.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 on the existing `cpb doctor`/`cpb report` readiness path, add the focused tests listed above, run the relevant verification, and write `deliverable-102.md` with changed files, test evidence, and any known gaps.

## Acceptance-Criteria
- [ ] `cpb doctor` and `cpb report` include readiness checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] `--json` output is implemented for the readiness report path, is valid JSON only, includes stable check IDs/status/severity/messages, and contains no ANSI or mixed human text.
- [ ] Existing human-readable doctor/report output behavior is preserved except for the added readiness checks.
- [ ] Missing ACP adapter is covered by a focused test and reports a clear readiness failure without crashing.
- [ ] Stale or unavailable Hub state is covered by a focused test and reports liveness/writability status without mutating persistent state beyond cleaned-up temporary probes.
- [ ] Stale worker state is covered by a focused test using existing TTL/heartbeat semantics.
- [ ] Provider rate-limit/backoff state is covered by a focused test and reports retry/backoff readiness without leaking provider secrets.
- [ ] Rust unavailable while Rust runtime is enabled is covered by a focused test; Rust disabled behavior remains skipped/info/omitted according to current conventions.
- [ ] Redaction is covered by tests for human and JSON output and prevents secrets, auth headers, credential URLs, provider keys, and sensitive adapter config from leaking.
- [ ] Registry consistency and disk-space warnings are tested or otherwise verified with explicit evidence in `deliverable-102.md`.
- [ ] No unrelated cleanup, broad refactor, new dependency, or unrelated fixture/mock update is included.
- [ ] Project-standard focused tests pass, and broader lint/typecheck/test verification is run or any blocker is documented with exact command/evidence.
