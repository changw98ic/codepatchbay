## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-070
- **Timestamp**: 2026-05-19

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as authoritative for scope and terminology; implement only P0.1.
- Keep `cpb doctor` and `cpb report` behavior compatible for existing human-readable output and exit-code semantics unless the current P0.1 source plan explicitly requires a change.
- Add a shared readiness assessment model so human output and `--json` output are generated from the same check results.
- `--json` output must be parseable JSON only, with no progress logs, stack traces, ANSI color, or unredacted secrets mixed into stdout.
- Readiness checks must cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- Use existing project utilities, config loading, Hub/registry APIs, logging conventions, and test framework. Do not add dependencies for this slice.
- Tests must be purpose-built around readiness behavior and must not rewrite fake/mock assets merely to force old tests to pass.

### Rejected
- Implementing unrelated promotion-readiness items from the source plan, because this handoff is limited to P0.1.
- Refactoring the broader CLI or Hub architecture, because the requested slice is readiness coverage, JSON output, and tests.
- Maintaining separate doctor/report check implementations, because that would let human and JSON readiness behavior drift.
- Running unbounded adapter or runtime smoke commands, because doctor/report must not hang on broken local environments.
- Printing raw environment variables, provider headers, tokens, auth material, or full error payloads, because readiness output must be redacted.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for promotion readiness P0.1, add `--json` output, preserve existing behavior, and cover the required degraded-environment scenarios with tests.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first as source of truth; do not modify.
- Existing `cpb doctor` command owner — add/route readiness assessment and `--json` handling.
- Existing `cpb report` command owner — expose the same readiness assessment and `--json` handling without duplicating checks.
- Existing CLI argument parsing/types for `cpb doctor` and `cpb report` — add the `--json` option where the current CLI architecture expects options to live.
- Existing readiness/diagnostics/health module, or a new narrowly scoped adjacent module if none exists — define shared result types, probe orchestration, redaction, status aggregation, and timeout handling.
- Existing Hub/registry/provider state modules — read liveness, writability, stale Hub/job/worker/lease, registry consistency, and provider backoff signals through current APIs.
- Existing tests for doctor/report/diagnostics, plus adjacent new tests if needed — cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, JSON shape, and redaction.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and write down any exact status names, thresholds, or output expectations already specified there. Do not implement P0.2/P1/P2 items.
2. Locate the current `cpb doctor` and `cpb report` command implementations, their option parsing, existing tests, and any current diagnostics/readiness helpers. Preserve current command names, default output mode, and user-facing behavior except for the new readiness content required by P0.1.
3. Introduce or extend a shared readiness result model with stable fields such as overall status, check code, status (`ok`, `warn`, `fail`, `skipped`), message, redacted details, remediation hint when available, and timestamp/source metadata. Keep the model small and serializable.
4. Add a readiness runner that executes independent probes with bounded timeouts and dependency injection/test seams. The runner should aggregate status deterministically so hard failures make the overall result fail, warnings keep the command warning-only, and skipped checks are explicit.
5. Implement environment probes:
   - Node presence and version.
   - npm presence and version.
   - Git presence and version.
   Use existing command-execution helpers if present, apply timeouts, and report missing binaries as readiness failures or warnings according to the source plan/current doctor semantics.
6. Implement ACP adapter readiness:
   - Detect adapter presence using the existing configured adapter path/package resolution.
   - Capture adapter version when available.
   - Run the lightest existing smoke-readiness path that proves the adapter can start/respond without mutating project state.
   - Fail clearly when the adapter is missing, incompatible, or cannot complete smoke readiness within timeout.
7. Implement Rust runtime readiness only when the runtime is enabled by existing config/env/feature flag:
   - If disabled, emit a `skipped` check.
   - If enabled and runtime tooling/binary is unavailable, emit a failure covered by tests.
   - If enabled and available, report version/availability without changing runtime state.
8. Implement Hub readiness through existing Hub APIs:
   - Liveness/heartbeat freshness.
   - Storage/writability check using the existing Hub state directory or persistence abstraction.
   - Stale Hub detection using the project’s existing heartbeat/lease thresholds, or the threshold specified in the source plan.
   Avoid destructive writes; use a temp probe file only if the existing persistence layer has no safer writability check.
9. Implement registry consistency checks:
   - Detect records pointing at missing/unreadable project paths or invalid Hub entries.
   - Detect duplicate/conflicting registration state if the current registry supports it.
   - Report fixable drift as warnings unless the source plan defines it as a failure.
10. Implement stale jobs/workers/leases checks:
   - Detect stale jobs by last update/heartbeat against the existing timeout rules.
   - Detect stale workers by worker heartbeat age.
   - Detect expired or orphaned leases.
   - Include concise remediation hints, but do not clean or mutate stale state in doctor/report.
