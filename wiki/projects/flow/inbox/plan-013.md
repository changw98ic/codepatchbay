## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-013-P0.1
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Title
Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only its P0.1 doctor/report readiness slice.
- Keep the change inside the existing `cpb doctor` and `cpb report` command ownership boundaries. Reuse the current CLI parser, output formatting, config loading, registry access, Hub access, provider/backoff state, and test harness.
- Add a shared readiness collector only if the current code already has duplicated doctor/report readiness logic or if sharing is the smallest scoped way to keep `doctor` and `report` consistent.
- Add `--json` output for readiness results without removing or reshaping the existing default human-readable output.
- Preserve existing command exit-code behavior unless the current doctor/report contract already defines nonzero exit on readiness errors. If a change is required by the source plan, document it in the deliverable.
- Model every readiness result as a structured check with stable `id`, `status`, `summary`, optional redacted `details`, optional `remediation`, and optional `severity`.
- Use `ok`, `warn`, `error`, and `skip` statuses. Missing required runtime dependencies and unavailable enabled runtimes are `error`; optional disabled runtimes are `skip`; stale state, disk pressure, active provider backoff, and recoverable registry drift are `warn` unless the existing product contract says they are fatal.
- Redact secrets and sensitive local values before both text and JSON rendering. Redaction must cover environment-derived tokens, provider keys, credentials in URLs, auth headers, and any existing project-specific secret patterns.
- Tests must be deterministic and use existing fake filesystem/process/time/network seams where available. Do not call real provider APIs, mutate a real user Hub, or require real missing tools on the developer machine.

### Rejected
- Rejected broad readiness-system cleanup or command rewrites: this task is only P0.1 and must preserve existing behavior.
- Rejected adding a new dependency for CLI formatting, semver parsing, disk-space probing, or redaction unless the repo already uses it in the same package.
- Rejected real network/provider smoke calls for ACP adapter readiness: doctor/report should smoke local adapter availability and invocation readiness without consuming provider quota.
- Rejected hardcoding Node/npm/Rust version policy independently of repo metadata: read existing `package.json`, config, feature flags, or source-plan requirements first.
- Rejected editing snapshots, fixtures, fake responders, or test doubles merely to hide behavior changes. Add or adjust purpose-built readiness tests instead.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness coverage for P0.1 while preserving existing command behavior and keeping the diff limited to the existing CLI/readiness/test surfaces.

**Source-of-truth file**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first and use to confirm P0.1 details before implementation.

**Implementation file ownership**:
- Existing `cpb doctor` command module - add or route to expanded readiness checks and support `--json`.
- Existing `cpb report` command module - include the same readiness results/report section and support `--json` if report has command-local output handling.
- Existing readiness/diagnostics/health module, if present - add the check implementations here instead of embedding logic in command handlers.
- Existing config/registry/Hub/provider-state helpers - reuse for inputs; only add tiny read-only helpers if no current helper exposes the needed state.
- Existing CLI test files for `doctor`, `report`, readiness, diagnostics, registry, Hub, provider backoff, and Rust feature handling - add focused coverage for the P0.1 cases.

**Readiness checks to implement**:
1. Node/npm readiness.
   - Detect Node executable and version.
   - Detect npm executable and version.
   - Compare against existing repo metadata or source-plan constraints when present.
   - Report missing executable or unsupported version with remediation.
   - Do not fail on version policy that the repo does not define.

2. Git readiness.
   - Detect Git executable and version.
   - Confirm Git operations required by current CPB flows can be initialized/read from the current workspace.
   - Preserve existing behavior around dirty worktrees; do not introduce new cleanliness requirements unless already enforced.

3. ACP adapter readiness.
   - Locate configured/default ACP adapter through existing config resolution.
   - Report adapter presence, version when available, and a local smoke readiness result.
   - Smoke check should validate that the adapter binary/module can be invoked or loaded enough to answer version/help/capabilities without making provider calls.
   - Missing adapter must produce a deterministic readiness error and remediation.

4. Rust runtime readiness when enabled.
   - Check Rust runtime only when the current feature/config/source-plan says Rust mode is enabled.
   - Detect required Rust runtime/tooling availability and version using existing process abstraction.
   - When Rust is disabled, emit `skip` rather than `error`.
   - When Rust is enabled but unavailable, emit an `error`.

5. Hub liveness and writability.
   - Use existing Hub location/config resolution.
   - Check whether the Hub is reachable/live according to the current Hub contract.
   - Check writability with an ephemeral readiness probe that cleans up after itself.
   - Detect stale Hub state separately from current live state and report it clearly.

6. Registry consistency.
   - Validate required registry files/records are readable and parseable.
   - Check required fields, duplicate identifiers, missing referenced projects/paths, invalid Hub references, and inconsistent status/state relationships.
   - Keep recoverable drift as `warn`; reserve `error` for states that make doctor/report unable to reason safely.

