## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-025
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan 025: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative scope boundary for P0.1; do not implement adjacent P0/P1/P2 work.
- Expand the existing `cpb doctor` / readiness report implementation in place instead of adding a parallel diagnostic command.
- Add a machine-readable `--json` output path that reports stable check IDs, statuses, messages, metadata, and redacted details while preserving current human-readable output behavior.
- Model readiness checks as independent probes so failures such as missing adapter, stale Hub state, stale worker, rate limit backoff, or Rust runtime absence can be tested without relying on the local developer machine.
- Keep redaction centralized for secrets, tokens, credentials, bearer headers, API keys, local auth material, and provider-specific sensitive values before anything is printed or serialized.

### Rejected
- Broad cleanup of doctor/report internals outside P0.1 | violates the instruction to keep changes scoped and preserve existing behavior.
- Hard-failing the whole doctor command on the first failed probe | readiness reports need complete diagnostics across multiple subsystems.
- Testing by mutating real Hub state or relying on installed local adapters | brittle and not suitable for deterministic CI.
- Adding new dependencies for probing or JSON formatting | no new dependency was requested; use existing runtime and test utilities.

### Scope

**目标**: Expand P0.1 readiness checks for `cpb doctor` / report so operators can inspect promotion-blocking environment and runtime issues in both human-readable and `--json` forms, with deterministic tests for the required failure modes.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; use only to confirm P0.1 boundaries.
- CLI entry file for `cpb doctor` / report command — add or wire the `--json` option and preserve existing default output.
- Existing doctor/report readiness module(s) — add the P0.1 checks and shared result schema.
- Existing Hub, registry, provider, worker/job/lease, ACP adapter, and Rust-runtime utility modules — reuse public helpers where possible; add narrow injectable seams only if tests cannot otherwise isolate the probes.
- Existing redaction/sanitization utility, or the closest logging/output utility — ensure all report output paths pass through one redaction function.
- Existing CLI/doctor/report tests — add/adjust coverage for JSON output and the required failure cases without changing fake responders just to make tests pass.

**实现步骤**:
1. Read the promotion readiness plan and locate the exact P0.1 wording, then inspect the existing `cpb doctor` / report command path, output formatter, readiness-check registry, and current tests.
2. Define or extend a readiness result shape with fields equivalent to `id`, `label`, `status`, `severity`, `message`, `details`, and optional remediation. Use stable IDs such as `node`, `npm`, `git`, `acp_adapter`, `rust_runtime`, `hub_liveness`, `hub_writability`, `registry_consistency`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, `disk_space`, and `redaction`.
3. Add `--json` handling at the CLI boundary. The JSON response should include an overall status plus a list of check results. It must not include ANSI formatting, stack traces by default, unredacted paths containing credentials, tokens, provider secrets, bearer values, or raw environment-secret values.
4. Implement or extend probes for Node/npm and Git availability/version using existing command/version helpers if present. Classify missing tools or unsupported versions according to existing doctor severity conventions.
5. Implement ACP adapter readiness checks for presence, version discovery, and smoke readiness. The smoke probe should be bounded and non-destructive. If the adapter is missing, report the specific adapter check as failed/degraded and continue other checks.
6. Add Rust runtime readiness only when the relevant feature/config/env setting enables it. When enabled but unavailable, report a clear failed/degraded result; when disabled, report skipped/not-applicable rather than failing.
7. Add Hub checks for liveness and writability using existing Hub client/storage abstractions. Detect stale Hub state without destructive cleanup. Report stale state as warning/degraded unless the source plan specifies stronger severity.
8. Add registry consistency checks that compare expected registered projects/workers/adapters against the persisted registry state using existing registry readers. Report missing, duplicate, malformed, or orphaned entries with redacted identifiers where needed.
9. Add stale job, worker, and lease checks. Use existing TTL/heartbeat semantics if defined; otherwise add constants local to the readiness module with names that make the thresholds explicit. The probe must report stale workers separately from stale jobs and stale leases.
10. Add provider backoff/rate-limit readiness reporting. Surface active provider backoff, retry-after/rate-limit state, or circuit-open state without making live provider calls. Redact provider keys, request IDs if sensitive, and auth-bearing metadata.
11. Add disk-space warnings for relevant project, Hub, registry, and temp/cache paths. Use existing filesystem helpers if available. Keep thresholds configurable or named constants and report warning/degraded before hard failures.
12. Ensure human-readable output still includes the same existing information plus the new checks in a readable order. Preserve exit-code behavior unless the source plan or existing tests require a stricter readiness failure exit.
13. Add focused tests for:
    - `cpb doctor --json` emits parseable JSON with stable check IDs and no ANSI control codes.
    - Missing ACP adapter produces a failed/degraded adapter result while unrelated checks still run.
    - Stale Hub liveness/writability or stale Hub state is reported with the expected status and message.
    - Stale worker is detected independently from stale jobs and stale leases.
    - Provider rate-limit/backoff state is reported and redacted.
    - Rust runtime enabled but unavailable is reported; Rust disabled is skipped/not-applicable.
    - Redaction removes secrets from both human and JSON output.
14. Run the repository's targeted doctor/report tests first, then the broader relevant test suite used for CLI readiness behavior. Fix production code rather than weakening tests or fake responders.
15. Produce `deliverable-025.md` with changed files, test evidence, any source-plan interpretation notes, and remaining risks.

**注意事项**:
- Do not implement other promotion readiness plan items beyond P0.1.
- Do not broaden into unrelated cleanup, renames, formatting churn, or dependency changes.
- Preserve current doctor/report behavior for users who do not pass `--json`.
- Keep probes non-destructive. Doctor/report should diagnose Hub/registry/job/worker/lease state, not repair it.
- Avoid live network calls to ACP providers during readiness checks; inspect local adapter/provider state and bounded smoke readiness only.
- Do not modify fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to force passing tests after production behavior changes. If an existing fake no longer represents the intended workflow, document the mismatch and add purpose-built verification instead.
- Maintain redaction at output boundaries and any intermediate diagnostic detail included in results.

## Next-Action
Implement P0.1 exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. After implementation, run targeted and relevant broader tests, then write `deliverable-025.md` with changed files, evidence, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` / readiness report includes checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] `cpb doctor --json` or the existing equivalent report command emits parseable JSON with stable check IDs, per-check status, useful messages, and an overall readiness status.
- [ ] Existing human-readable doctor/report behavior is preserved except for the addition of the new P0.1 readiness checks.
- [ ] ACP adapter missing/version/smoke failures are reported without aborting the rest of the readiness report.
- [ ] Rust runtime checks run only when enabled; enabled-but-unavailable is reported, disabled is skipped/not-applicable.
- [ ] Hub liveness and writability failures are reported separately from stale Hub state.
- [ ] Registry consistency issues are detected and reported without mutating registry data.
- [ ] Stale jobs, stale workers, and stale leases are detected and reported as distinct checks.
- [ ] Provider rate-limit/backoff state is surfaced without making live provider calls and without leaking provider secrets.
- [ ] Disk-space warnings are emitted for relevant project/Hub/registry/cache paths before hard failure thresholds.
- [ ] Human and JSON output redact secrets, tokens, API keys, bearer values, credentials, and sensitive provider metadata.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust unavailable, JSON output shape, and redaction.
- [ ] All targeted doctor/report tests pass, plus the broader CLI/readiness test suite appropriate for the changed files.
- [ ] Changed files remain scoped to P0.1; no unrelated cleanup or dependency additions are included.
