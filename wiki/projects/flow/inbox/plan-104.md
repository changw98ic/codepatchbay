## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-104
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan Title
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice: expand `cpb doctor/report` readiness checks for P0.1.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before editing; implement only the P0.1 doctor/report readiness slice described there.
- Keep the implementation scoped to existing `cpb doctor` and report/readiness surfaces; preserve current command behavior and add `--json` as an additive output mode.
- Model readiness checks as structured check results with stable machine-readable fields: check id, status, severity, message, details, remediation, and redacted evidence.
- Reuse existing command, registry, Hub, provider, ACP, Rust-runtime, and redaction helpers where present instead of introducing new dependencies or broad cleanup.
- Redact secrets and sensitive paths/tokens in both text and JSON outputs before printing or serializing.
- Add focused tests for the required failure/readiness cases: missing adapter, stale Hub, stale worker, rate limit/provider backoff, and Rust unavailable.

### Rejected
- Rejected implementing broader promotion-readiness items outside P0.1 because the task explicitly limits scope to expanding `cpb doctor/report` readiness checks.
- Rejected replacing existing doctor/report output wholesale because current behavior must be preserved; add new checks and JSON support compatibly.
- Rejected adding new health-check dependencies or background daemons because this slice should be small, testable, and reversible.
- Rejected modifying fake/mock assets just to make tests pass; only update tests/test doubles when needed to represent the new real readiness contract.

### Scope

**目标**: Expand `cpb doctor` and the corresponding report/readiness output so the command can diagnose promotion readiness locally, emit redacted human-readable output by default, emit redacted structured JSON via `--json`, and cover the P0.1 environment, Hub, registry, worker/job/lease, provider, disk-space, ACP adapter, and Rust-runtime readiness checks.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; do not edit.
- CLI command entry for `cpb doctor` — add/route `--json` without changing existing default output semantics.
- Existing doctor/report readiness implementation module(s) — add structured check result aggregation and required P0.1 checks.
- Existing ACP adapter discovery/version/smoke module(s) — expose or reuse adapter presence, version, and smoke-readiness data for doctor checks.
- Existing Hub client/state module(s) — check liveness, writability, stale Hub state, registry consistency, stale jobs, stale workers, and stale leases.
- Existing provider/backoff module(s) — surface rate-limit/backoff readiness in doctor/report output without performing unrelated provider work.
- Existing Rust-runtime detection/config module(s) — check Rust runtime only when enabled/configured and report unavailable runtime clearly.
- Existing redaction/sanitization module(s) — ensure all doctor/report text and JSON evidence is redacted.
- Existing tests for CLI doctor/report readiness — extend coverage for normal JSON output and required warning/error cases.
- New focused tests only if no suitable existing test file exists — keep test names and fixtures aligned with current project conventions.

**实现步骤**:
1. Read the source-of-truth promotion plan and locate its P0.1 doctor/report readiness requirements. Confirm the implementation checklist matches the required items before touching code.
2. Inspect current `cpb doctor` and report/readiness command flow. Identify the smallest existing module boundary that can own structured readiness checks without moving unrelated code.
3. Define or extend a readiness check result shape used internally by both text and JSON output. Include stable fields for `id`, `status`, `severity`, `message`, optional `details`, optional `remediation`, and optional redacted `evidence`.
4. Add `cpb doctor --json` parsing and output. Keep default human output unchanged except for the new checks. Ensure JSON output is deterministic enough for tests and contains no ANSI formatting.
5. Add environment tool checks for Node/npm and Git. Report missing/unavailable tools as actionable readiness failures or warnings according to existing severity conventions.
6. Add ACP adapter readiness checks: adapter presence, adapter version, and a lightweight smoke-readiness result. Do not perform destructive or long-running adapter actions.
7. Add Rust-runtime readiness only when the Rust runtime feature/config is enabled. If enabled but unavailable, report the required warning/error; if disabled, report skipped/not-applicable rather than failing readiness.
8. Add Hub readiness checks for liveness and writability. Include explicit handling for stale Hub state and ensure write probes are safe, temporary, and cleaned up according to existing Hub patterns.
9. Add registry consistency checks that compare expected registered project/session/provider/adapter state against existing registry sources without mutating registry data.
10. Add stale jobs, stale workers, and stale leases checks using existing timestamp/TTL conventions. Prefer existing staleness helpers; if none exist, add a small local helper with tests and conservative thresholds from the source plan or current config.
11. Add provider backoff/rate-limit readiness reporting. Detect active backoff/rate-limit state and present a clear remediation or retry-after detail when available.
12. Add disk-space warnings using existing filesystem/config paths. Keep thresholds aligned with the source plan or existing project constants.
13. Route every text and JSON message/detail/evidence field through the existing redaction layer. Add a regression test that proves sensitive values are not emitted in `--json` and default output if there is already a redaction test harness.
14. Add or adjust tests for the required cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust enabled but unavailable, and JSON output shape/redaction.
15. Run the project’s relevant targeted tests first, then the standard verification commands required by this repository. Fix only failures caused by this slice.
16. Write the Claude deliverable to `wiki/projects/flow/outputs/deliverable-104.md` with changed files, test evidence, known gaps, and any source-plan interpretation notes.

**注意事项**:
- Keep changes scoped to P0.1. Do not broaden into unrelated cleanup, unrelated promotion-readiness items, UI changes, registry rewrites, or provider behavior changes.
- Preserve existing behavior for users who run `cpb doctor` without `--json`.
- `--json` must be additive and machine-readable; avoid snapshots that depend on wall-clock time, absolute temp paths, or local machine-specific values unless normalized/redacted.
- Treat readiness checks as diagnostics. Avoid destructive probes, network-heavy smoke tests, or state mutations beyond safe temporary Hub writability checks.
- Respect existing fake/mock policy: do not alter fake responders or fixtures merely to hide production regressions. Update test doubles only when they must represent the new readiness contract.
- If the source-of-truth plan specifies severities, thresholds, field names, or exact labels, use those over this handoff’s inferred names.

## Next-Action
Implement the P0.1 `cpb doctor/report` readiness expansion exactly within the scope above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then make the smallest compatible code and test changes. Run relevant tests and standard verification, then write `wiki/projects/flow/outputs/deliverable-104.md`.

## Acceptance-Criteria
- [ ] `cpb doctor` preserves existing human-readable behavior while including the new P0.1 readiness checks.
- [ ] `cpb doctor --json` emits deterministic, valid, redacted JSON with structured check results and no ANSI/control formatting.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit, and disk-space warnings.
- [ ] ACP adapter missing/unavailable is reported with an actionable status and covered by a test.
- [ ] Stale Hub state is reported with an actionable status and covered by a test.
- [ ] Stale worker state is reported with an actionable status and covered by a test.
- [ ] Active provider rate limit/backoff is reported with retry/remediation detail when available and covered by a test.
- [ ] Rust runtime enabled but unavailable is reported without affecting disabled-runtime flows and covered by a test.
- [ ] Text and JSON outputs redact secrets, tokens, sensitive environment values, and sensitive paths according to the existing redaction policy.
- [ ] Existing behavior outside P0.1 is preserved; no unrelated cleanup or broad refactor is included.
- [ ] Relevant targeted tests and the repository’s standard verification commands pass, or any pre-existing/unrelated failures are clearly documented in the deliverable.
