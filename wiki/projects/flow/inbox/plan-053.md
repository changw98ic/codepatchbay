## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-053
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the governing source for P0.1; do not implement adjacent P0/P1/P2 promotion work.
- Keep this change centered on `cpb doctor` / readiness-report behavior, preserving existing human-readable output while adding machine-readable `--json`.
- Model readiness checks as structured status records with stable IDs, severity, message, evidence, and redacted details so CLI output and JSON output share the same source of truth.
- Add checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- Add or adjust focused tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.
- Preserve existing behavior by keeping current default command names, exit-code semantics unless the existing doctor/report contract already defines otherwise, and existing non-JSON wording where practical.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — rejected because the primary directive requires only this P0 slice.
- Rewriting doctor/report architecture wholesale — rejected because the slice should remain scoped, reviewable, and behavior-preserving.
- Adding new runtime dependencies — rejected because the workspace instructions prohibit new dependencies without explicit request.
- Making Rust runtime mandatory for all users — rejected because the task says Rust readiness applies when enabled.
- Emitting raw environment values, tokens, home-directory secrets, provider payloads, or adapter command internals in JSON — rejected because redaction is an explicit requirement.

### Scope

**目标**: Expand `cpb doctor` / readiness reporting so promotion-critical local prerequisites and runtime health are checked consistently, exposed through `--json`, safely redacted, and covered by focused regression tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; use as source of truth for P0.1 boundaries.
- CLI entrypoint for `cpb doctor` / readiness report command — add `--json` flag handling and route both text and JSON output through shared readiness results.
- Existing doctor/readiness-check module(s) — add or extend check implementations for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk-space, and redaction.
- Existing Hub/registry/provider state helpers — reuse current APIs to inspect liveness, writability, registry consistency, leases, workers, jobs, and provider backoff without duplicating storage parsing logic.
- Existing test files for doctor/report CLI or readiness checks — add targeted tests for the required failure and warning cases.
- Test fixtures/fakes only where they already represent doctor/readiness dependencies — adjust minimally to simulate missing adapter, stale Hub, stale worker, provider backoff/rate limit, and Rust unavailable.

**实现步骤**:
1. Read the promotion readiness source document and identify the exact P0.1 acceptance language; confirm no unrelated P0/P1/P2 requirements are pulled into this implementation.
2. Locate the current `cpb doctor` and any readiness/report code path. Document the existing public contract before editing: supported flags, exit codes, text sections, and test coverage.
3. Introduce a shared readiness result shape if one does not already exist. Use stable check IDs such as `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub`, `registry`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, and `disk_space`. Each result should include status (`pass`, `warn`, `fail`, or equivalent existing vocabulary), severity, summary, actionable detail, and redacted evidence.
4. Add `--json` to the doctor/report CLI. The JSON response should be deterministic, parseable, and redacted, with top-level command metadata, aggregate status, and the list of checks. Preserve existing text output when `--json` is absent.
5. Implement prerequisite checks:
   - Node/npm: detect availability and version using existing process helpers where possible.
   - Git: detect availability/version without requiring repository mutations.
   - ACP adapter: verify configured adapter presence, version if available, and a low-risk smoke readiness probe. Missing or non-smokable adapter must produce a clear fail.
   - Rust runtime: run only when the project/runtime configuration enables Rust; unavailable runtime should fail or warn according to existing severity conventions and the promotion plan.
6. Implement runtime/state checks:
   - Hub liveness and writability: distinguish unreachable/stale Hub from read-only or unwritable state.
   - Registry consistency: report missing, duplicate, dangling, or internally inconsistent registry entries using existing registry accessors.
   - Stale jobs/workers/leases: flag records older than the existing TTL/staleness policy; do not invent a new TTL if one already exists.
   - Provider backoff/rate limit: surface active provider backoff or rate-limit cooldown as a warning/failure with safe retry timing only if already available.
   - Disk space: warn when available free space is below an existing threshold; if no threshold exists, define a small local constant near the doctor check and cover it in tests.
7. Add a single redaction helper or reuse the existing one for all readiness output. Cover paths, tokens, API keys, bearer values, provider headers, connection strings, and adapter command details that may include secrets. Apply it before both text and JSON serialization.
8. Add or update tests in the existing style:
   - `--json` emits valid structured output and preserves redaction.
   - Missing ACP adapter is detected.
   - Stale or non-writable Hub is detected.
   - Stale worker is detected.
   - Provider rate-limit/backoff state is reported.
   - Rust unavailable is reported only when Rust runtime is enabled.
9. Run the narrow doctor/readiness test suite first, then the broader relevant test command used by the repo for CLI behavior. Fix production code rather than weakening fake/mock tests unless the fake itself is the tested product surface.
10. Produce `wiki/projects/flow/outputs/deliverable-053.md` with changed files, evidence, remaining risks, and exact test commands/results.

**注意事项**:
- Do not implement unrelated promotion-readiness work from the source plan.
- Do not perform broad cleanup, renames, formatting churn, or dependency upgrades.
- Do not change snapshots, fixtures, fake responders, or test doubles merely to hide behavior changes.
- Keep checks safe: doctor/report must not mutate Hub state, registry state, jobs, workers, leases, provider state, or adapters.
- Prefer existing project helpers for command execution, config lookup, Hub access, registry reads, provider state, and redaction.
- JSON output must be stable enough for automation: avoid timestamps in individual checks unless the existing contract already includes them or tests normalize them.
- Redaction applies to both successful and failed checks, including thrown errors and adapter smoke output.

## Next-Action
Implement only P0.1 as described above, using the promotion readiness plan as source of truth. Keep the diff scoped to doctor/readiness reporting and its tests, run the relevant verification commands, then write `wiki/projects/flow/outputs/deliverable-053.md` with implementation notes and evidence.

## Acceptance-Criteria
- [ ] `cpb doctor` or the existing equivalent readiness/report command supports `--json`.
- [ ] Non-JSON doctor/report output still works and preserves existing behavior except for the added readiness findings.
- [ ] JSON output is valid, deterministic, redacted, and includes aggregate status plus individual check records.
- [ ] Readiness checks include Node/npm availability/version.
- [ ] Readiness checks include Git availability/version.
- [ ] Readiness checks include ACP adapter presence, version when available, and smoke readiness.
- [ ] Rust runtime readiness is checked only when Rust runtime is enabled, and Rust unavailable is reported correctly.
- [ ] Hub liveness and writability are checked, including stale or unavailable Hub state.
- [ ] Registry consistency issues are detected and reported.
- [ ] Stale jobs, workers, and leases are detected and reported.
- [ ] Provider backoff or rate-limit state is detected and reported without leaking secrets.
- [ ] Disk-space warning is emitted when free space is below the configured or local doctor threshold.
- [ ] All readiness output applies redaction to secrets, tokens, sensitive paths/details where appropriate, adapter output, and provider details.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub or non-writable Hub.
- [ ] Tests cover stale worker.
- [ ] Tests cover provider rate-limit/backoff state.
- [ ] Tests cover Rust unavailable when Rust runtime is enabled.
- [ ] Relevant doctor/readiness/CLI tests pass.
- [ ] No unrelated cleanup, dependency changes, broad refactors, or behavior changes outside P0.1 are included.
