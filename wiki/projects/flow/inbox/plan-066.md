# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1 cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-066
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the execution source of truth before editing code. If this handoff conflicts with that file, follow the source-of-truth plan.
- Implement only P0.1: expand `cpb doctor` and `cpb report` readiness checks. Do not implement other promotion readiness items.
- Preserve current default human-readable behavior and add `--json` as an explicit machine-readable output mode.
- Use one shared readiness collector/result model for `doctor` and `report` so checks, statuses, redaction, and JSON schema cannot drift.
- Model each readiness check as structured data with stable fields: `code`, `label`, `status` (`ok`, `warn`, `fail`, `skip`), `message`, optional `details`, and optional `remediation`.
- Keep probes read-only except for the Hub writability probe, which may create and remove a short-lived sentinel file in the existing Hub writable location.
- Redact secrets before both human and JSON output are rendered. Redaction must cover tokens, API keys, bearer values, provider credentials, auth headers, and sensitive environment/config values surfaced in diagnostics.

### Rejected
- Implementing P1/P2 promotion readiness work | outside this P0.1 slice.
- Adding a new readiness daemon or background worker | broadens scope and changes runtime behavior.
- Auto-cleaning stale jobs, workers, or leases from `doctor`/`report` | P0.1 asks for readiness reporting, not mutation.
- Adding new dependencies for command probing or JSON rendering | existing Node/runtime utilities should be enough.
- Changing fake LLM responders, snapshots, or broad test doubles just to make tests pass | preserve existing behavior; add purpose-built readiness fixtures instead.

### Scope

**Goal**: Implement P0.1 from the promotion readiness plan: expand `cpb doctor` and `cpb report` readiness checks with `--json` output, environment/runtime probes, Hub/state checks, provider backoff reporting, disk-space warnings, redaction, and focused regression tests.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; use it to confirm exact P0.1 wording and any existing acceptance language.

**Files to resolve and modify**:
- The existing `cpb doctor` command implementation file — add/route readiness checks and `--json`.
- The existing `cpb report` command implementation file — reuse the same readiness collector and add/route `--json`.
- The existing CLI option/parser registration for `doctor` and `report` — register `--json` without changing existing flags.
- The existing Hub client/state access module — reuse for liveness and writability checks.
- The existing registry/config module — reuse for registry consistency, ACP adapter detection, Rust-runtime enablement, and provider backoff state.
- The existing job/worker/lease state module — reuse TTL/staleness logic or constants where available.
- The existing test files for `doctor`, `report`, or CLI command readiness; if no focused test file exists, add a narrowly named readiness test file beside the closest command tests.

**Implementation steps**:
1. Read the promotion readiness source plan and the current `doctor`/`report` code paths. Confirm the existing output format, exit-code behavior, command parser, and test style before editing.
2. Introduce or extend a shared readiness collector in the smallest existing module boundary that both `doctor` and `report` can import. It should accept injected dependencies for command probing, filesystem probes, Hub access, registry access, clocks, and disk stats so tests do not depend on the real machine.
3. Add structured `--json` output for both commands. Suggested top-level schema: `ok`, `generatedAt`, `command`, `checks`, `summary`, and `redactionsApplied`. Preserve default human output when `--json` is absent.
4. Implement Node/npm and Git checks. Capture presence, versions, probe errors, and remediation. Use current project engine/version expectations if already defined; otherwise report discovered versions without inventing strict minimums.
5. Implement ACP adapter readiness. Check adapter presence, version discoverability, and smoke readiness through the existing adapter/config mechanism. Missing adapter must produce a structured failure that is covered by tests.
6. Implement Rust runtime readiness only when the existing config/env says Rust runtime is enabled. When disabled, emit `skip`. When enabled and unavailable, emit `fail` or the existing equivalent error severity, and cover it with tests.
7. Implement Hub checks: liveness, writable state, and stale Hub detection. The writability probe should write then remove a sentinel in the configured Hub writable location. Stale Hub must be reported without destructive cleanup and covered by tests.
8. Implement registry consistency checks. Validate parseability, duplicate IDs, missing referenced projects/adapters/providers, and mismatch between registry entries and known Hub/project state. Report diagnostics; do not rewrite registry state.
9. Implement stale jobs/workers/leases checks. Use existing TTL/heartbeat definitions if present. Report stale counts and representative IDs after redaction/truncation. Add the required stale worker test and include stale jobs/leases coverage if the state model supports them.
10. Implement provider backoff/rate-limit checks. Surface active backoff windows, provider name, retry time, and rate-limit reason where available. Redact credentials and cover rate-limit/backoff with tests.
11. Add disk-space warnings for relevant writable locations: project, Hub storage, registry/state directory, and temp/cache locations already used by CPB. Prefer existing thresholds/constants; otherwise add conservative warning-only thresholds near the readiness collector and test them through injected disk stats.
12. Add a redaction utility or reuse the existing one. Apply it at the readiness result boundary before rendering. Add assertions that JSON and human output do not leak representative tokens, API keys, bearer strings, or credential-looking values.
13. Add/adjust tests for the required cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime enabled but unavailable. Also add at least one `--json` test for `doctor` and one for `report`.
14. Run the focused readiness tests first, then the repo's normal lint/typecheck/test commands required by the source plan or existing package scripts. Do not update snapshots unless the changed output is intentionally part of P0.1 and the snapshot is the correct assertion surface.
15. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-066.md` with changed files, evidence, risks, and the exact verification commands/results.

**Behavior notes**:
- Keep existing exit semantics unless the current code already maps readiness failures to non-zero exits. If adding non-zero behavior is required by the source plan, apply it only to `doctor`; keep `report` behavior consistent with its existing contract.
- Keep JSON stable and deterministic enough for tests: sort checks by a fixed order and avoid raw timestamps inside individual check details unless injected in tests.
- Do not broaden into unrelated CLI cleanup, command renames, registry rewrites, Hub migrations, or new promotion-plan slices.

### Evidence
- Planning-only handoff created under the allowed inbox path.
- No terminal commands were executed in this planning phase.
- Source tree inspection was intentionally deferred to Claude because this phase was constrained from running commands.

### Risks
- Exact source/test file paths are not asserted here because the planner was not allowed to inspect the repository. Claude must resolve the current files by following the existing `cpb doctor` and `cpb report` registrations before editing.
- Exit-code expectations may already exist in the current CLI. Preserve them unless the promotion readiness source plan explicitly requires a change.
- Adapter, Hub, registry, and provider-backoff state may have existing abstractions. Prefer reuse over adding parallel readiness-only state readers.

## Next-Action
Implement the P0.1 readiness slice exactly as scoped above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then update the existing `cpb doctor`/`cpb report` code and tests. After verification, write `deliverable-066.md` with changed files, evidence, risks, and any remaining gaps.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with structured readiness checks, summary status, and redacted details.
- [ ] `cpb report --json` emits valid JSON using the same readiness result model and redaction behavior.
- [ ] Default non-JSON `cpb doctor` and `cpb report` behavior remains compatible with existing human-readable output and exit-code expectations.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Required tests exist and pass for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime enabled but unavailable.
- [ ] Tests verify JSON output for both `doctor` and `report`.
- [ ] Tests verify redaction prevents representative secrets from appearing in human or JSON output.
- [ ] No unrelated promotion-readiness slices, cleanup, new dependencies, registry migrations, or behavior rewrites are included.
- [ ] All focused readiness tests and the repo's required lint/typecheck/test commands pass, with command output recorded in `deliverable-066.md`.
