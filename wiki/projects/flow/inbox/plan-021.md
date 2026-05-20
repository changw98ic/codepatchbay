# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1 expand cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-021-P0.1-promotion-readiness-doctor-report
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 slice.
- Extend the existing readiness implementation rather than creating a parallel diagnostics path. Code intelligence found the active surface at `server/services/readiness-checks.js`, with `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Wire `--json` through the existing `cpb doctor` and `cpb report` command paths so human output remains the default and JSON output is machine-parseable.
- Keep all checks deterministic and testable by using the existing dependency-injection seams or adding narrow injection points for process execution, filesystem access, clock, Hub root, thresholds, and environment.
- Preserve existing behavior outside readiness reporting: do not change job execution, provider scheduling, lease cleanup, registry mutation, or ACP session semantics.
- Use existing redaction helpers such as `server/services/secret-policy.js`, `server/services/observability.js`, or existing diagnostics redaction code. Do not introduce a new redaction subsystem.

### Rejected
- Broad promotion-readiness cleanup beyond P0.1 — out of scope and likely to mask readiness-specific regressions.
- Editing files under `cpb-task/worktrees/` — those are historical or task worktree copies, not the active root implementation.
- Adding a new dependency for version checks, disk checks, or JSON formatting — the task is small enough to use built-in Node APIs and existing project utilities.
- Updating fake LLM responders, broad snapshots, or unrelated fixtures just to satisfy tests — existing AGENTS.md forbids this unless the fake itself is the bug.
- Making `--json` a separate command — it should be a flag on the existing doctor/report readiness surfaces.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use as the authoritative scope checklist.
- `/Users/chengwen/dev/flow/server/services/readiness-checks.js` — primary readiness checks, structured result schema, human formatter, JSON formatter.
- `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.js` — include the expanded readiness report in report/diagnostics output without leaking secrets.
- `/Users/chengwen/dev/flow/server/services/hub-registry.js` — reuse registry status helpers for Hub liveness, writability, worker status, and registry consistency; change only if an existing helper cannot expose required data.
- `/Users/chengwen/dev/flow/server/services/hub-runtime.js` — reuse liveness/readiness helpers; change only for a narrow testable liveness or writable probe seam.
- `/Users/chengwen/dev/flow/server/services/runtime-cli.js` — preserve Rust-runtime selection behavior and expose only the readiness data needed by doctor/report.
- `/Users/chengwen/dev/flow/server/services/secret-policy.js` and `/Users/chengwen/dev/flow/server/services/observability.js` — reuse for redaction coverage if readiness JSON/human output currently bypasses them.
- Existing `cpb doctor` / `cpb report` CLI entrypoint file — locate the current command parser and add `--json` flag handling there only; do not create a second command surface.
- Existing readiness or diagnostics test file under the project test tree — add focused tests there. If no readiness test file exists, create the narrowest new test file following the repository's current test naming and runner conventions.

### Evidence
- Planning phase only. Per task constraints, no terminal commands were executed.
- Code-intelligence lookup found these active symbols: `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, `checkNode`, `checkNpm`, `checkGit`, `checkAcpAdapter`, `checkRustRuntime`, `checkHubLiveness`, `checkHubWritability`, `checkRegistryConsistency`, `checkStaleJobs`, `checkOrphanLeases`, `checkStaleWorkers`, `checkProviderBackoff`, and `checkDiskSpace`.
- The executor must still inspect the source plan and source files directly before editing.

### Risks
- Some required checks may already exist but may not be wired into both `doctor` and `report`, may not be exposed in `--json`, or may lack the exact failure cases required by P0.1.
- The active command entrypoint was not inspected during planning because command execution is forbidden in this phase. Confirm the exact `cpb doctor` / `cpb report` parser before editing.
- Rust runtime readiness must be conditional. Reporting Rust unavailable when the Node runtime is selected would create false failures.
- Redaction must cover both human and JSON outputs; JSON can leak paths, env values, provider keys, tokens, or adapter command arguments if formatted before redaction.

### Scope

**Goal**: Implement P0.1 only: expanded `cpb doctor` / `cpb report` promotion-readiness checks with `--json` output, coverage for required readiness categories, redaction, and focused tests for the listed failure modes.

**Non-goals**:
- Do not implement other P0/P1/P2 items from the promotion readiness plan.
- Do not clean up unrelated diagnostics, provider, Hub, ACP, registry, lease, or Rust runtime code.
- Do not change production behavior except readiness reporting and the minimum helper seams needed to test it.
- Do not modify generated task worktrees under `cpb-task/worktrees/`.

