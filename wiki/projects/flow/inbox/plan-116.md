# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-116-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for this implementation and resolve any ambiguity against its P0.1 requirements.
- Scope implementation to P0.1 readiness checks for `cpb doctor` / report output only; do not expand into unrelated CLI cleanup, Hub rewrites, provider behavior changes, or registry redesign.
- Reuse the existing readiness service surface: `server/services/readiness-checks.js` currently exposes `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Reuse the existing diagnostics/report integration surface: `server/services/diagnostics-bundle.js` currently exposes `gatherReadinessReport`.
- Preserve existing human-readable doctor/report behavior while adding or completing structured `--json` output.
- Model each readiness probe as a structured check with stable identifiers, severity/status, redacted detail, and enough machine-readable fields for automation.
- Redaction is part of the P0.1 contract: any paths, tokens, env values, URLs, adapter output, Hub metadata, and provider error payloads that may contain secrets must be sanitized before human or JSON output.

### Rejected
- Rejected broad refactor of CLI command routing: P0.1 only needs doctor/report readiness expansion and tests.
- Rejected adding new runtime dependencies for probing, formatting, or redaction: use Node standard library and existing project utilities unless the source-of-truth plan explicitly requires otherwise.
- Rejected changing fake/mock assets only to make tests pass: if existing fakes do not represent real workflow readiness, add focused test harnesses or purpose-built fixtures that validate the intended checks.
- Rejected making `--json` a separate behavior path with different checks: human and JSON output should format the same underlying readiness result.

### Scope

**目标**: Implement P0.1 by expanding `cpb doctor` / readiness report checks so a promotion operator can determine readiness from either human output or `--json`, with actionable failures and warnings for local prerequisites, ACP adapter readiness, optional Rust runtime, Hub health, registry consistency, stale execution state, provider backoff/rate limits, disk pressure, and redaction.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; do not edit.
- `server/services/readiness-checks.js` — primary implementation for readiness probes, result schema, human formatting, JSON formatting, redaction, and stale-state checks.
- `server/services/diagnostics-bundle.js` — ensure report/diagnostics readiness gathering uses the expanded checks and emits the same sanitized structured data.
- Existing `cpb doctor` CLI command file discovered in the repo — add or wire `--json` output to the shared readiness result without changing unrelated command behavior.
- Existing doctor/readiness test file(s) discovered in the repo — add regression coverage for the P0.1 cases.
- Existing diagnostics/report test file(s) discovered in the repo — adjust only if report readiness output needs coverage for the shared schema/redaction.

**实现步骤**:
1. Read the P0.1 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` first and copy its readiness requirements into a private implementation checklist. Do not implement items outside P0.1.
2. Inspect the existing `cpb doctor` command wiring and the readiness/report services. Identify the current result shape, exit-code rules, human formatter, JSON formatter, test utilities, and any existing Hub/registry/provider helpers before editing.
3. Define or extend a single readiness result schema in `server/services/readiness-checks.js`. Each check should have a stable `id`, user-facing `label`, `status` such as `ok` / `warn` / `fail` / `skip`, `severity`, sanitized `summary`, optional sanitized `details`, and optional structured `metadata`.
4. Implement prerequisite checks for Node, npm, and Git. Capture presence and version where available; report missing tools as failures when required for promotion readiness. Keep command execution bounded and non-interactive, and sanitize all collected output.
5. Implement ACP adapter readiness. Verify adapter presence, version discovery, and a smoke-readiness path that proves it can be invoked or initialized without performing destructive work. Missing adapter must produce a deterministic failure covered by tests.
6. Implement Rust runtime readiness only when Rust is enabled by existing configuration or environment. When enabled, report missing/unavailable Rust as a warning or failure according to the promotion plan. When not enabled, emit a clear skipped check rather than failing.
7. Implement Hub liveness and writability checks. Confirm the Hub can be reached through existing project APIs and that the configured writable location is usable without mutating real user data beyond existing safe probe conventions. Stale/unreachable Hub state must be distinguishable from write failures.
8. Implement registry consistency checks using existing registry-loading utilities. Detect unreadable registry data, malformed entries, duplicate/conflicting records, missing referenced project paths, or mismatches that the current registry model already knows how to validate.
9. Implement stale execution-state checks for jobs, workers, and leases. Use existing timestamp/status conventions to detect stale jobs, stale worker heartbeats, and expired or orphaned leases. Surface stale items as warnings unless the source-of-truth plan requires failure.
10. Implement provider backoff/rate-limit readiness. Detect active provider backoff or rate-limit state from existing provider state files/services and report the provider, reset/backoff time if safe to reveal, and sanitized reason. Add the required rate-limit test case.
11. Implement disk-space warnings for relevant writable roots: project workspace, Hub storage, registry/state directory, and any configured worktree/job directory. Report warning thresholds from existing config if present; otherwise use the threshold required by the promotion plan.
12. Centralize redaction before formatting. Apply it to human output, JSON output, errors, command stderr/stdout snippets, provider messages, paths or URLs with credentials, tokens, env-like values, and adapter smoke output.
13. Wire `cpb doctor --json` to emit valid JSON for the same readiness result used by human output. Ensure non-JSON output remains readable and backwards-compatible. Preserve existing exit-code semantics unless the P0.1 plan specifies a change; if changing, document and test it.
14. Ensure readiness report/diagnostics output includes the expanded sanitized readiness result, not a second divergent implementation.
15. Add focused tests for the required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled. Include JSON-shape assertions and redaction assertions where those scenarios expose sensitive detail.
16. Run the project’s relevant tests for doctor/readiness/report behavior, plus lint/typecheck/static checks required by the repo. If a broad suite is too expensive, run the narrow suite first and record exactly what was and was not run in the deliverable.
17. Self-review the diff for scope creep. Confirm no unrelated cleanup, no dependency additions, no fixture-only test cheating, no unredacted sensitive values, and no behavior changes outside P0.1 doctor/report readiness.