7. Stale jobs, workers, and leases.
   - Use existing heartbeat, lease, job, and worker metadata plus existing TTL/config where available.
   - Report stale jobs, stale workers, and expired leases with counts and redacted identifiers.
   - Avoid deleting or repairing stale state in doctor/report; only report and recommend remediation.

8. Provider backoff and rate-limit readiness.
   - Read existing provider backoff/rate-limit state without contacting providers.
   - Report active backoff with provider name, retry-after/next-at, and reason after redaction.
   - Add a test case for active rate limit/backoff.

9. Disk-space warnings.
   - Check disk space for the workspace, Hub storage, registry storage, and any existing artifact/cache directory used by CPB.
   - Use existing threshold config if present; otherwise use a conservative warning threshold from the source plan.
   - Disk pressure should warn with path category and available bytes; redact sensitive path components if current redaction policy requires it.

10. Redaction.
   - Run every readiness check detail through one redaction function before rendering.
   - Ensure JSON output is redacted, not only text output.
   - Add direct tests proving secrets in environment values, URLs, provider config, adapter output, and backoff messages do not appear in output.

**Implementation steps**:
1. Read the source-of-truth promotion plan and extract the exact P0.1 acceptance requirements. Stop if it conflicts with this handoff and record the conflict in the deliverable.
2. Locate the existing `cpb doctor` and `cpb report` command implementations plus their tests. Identify the smallest existing readiness/diagnostics boundary to extend.
3. Add or extend a structured readiness result type with stable fields: `id`, `label`, `status`, `summary`, `details`, `remediation`, and `severity`. Preserve any existing public result fields by adapting rather than replacing.
4. Implement the readiness collector checks listed above using existing helpers and injectable seams for filesystem, process execution, clock, environment, Hub, registry, provider state, and disk stats.
5. Add `--json` parsing and rendering for `cpb doctor` and `cpb report`. JSON must be valid machine-readable output with no human banner/progress text mixed into stdout.
6. Keep default text output compatible with existing tests and user expectations. Add the new checks to the existing report format with concise labels and statuses.
7. Add redaction before rendering. Confirm both text and JSON renderers consume only redacted readiness results.
8. Add deterministic tests for:
   - Missing ACP adapter.
   - Stale Hub.
   - Stale worker.
   - Active provider rate limit/backoff.
   - Rust runtime enabled but unavailable.
   - `--json` output shape and valid JSON parsing.
   - Redaction in both text and JSON readiness output.
9. Run the focused readiness/CLI tests first, then the repo-standard lint/typecheck/test commands required for this package. Capture exact commands and results in `deliverable-013.md`.
10. Self-review the diff for scope: no unrelated cleanup, no command rewrites, no new dependencies, no real provider calls, no mutation/repair behavior added to doctor/report.

**Notes and pitfalls**:
- Do not broaden P0.1 into other promotion-readiness P0/P1/P2 items.
- Do not make doctor/report repair stale workers, leases, Hub state, registry entries, or provider state.
- Do not leak raw paths, tokens, auth headers, credentials, provider keys, or adapter stderr/stdout that may contain secrets.
- Do not assume Rust is mandatory; it is mandatory only when enabled.
- Do not assume `--json` means successful readiness. JSON output must still represent `warn` and `error` checks accurately.
- If existing command output snapshots must change because new checks are intentionally displayed, update only the minimal affected expected output and explain why in the deliverable.

## Next-Action
Implement the P0.1 readiness expansion exactly within the scope above. After implementation and verification, write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-013.md` with changed files, test evidence, behavior notes, and any source-plan conflicts or remaining risks.

## Acceptance-Criteria
- [ ] The implementation explicitly follows `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` for P0.1 and does not implement unrelated promotion-readiness items.
- [ ] `cpb doctor` includes readiness checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] `cpb report` includes the same readiness signal set or a report section sourced from the same readiness collector.
- [ ] `cpb doctor --json` emits valid JSON with stable check IDs, statuses, summaries, redacted details, and no mixed human text on stdout.
- [ ] `cpb report --json` emits valid JSON containing the readiness results or the report-level readiness section with the same redaction guarantees.
- [ ] Existing default human-readable doctor/report behavior is preserved except for the intentional addition of P0.1 readiness checks.
- [ ] Missing ACP adapter is tested and reports an actionable readiness error.
- [ ] Stale Hub is tested and reports a warning or error consistent with the source plan and current Hub contract.
- [ ] Stale worker is tested and reports a stale worker readiness finding without deleting worker state.
- [ ] Active provider rate limit/backoff is tested and reports retry/backoff information without contacting the provider.
- [ ] Rust runtime enabled but unavailable is tested and reports an error; Rust disabled reports `skip` or omits the check according to existing command conventions.
- [ ] Redaction tests prove secrets do not appear in text or JSON output.
- [ ] Focused readiness/CLI tests pass.
- [ ] Repo-standard lint/typecheck/test verification for the affected package passes, or any pre-existing unrelated failures are documented with evidence.
- [ ] The deliverable lists changed files, simplifications made, verification evidence, and remaining risks.
