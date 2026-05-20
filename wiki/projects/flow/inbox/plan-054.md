## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-054
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Extend the existing `cpb doctor` / `cpb report` readiness path instead of introducing a separate readiness command.
- Preserve existing human-readable output and add `--json` as an additive output mode.
- Use one shared readiness result model for text and JSON so checks cannot diverge.
- Implement checks as bounded probes with clear status values: `ok`, `warn`, `fail`, and `skipped`.
- Redact secrets and sensitive local data before any text or JSON output is produced.
- Add or adjust focused tests for the requested P0.1 failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.

### Rejected
- Rejected broad CLI cleanup, unrelated refactors, or promotion-readiness tasks outside P0.1 because the task explicitly limits scope.
- Rejected changing fake/mock tests merely to bless changed behavior; only update test doubles where necessary to model the new readiness probes.
- Rejected adding new dependencies unless the existing codebase has no safe built-in way to perform the required probe.
- Rejected emitting raw command output in reports because readiness output must be redacted.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` readiness checks for the P0.1 promotion gate, including JSON output and tests, while preserving current behavior for existing users.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; use only the P0.1 requirements as implementation authority.
- Existing `cpb doctor` command implementation — add shared readiness checks and `--json` output wiring.
- Existing `cpb report` command implementation — reuse the same readiness model and redacted rendering.
- Existing CLI option/parser tests for `cpb doctor` and `cpb report` — cover `--json` behavior and preservation of existing text behavior.
- Existing readiness/doctor/report test suite — add the five required scenarios plus focused coverage for redaction and registry consistency.
- Existing Hub/registry/provider/worker/job/lease modules — use their public helpers where available; avoid reaching around established boundaries.

**实现步骤**:
1. Read the promotion readiness plan and copy the exact P0.1 acceptance intent into your implementation notes; ignore lower-priority or unrelated items.
2. Locate the existing `cpb doctor` and `cpb report` command paths, their current output tests, and any existing readiness/check abstractions.
3. Define or extend a shared readiness result shape with stable fields: check id, label, status, summary, details, remediation, evidence, and redacted metadata.
4. Add `--json` support to `cpb doctor` and `cpb report`.
   - JSON must be machine-readable, deterministic enough for tests, and include an aggregate status plus per-check results.
   - Existing text output must remain the default and keep current behavior except for additive readiness lines.
5. Implement environment checks for Node, npm, and Git.
   - Detect missing executable, unusable executable, and version where available.
   - Return actionable remediation without throwing uncaught errors.
6. Implement ACP adapter readiness.
   - Check adapter presence.
   - Check adapter version when the adapter exposes one.
   - Add a smoke-readiness probe that confirms the adapter can be invoked or initialized through the existing adapter boundary.
   - Failure must identify missing adapter separately from version/smoke failure.
7. Implement Rust runtime readiness only when Rust support is enabled by existing config or feature detection.
   - If Rust is disabled, report `skipped`.
   - If Rust is enabled but unavailable, report `fail` with remediation.
8. Implement Hub liveness and writability readiness.
   - Check that the configured Hub is reachable through the existing Hub client or local Hub abstraction.
   - Check that required Hub state locations are writable.
   - Detect stale Hub state separately from unreachable Hub.
9. Implement registry consistency checks.
   - Verify registry entries required by the current project are present and internally consistent.
   - Report missing, duplicate, or contradictory registry state as `warn` or `fail` according to existing severity conventions.
10. Implement stale job, worker, and lease checks.
    - Use existing timestamps/heartbeat semantics.
    - Do not delete or mutate stale records during doctor/report.
    - Report stale jobs, stale workers, and stale leases as separate check ids so tests can target each one.
11. Implement provider backoff and rate-limit readiness.
    - Detect active backoff/rate-limit state from the existing provider state store.
    - Surface provider name, retry timing, and remediation in redacted form.
12. Implement disk-space warnings.
    - Check relevant workspace, Hub, and cache/output locations used by the existing system.
    - Warn before hard failure using existing threshold conventions if present; otherwise choose conservative documented thresholds in code comments.
13. Add a central redaction pass.
    - Redact tokens, API keys, credentials, home-directory-sensitive paths where existing code already does so, provider secrets, and raw command output that may contain secrets.
    - Apply redaction to both text and JSON renderers.
14. Add tests before or alongside implementation for:
    - Missing ACP adapter produces a failing check in text and JSON.
    - Stale Hub state is detected without mutating Hub data.
    - Stale worker is reported with a distinct check id.
    - Provider rate limit/backoff is reported and redacted.
    - Rust unavailable fails only when Rust support is enabled and is skipped when disabled.
15. Add additional focused tests for:
    - `--json` returns valid JSON with aggregate status and per-check results.
    - Existing default text output remains available.
    - Registry inconsistency is reported.
    - Disk-space low condition reports a warning.
    - Redaction removes secrets from both text and JSON output.
16. Run the project’s relevant lint/typecheck/test commands and the narrow CLI tests for doctor/report. Do not mark complete until failures are fixed or explicitly documented in the deliverable.
17. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-054.md` with changed files, test evidence, and any remaining risks.

**注意事项**:
- Keep changes scoped to P0.1 readiness checks and tests.
- Preserve existing behavior and output compatibility; `--json` is additive.
- Prefer existing utility functions, Hub clients, provider state readers, registry helpers, redaction helpers, and test fixtures.
- Do not introduce new background cleanup behavior in doctor/report.
- Do not mutate jobs, workers, leases, registry, Hub state, or provider state during readiness checks.
- Make check ids stable and descriptive so future promotion gates can assert on them.
- JSON output must never include unredacted secrets, credentials, tokens, or raw sensitive command output.
- If any requested readiness probe cannot be implemented through existing public boundaries, add the smallest local helper needed and document the boundary reason in the deliverable.

## Next-Action
Implement P0.1 exactly as scoped above, run focused and relevant full verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-054.md` using the handshake deliverable format.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid redacted JSON with aggregate readiness status and per-check results.
- [ ] `cpb report --json` emits valid redacted JSON using the same readiness result model as doctor.
- [ ] Existing default human-readable `cpb doctor` and `cpb report` output remains available and backwards-compatible except for additive readiness information.
- [ ] Node, npm, and Git readiness checks report presence/usability/version where available and fail gracefully when unavailable.
- [ ] ACP adapter readiness covers presence, version where available, and smoke readiness.
- [ ] Rust runtime readiness is checked only when Rust support is enabled; unavailable Rust is reported as a failure only in that enabled state.
- [ ] Hub liveness, Hub writability, and stale Hub state are checked without mutating Hub data.
- [ ] Registry consistency reports missing, duplicate, or contradictory registry state.
- [ ] Stale jobs, stale workers, and stale leases are reported as distinct readiness checks.
- [ ] Provider backoff/rate-limit state is surfaced with redacted provider details and actionable retry/remediation information.
- [ ] Disk-space warnings are emitted for relevant workspace/Hub/cache locations.
- [ ] Text and JSON output pass a shared redaction path that removes secrets, credentials, tokens, and sensitive raw output.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.
- [ ] Additional tests cover `--json`, registry inconsistency, disk-space warning, redaction, and unchanged default text behavior.
- [ ] No unrelated cleanup, broad refactor, dependency addition, or behavior change outside P0.1 is included.
- [ ] Relevant lint/typecheck/test commands pass, or any unavoidable failure is documented with exact command output and a concrete reason in `deliverable-054.md`.