11. Implement provider backoff/rate-limit readiness:
   - Read existing provider backoff state, retry-after, or rate-limit markers.
   - Report active backoff/rate-limit as a warning or failure according to existing semantics/source plan.
   - Redact provider names, endpoints, request IDs, and error details only as needed to avoid leaking credentials or sensitive payloads.
12. Implement disk-space readiness:
   - Check free space for the project workspace and Hub/state storage locations using existing filesystem utilities where available.
   - Warn when below the project’s existing threshold or the P0.1 threshold from the source plan.
   - Report inability to measure disk space as a warning, not a crash.
13. Implement redaction as a final pass over all human and JSON output details:
   - Mask tokens, API keys, authorization headers, cookies, provider credentials, secret env var values, and credential-bearing URLs.
   - Keep non-secret diagnostic context useful, including check codes, status, binary names, versions, and local paths unless the source plan says paths must be hidden.
14. Add `--json` output to both doctor and report paths:
   - `cpb doctor --json` emits the readiness JSON object to stdout.
   - `cpb report --json` emits equivalent readiness data in the report JSON shape or the same shared object if no report schema already exists.
   - No ANSI color, human text, or logs should appear in JSON stdout.
   - Preserve existing non-JSON output and existing exit-code behavior as much as possible.
15. Add/adjust tests:
   - Missing ACP adapter produces the expected failing check and JSON status.
   - Stale Hub state produces the expected stale Hub warning/failure.
   - Stale worker/lease state is reported without mutating state.
   - Provider rate-limit/backoff state is reported and redacted.
   - Rust unavailable fails only when Rust runtime is enabled and is skipped when disabled.
   - JSON output parses cleanly and includes the required check coverage.
   - Human output remains readable and does not expose secret values.
16. Run the targeted test suite for the changed command/readiness code first, then the project’s normal lint/typecheck/test commands that apply to this package. Capture exact commands and outputs in `deliverable-070.md`.
17. Before handoff, self-review the diff for scope creep. Remove unrelated cleanup, formatting churn, and broad refactors not required by P0.1.

**注意事项**:
- Do not broaden into unrelated cleanup, dependency upgrades, command renames, Hub migrations, or automatic stale-state repair.
- Do not mutate real jobs/workers/leases during doctor/report checks.
- Keep smoke checks bounded and non-destructive.
- Prefer existing config and state abstractions over direct ad hoc filesystem parsing.
- Ensure tests use temporary isolated state and deterministic clocks/thresholds where the existing test framework supports them.
- Keep errors actionable but sanitized; raw exception payloads should not bypass redaction.

## Next-Action
Implement P0.1 exactly as scoped above, run the relevant verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-070.md` with changed files, evidence, remaining risks, and any deviations required by the source promotion readiness plan.

## Acceptance-Criteria
- [ ] The executor confirms the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read before implementation.
- [ ] `cpb doctor` and `cpb report` preserve existing non-JSON behavior while adding the P0.1 readiness checks.
- [ ] `cpb doctor --json` emits valid JSON only and includes overall status plus per-check results.
- [ ] `cpb report --json` emits valid JSON only and includes the same readiness coverage or a documented superset in the existing report schema.
- [ ] Readiness output includes Node/npm versions or missing-tool failures.
- [ ] Readiness output includes Git version or missing-tool failure.
- [ ] Readiness output includes ACP adapter presence, version when available, and bounded smoke readiness.
- [ ] Missing ACP adapter is covered by an automated test.
- [ ] Rust runtime readiness is checked when enabled, skipped when disabled, and Rust-unavailable-when-enabled is covered by an automated test.
- [ ] Hub liveness and writability are checked without destructive mutation.
- [ ] Stale Hub state is covered by an automated test.
- [ ] Registry consistency drift is detected and reported.
- [ ] Stale jobs, stale workers, and stale leases are detected and reported without cleanup side effects.
- [ ] Stale worker or stale lease state is covered by an automated test.
- [ ] Provider backoff/rate-limit state is detected and covered by an automated test.
- [ ] Disk-space warnings are emitted for low-space conditions and measurement failures do not crash doctor/report.
- [ ] Human and JSON outputs redact tokens, API keys, authorization material, cookies, provider credentials, secret env values, and credential-bearing URLs.
- [ ] Redaction behavior is covered by automated tests or by an existing redaction test extended for readiness output.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, broad refactors, or non-P0.1 promotion items are included.
- [ ] Targeted tests for doctor/report/readiness pass.
- [ ] The project’s applicable lint/typecheck/test verification passes, or any unavailable command is documented with the exact blocker in the deliverable.
- [ ] `deliverable-070.md` lists changed files, test evidence, simplifications made, and remaining risks.