**Implementation steps**:
1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and extract only the P0.1 acceptance requirements. Keep a short checklist in your working notes and do not implement adjacent slices.
2. Inspect the active `cpb doctor` and `cpb report` command flow. Identify exactly where each command calls readiness or diagnostics code, then wire a `--json` option through that existing path. Human output must remain the default.
3. Normalize readiness results in `server/services/readiness-checks.js` to a stable structured shape for both formatters. Each check should include an id, label/category, status (`ok`, `warn`, or `fail`), concise message, optional details, optional remediation, and redacted evidence. Keep existing exported function names stable.
4. Ensure the readiness checklist covers all P0.1 categories:
   - Node version and npm availability/version.
   - Git availability/version and repository readiness needed by current workflows.
   - ACP adapter presence, version discovery, and smoke readiness without starting a long-lived production session.
   - Rust runtime readiness only when Rust runtime mode is enabled by existing runtime-selection logic.
   - Hub liveness and Hub root writability.
   - Registry consistency, including malformed registry, missing project references, and stale lock or incompatible version if already represented.
   - Stale jobs, stale workers, and orphan/stale leases using existing TTL logic.
   - Provider backoff/rate-limit state as a warning when providers are cooling down, and a failure only when current behavior already treats all providers as unusable.
   - Disk-space warnings using existing threshold behavior or a narrow threshold constant.
5. Update `formatReadinessHuman` and `formatReadinessJson` so both represent the same check set. JSON output must be valid JSON with no prose prefix/suffix, and should include an overall status plus the per-check array/object. Preserve existing human wording where possible while adding missing checks.
6. Update `server/services/diagnostics-bundle.js` so `cpb report --json` includes the expanded readiness object and `cpb report` human output remains compatible with existing report consumers.
7. Apply redaction at the last boundary before output for both human and JSON. Cover environment variables, tokens, provider keys, auth headers, adapter command arguments, absolute secret paths, and error messages returned from subprocess checks. Prefer existing `redactSecrets`, `redactDiagnostics`, or `redactString` helpers over new regexes.
8. Add or adjust focused tests around the readiness service and CLI formatter/wiring:
   - Missing ACP adapter produces a `fail` readiness check with remediation and valid JSON output.
   - Stale Hub or unwritable Hub root produces the expected `fail` or `warn` without mutating Hub state.
   - Stale worker produces a stale-worker warning/failure according to existing TTL semantics.
   - Provider rate-limit/backoff produces a provider-backoff warning and is visible in both human and JSON output.
   - Rust runtime unavailable is reported only when Rust runtime mode is enabled; the same missing Rust binary does not fail Node-runtime readiness.
   - Redaction prevents synthetic secrets from appearing in human or JSON output.
9. Run the repository's existing targeted readiness/diagnostics tests first, then the broader test command used by the project. Include exact command output in `deliverable-021.md`.
10. Self-review the diff against P0.1: confirm no unrelated cleanup, no new dependencies, no worktree-copy edits, no fake/mock responder edits, and no behavior changes outside readiness output.

**Notes for implementation**:
- Prefer dependency injection over monkey-patching globals in tests. If `runReadinessChecks` does not already accept injected `execFile`, `fs`, `now`, env, or root paths, add a small options object while preserving the default production call.
- Avoid destructive probes. Hub writability should use a temporary file or existing safe write probe and clean it up.
- ACP smoke readiness should be bounded and non-invasive: version/help/smoke probe only, with timeout handling and redacted stderr.
- Disk-space checks should warn, not fail, unless the source plan explicitly requires failure for critically low space.
- Registry consistency checks should report evidence but not repair registry state; repair belongs outside this P0.1 slice.
- Provider backoff checks should observe current state only; do not reset backoff or alter scheduling.

## Next-Action
Implement the scoped P0.1 readiness expansion above, run the targeted and project-level tests, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-021.md` with changed files, verification evidence, any remaining risks, and confirmation that no out-of-scope cleanup was included.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits parseable JSON with an overall readiness status and all P0.1 per-check results; default `cpb doctor` human output still works.
- [ ] `cpb report --json` includes the same expanded readiness object; default `cpb report` output remains compatible with existing behavior.
- [ ] Readiness covers Node/npm, Git, ACP adapter presence/version/smoke readiness, conditional Rust runtime readiness, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is tested and reported as a readiness failure with useful remediation.
- [ ] Stale or unavailable Hub state is tested and reported without mutating production Hub data.
- [ ] Stale worker state is tested using existing TTL semantics.
- [ ] Provider rate-limit/backoff state is tested and visible in human and JSON output.
- [ ] Rust unavailable is tested as a failure only when Rust runtime mode is enabled, and does not fail readiness when Rust runtime mode is disabled.
- [ ] Human and JSON outputs are redacted; synthetic tokens/secrets used in tests do not appear in output.
- [ ] No files under `cpb-task/worktrees/` are modified.
- [ ] No new dependencies are added.
- [ ] Existing behavior outside `cpb doctor` / `cpb report` readiness reporting is preserved.
- [ ] Deliverable includes exact test commands and outputs, changed files, simplifications made, and remaining risks.
