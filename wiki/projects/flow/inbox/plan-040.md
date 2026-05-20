## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-040
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling source for scope. Before implementation, confirm the file exists and that its P0.1 content matches this handoff; if it does not, stop and report the mismatch instead of implementing from memory.
- Implement only P0.1 readiness expansion for `cpb doctor` and `cpb report`; do not take on other promotion-readiness items, cleanup, command redesign, or unrelated test maintenance.
- Use one shared readiness check engine/model for doctor and report so `--json` and human output are fed by the same data.
- Preserve existing human-readable command behavior unless adding the requested readiness lines. Add JSON as an opt-in mode through `--json`.
- JSON output must be machine-readable, deterministic enough for tests, and redacted before printing.
- Readiness result shape should include at minimum: overall status, timestamp, command/tool version context, checks array, check id, status, severity, summary/message, details, and remediation/next action when useful.
- Status semantics: missing required runtime/tool or unavailable enabled feature is `error`; degraded or time-bound conditions such as provider backoff, stale worker records, low disk, or expiring leases are `warning`; intentionally disabled optional checks are `skipped`; healthy checks are `ok`.
- Use dependency injection or existing test helpers for filesystem, process execution, clocks, Hub client/storage, registry state, and provider state so tests do not depend on the developer machine.
- Redaction applies to both human and JSON output, including tokens, API keys, bearer headers, secret env names/values, auth URLs, and user-home-specific paths when those paths are not needed for diagnosis.

### Rejected
- Rejected adding new npm/Rust/system dependencies for this slice; prefer existing Node APIs and project utilities.
- Rejected broad CLI restructuring or replacing current doctor/report formatting; the task is readiness coverage, not command UX redesign.
- Rejected making every warning fatal; keep exit-code behavior aligned with the existing doctor/report contract and only fail on true readiness errors.
- Rejected modifying fake LLM responders, snapshots, fixtures, or test doubles only to force tests green. Add purpose-built readiness tests or update readiness-specific fixtures only.
- Rejected implementing auto-fix/remediation commands for stale Hub state, registry issues, leases, or backoff; this slice reports readiness only.

### Scope

**Goal**: Expand `cpb doctor`/`cpb report` readiness coverage for promotion P0.1 while preserving existing behavior and adding JSON output plus regression tests for the required degraded states.

**Source-of-truth check**:
- Verify the promotion readiness plan exists at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- Read only the P0.1 section and use it to confirm this handoff's scope before editing.
- If the file is missing or the P0.1 requirements materially differ, write the blocker into the deliverable and do not broaden the implementation.

**Expected files to inspect/modify**:
- Existing `cpb doctor` command module — add/wire readiness execution and `--json`.
- Existing `cpb report` command module — reuse the same readiness engine and expose the same JSON-ready result.
- Existing CLI argument/parser module, if doctor/report flags are centralized — add the `--json` flag without changing existing defaults.
- Existing Hub client/storage module — use current liveness, state, and write paths for Hub liveness/writability checks.
- Existing registry/state module — validate registry consistency, stale jobs, stale workers, and stale leases using current schema/constants.
- Existing provider state/backoff module — surface active rate-limit/backoff state as warning readiness checks.
- Existing config/runtime module — detect whether Rust runtime checks are enabled and where ACP adapter configuration is sourced.
- New or existing readiness module adjacent to the current doctor/report implementation — define shared check types, check runner, JSON serialization, redaction, and human formatting helpers.
- Existing CLI/readiness test files — add coverage for missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, JSON output, and redaction.

**Implementation steps**:
1. Confirm scope and command locations.
   - Read the P0.1 section from the promotion readiness plan.
   - Locate the existing `cpb doctor` and `cpb report` entrypoints, current exit-code behavior, test harness, Hub/registry/provider utilities, and any current redaction helper.
   - Record the concrete files changed in the deliverable.

2. Add a shared readiness result model.
   - Create or extend a readiness module with `ReadinessReport`, `ReadinessCheck`, `ReadinessStatus`, and `ReadinessContext`.
   - Include stable check ids such as `node`, `npm`, `git`, `acp-adapter`, `rust-runtime`, `hub-liveness`, `hub-writability`, `registry-consistency`, `stale-jobs`, `stale-workers`, `stale-leases`, `provider-backoff`, and `disk-space`.
   - Compute overall status from check severities without changing existing non-JSON exit semantics except where current doctor behavior already fails on errors.

3. Implement environment/runtime checks.
   - Node/npm: report detected versions and compare against existing engine/version requirements if the project already defines them.
   - Git: report presence/version and required failure if unavailable.
   - ACP adapter: validate configured adapter presence, readable/executable or package-resolvable path, version discovery, and a safe smoke-readiness probe using an existing non-mutating command if available.
   - Rust runtime: run only when existing config/env says Rust runtime is enabled; report `skipped` when disabled and `error` when enabled but unavailable.
   - Disk space: check relevant CPB data/cache/temp directories with existing thresholds if present; otherwise define conservative constants in the readiness module and warn before hard failure.

