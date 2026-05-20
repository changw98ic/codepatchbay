## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-059
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth, but implement only P0.1.
- Expand the existing `cpb doctor` and `cpb report` readiness surface rather than creating a separate readiness command.
- Add a machine-readable `--json` output path while preserving current human-readable output and exit behavior unless the promotion readiness plan explicitly says otherwise.
- Centralize readiness probe logic in the existing CLI readiness/doctor/report layer so `doctor` and `report` do not drift.
- Redact secrets at the final report serialization/output boundary and in any structured diagnostic payloads used by tests.
- Add focused tests for the required P0.1 failure/readiness cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled.

### Rejected
- Broad CLI cleanup outside readiness checks — out of scope for P0.1 and risks behavior changes.
- New dependencies for command parsing, disk probing, redaction, or table formatting — not requested; use existing utilities and Node standard APIs where possible.
- Rewriting fake/mock test infrastructure just to satisfy new expectations — preserve existing behavior and only adjust tests that directly cover readiness output.
- Implementing P1/P2 promotion readiness items from the source plan — explicitly out of scope.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for P0.1 promotion readiness. The result must provide human-readable and `--json` readiness output covering Node/npm, Git, ACP adapter presence/version/smoke readiness, optional Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redacted diagnostics.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; source-of-truth scope boundary for P0.1.
- `/Users/chengwen/dev/flow/packages/cli/src/commands/doctor.ts` — likely `cpb doctor` command entrypoint; add/route expanded readiness checks and `--json`.
- `/Users/chengwen/dev/flow/packages/cli/src/commands/report.ts` — likely `cpb report` command entrypoint; include the same readiness summary/check payload without duplicating probe logic.
- `/Users/chengwen/dev/flow/packages/cli/src/readiness.ts` — create or update only if the repo already has a nearby shared CLI diagnostic/readiness module; house reusable probe orchestration and result typing.
- `/Users/chengwen/dev/flow/packages/cli/src/redaction.ts` — create or update only if no existing redaction helper is available; otherwise reuse the existing helper and add readiness coverage there.
- `/Users/chengwen/dev/flow/packages/cli/test/doctor.test.ts` — add/adjust doctor tests for `--json`, missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.
- `/Users/chengwen/dev/flow/packages/cli/test/report.test.ts` — add/adjust report tests for JSON inclusion/redaction and shared readiness payload shape.
- `/Users/chengwen/dev/flow/packages/cli/test/readiness.test.ts` — create or update focused unit tests for probe classification only if existing command-level tests would become too broad.

If the actual repository paths differ, modify the existing files that own the same `cpb doctor`, `cpb report`, readiness diagnostics, and CLI tests. Do not create parallel command implementations.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and write down the exact acceptance boundaries before editing. Do not implement adjacent promotion readiness items.
2. Locate the current `cpb doctor` and `cpb report` command implementations, their option parsing, and existing tests. Identify current output format, exit-code semantics, and any existing diagnostic helpers so behavior can be preserved.
3. Define a small shared readiness result model with stable fields: `status` (`ok`, `warn`, `fail`), `checks[]`, `summary`, and per-check metadata. Include check IDs for `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub`, `registry`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, and `disk_space`.
4. Implement `--json` for `cpb doctor` and the readiness section of `cpb report`. JSON output must be deterministic, parseable, redacted, and suitable for tests. Human output should continue to be readable and should not expose secrets.
5. Add environment/tooling probes:
   - Node/npm: report versions and fail only when required executable/version expectations are not met.
   - Git: report presence/version and repository readiness if current behavior already checks repo context.
   - ACP adapter: report presence, version if discoverable, and smoke readiness using the existing adapter invocation path with a bounded/non-destructive smoke check.
   - Rust runtime: run only when Rust-backed runtime is enabled by current config/env; warn/fail as specified by P0.1 when unavailable.
6. Add runtime/state probes:
   - Hub liveness and writability: distinguish unreachable/stale Hub from live-but-not-writable Hub.
   - Registry consistency: detect missing, duplicate, or inconsistent registry entries using the existing registry storage APIs.
   - Stale jobs/workers/leases: classify stale records without deleting them during doctor/report.
   - Provider backoff/rate limit: surface active backoff windows and rate-limit state as warning/failure according to existing provider semantics.
   - Disk space: warn when available space is below the readiness threshold from the source plan or the repo's existing config default.
7. Apply redaction consistently to command output, JSON output, thrown diagnostic messages included in reports, provider URLs/tokens, env-derived values, Hub paths that may include secrets, and adapter smoke output.
8. Add focused tests without changing unrelated fake responders or snapshots:
   - `cpb doctor --json` returns parseable JSON with expected check IDs and redacted values.
   - Missing ACP adapter is reported with the correct status and actionable message.
   - Stale Hub is reported distinctly from normal Hub liveness failure.
   - Stale worker is detected without mutating worker records.
   - Provider rate limit/backoff is reported and redacted.
   - Rust unavailable is reported only when Rust runtime is enabled.
   - `cpb report` includes the readiness payload/summary and preserves existing report behavior.
9. Run the narrowest relevant tests first, then the CLI package's normal lint/typecheck/test commands. If a repository-wide suite is standard and affordable, run it after the narrow suite passes.
10. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-059.md` after implementation with changed files, evidence, known risks, and any source-plan items intentionally left out because they are not P0.1.

**注意事项**:
- Keep the implementation scoped to P0.1. Do not rename commands, change unrelated report sections, migrate storage, or refactor CLI architecture.
- Preserve existing command defaults and human output compatibility wherever possible; add JSON output as an option, not as a replacement.
- Readiness probes must be non-destructive. `doctor` and `report` should observe stale jobs/workers/leases, not clean them up.
- Use existing config, registry, Hub, provider, ACP adapter, and redaction utilities before adding new helpers.
- Avoid brittle tests that depend on local machine versions; mock command/version probes through existing seams or inject probe functions.
- JSON output must never include raw tokens, API keys, Authorization headers, provider credentials, private env values, or unredacted adapter output.
- If a required readiness check cannot be implemented because the underlying state is not persisted yet, surface the best available warning and document the limitation in the deliverable rather than broadening scope.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, using the promotion readiness plan as the source of truth. Run targeted CLI tests and the repo's normal verification for the touched package, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-059.md` with implementation evidence.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits deterministic, parseable, redacted JSON containing summary status plus readiness checks for Node/npm, Git, ACP adapter, optional Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, and disk space.
- [ ] Existing human-readable `cpb doctor` behavior is preserved except for the added readiness checks/messages required by P0.1.
- [ ] `cpb report` includes the expanded readiness results or summary without duplicating probe implementation and without regressing existing report content.
- [ ] ACP adapter readiness covers missing adapter, discoverable version, and non-destructive smoke readiness.
- [ ] Rust runtime is checked only when enabled and reports unavailable Rust with the correct warning/failure classification.
- [ ] Hub liveness and writability checks distinguish stale/unreachable Hub, live read-only Hub, and healthy writable Hub.
- [ ] Registry consistency detects and reports inconsistent registry state using existing registry APIs.
- [ ] Stale jobs, stale workers, and stale leases are reported without being mutated or cleaned up by doctor/report.
- [ ] Provider backoff/rate-limit state is reported with redacted provider details.
- [ ] Disk-space warnings are emitted at the threshold required by the promotion readiness plan or existing repo config.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, `--json` output, and redaction.
- [ ] No unrelated cleanup, command rename, storage migration, broad refactor, or P1/P2 promotion readiness work is included.
- [ ] All relevant targeted tests pass, and any broader lint/typecheck/test command that was run is recorded in `deliverable-059.md`.