**注意事项**:
- Keep changes tightly scoped to P0.1. Do not implement later promotion-readiness phases from the source plan.
- Prefer existing helper APIs for Hub, registry, workers, jobs, leases, providers, config, and command execution.
- Do not introduce blocking network calls, long-running smoke tests, destructive probes, or write probes that leave durable test artifacts.
- JSON output must be deterministic enough for tests and automation: stable top-level fields, stable check IDs, and no human-only formatting embedded as the only source of truth.
- Human output should summarize failures/warnings clearly but should not reveal secrets or raw provider/adapter payloads.
- Existing behavior must be preserved for users who run `cpb doctor` without `--json`.
- If the source-of-truth plan contradicts any detail in this handoff, follow the source-of-truth plan and call out the adjustment in the deliverable.

## Next-Action
Implement the scoped P0.1 readiness expansion described above, run the relevant verification, then write `deliverable-116.md` with changed files, test evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits parseable structured JSON based on the same readiness checks as human output.
- [ ] Existing `cpb doctor` human output remains backwards-compatible while including the new P0.1 readiness signals.
- [ ] Readiness checks cover Node version, npm version, Git version/presence, ACP adapter presence/version/smoke readiness, optional Rust runtime readiness, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust unavailable is reported only when Rust is enabled by existing config/environment, and Rust-disabled environments do not fail readiness solely because Rust is absent.
- [ ] Hub failures distinguish liveness problems from writability problems.
- [ ] Stale jobs/workers/leases include enough sanitized metadata to act on without leaking secrets.
- [ ] Provider backoff/rate-limit output identifies affected provider state and reset/backoff timing when safe after redaction.
- [ ] Human and JSON outputs redact secrets from paths, URLs, environment-like values, adapter smoke output, provider payloads, and raw errors.
- [ ] Diagnostics/report readiness uses the expanded checks and does not maintain a divergent duplicate readiness implementation.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.
- [ ] Tests include at least one JSON output assertion and at least one redaction assertion for the new readiness behavior.
- [ ] All relevant doctor/readiness/report tests pass.
- [ ] Lint, typecheck, and static analysis required by the repo pass, or any unavailable command is explicitly reported with reason.
- [ ] No unrelated cleanup, dependency addition, fixture-only workaround, or non-P0 behavior expansion is included.