4. Implement Hub and state checks.
   - Hub liveness: use existing ping/heartbeat/status API or persisted heartbeat state; stale or unreachable Hub should be reported without corrupting state.
   - Hub writability: perform a safe temp write probe in the existing Hub data location and clean it up; if cleanup fails, report a warning with redacted path details.
   - Registry consistency: parse existing registry state and detect dangling project/job/worker/lease/provider references, duplicate ids, invalid timestamps, and schema/version mismatch using existing validators when available.
   - Stale jobs/workers/leases: apply existing TTL constants where present; stale workers and leases should be warnings unless the existing system treats them as fatal, while stale blocked jobs should include remediation text.
   - Provider backoff: surface active provider rate-limit/backoff with provider id/name redacted as needed, retry-after timing, and warning severity.

5. Wire `cpb doctor` and `cpb report`.
   - Add `--json` to both commands or the shared option parser used by both.
   - Human mode: preserve current formatting and append readiness checks consistently.
   - JSON mode: print only redacted JSON to stdout, with no banners, spinners, ANSI color, or extra text.
   - Ensure errors still route through the existing CLI error handling and do not expose secrets.

6. Add focused tests.
   - Missing adapter: configured ACP adapter missing or unresolvable returns an `acp-adapter` error and redacted JSON details.
   - Stale Hub: stale heartbeat or unwritable Hub storage reports `hub-liveness`/`hub-writability` degraded status.
   - Stale worker: worker heartbeat past TTL reports `stale-workers` warning with worker id redacted or normalized.
   - Rate limit: provider backoff/rate-limit state reports `provider-backoff` warning with retry-after.
   - Rust unavailable: when Rust runtime is enabled and binary/toolchain is unavailable, `rust-runtime` is an error; when disabled, it is skipped.
   - JSON output: `cpb doctor --json` and `cpb report --json` parse cleanly and include the expected top-level shape.
   - Redaction: secrets in env/config/provider URLs/headers are scrubbed in both human and JSON output.
   - Preserve existing tests; adjust only readiness-specific assertions when existing doctor/report output legitimately gains new P0.1 lines.

7. Verify and deliver.
   - Run the repo's targeted CLI/readiness tests first, then the standard test/lint/typecheck commands documented by the project.
   - Confirm non-JSON doctor/report behavior remains compatible with previous behavior except for added readiness checks.
   - Confirm JSON output is valid, stable, redacted, and contains every required P0.1 check id.
   - Write `deliverable-040.md` with changed files, test evidence, remaining risks, and any source-plan mismatch.

**Notes**:
- Keep the diff small and reversible. Add no unrelated cleanup.
- Prefer existing utilities for command execution, filesystem access, redaction, time, and logging.
- Do not let smoke checks mutate Hub, registry, provider, ACP, or Rust state.
- If a check cannot be implemented because the underlying state does not exist yet, represent it explicitly as `skipped` or `warning` with a reason only if the source plan allows that; otherwise report the blocker.

### Evidence
- Planning-only phase; no terminal commands were executed.
- Read-only code-intel lookup in this planning surface reported the promotion plan path as unavailable, so execution must verify the path before implementation.

### Risks
- The exact doctor/report source file paths were not confirmed in this phase because terminal commands were prohibited and local code-intel could not resolve the promotion plan path.
- ACP adapter and Rust runtime semantics may already have project-specific config names; use existing config sources rather than inventing new ones.
- Hub liveness/writability probes must be non-mutating or self-cleaning to avoid changing user state during `doctor`/`report`.
- JSON schema may become an integration surface; keep it simple and document only what this task needs unless the source plan already specifies a schema.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, beginning by verifying the source-of-truth promotion plan path and locating the existing doctor/report implementation. Run targeted and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-040.md` using the handshake protocol.

## Acceptance-Criteria
- [ ] Source-of-truth plan path is verified before implementation, or a blocker is reported if it is missing/mismatched.
- [ ] `cpb doctor --json` emits valid redacted JSON with no non-JSON text.
- [ ] `cpb report --json` emits valid redacted JSON or includes the same readiness JSON section through the command's established report schema.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff, and disk-space warnings.
- [ ] Existing non-JSON doctor/report behavior is preserved except for the added P0.1 readiness information.
- [ ] Missing ACP adapter test fails the adapter check with an error and redacted details.
- [ ] Stale Hub or unwritable Hub test reports degraded Hub readiness.
- [ ] Stale worker test reports stale worker readiness without exposing sensitive identifiers.
- [ ] Provider rate-limit/backoff test reports warning readiness with retry-after/backoff context.
- [ ] Rust unavailable test reports an error only when Rust runtime is enabled and reports skipped/ok behavior when disabled.
- [ ] Redaction tests prove secrets are removed from human and JSON output.
- [ ] Targeted CLI/readiness tests pass.
- [ ] Standard project verification requested by repo docs passes, or any unavailable verification is documented with a reason.
- [ ] Changed files are scoped to P0.1 and listed in the deliverable.
