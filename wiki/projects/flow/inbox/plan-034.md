## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-034
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and re-read it before editing code.
- Implement only P0.1: expanded readiness checks for `cpb doctor` and `cpb report`.
- Preserve existing default human-readable output and existing exit-code behavior unless the source plan explicitly requires a different behavior.
- Add `--json` output through the existing CLI option/parsing pattern, not a parallel command.
- Use one shared readiness result model for doctor and report so check behavior, redaction, aggregation, and JSON shape stay consistent.
- Keep readiness checks side-effect-light: bounded timeouts, read-only probes where possible, and cleanup for any Hub writability marker.
- Mark Rust runtime checks as `skipped` when Rust support is disabled; report `error` or `warn` only when the feature is enabled and unavailable according to existing semantics.
- Apply redaction recursively before both human and JSON output, including environment-derived values, command output, provider metadata, adapter paths containing credentials, tokens, keys, URLs with credentials, and authorization-like headers.

### Rejected
- Broad CLI cleanup or command restructuring | outside the P0.1 slice.
- Adding new dependencies for system probing or disk-space checks | use existing project utilities, Node built-ins, or narrow local helpers.
- Making Rust mandatory for all users | Rust readiness applies only when enabled.
- Updating fake/mock assets only to make tests pass | add purpose-built fixtures for the new readiness scenarios instead.
- Reporting raw provider/adapter command output directly | redaction must run before rendering.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth for exact P0.1 boundaries.
- Existing `cpb doctor` command implementation - locate through the CLI command registration and add the expanded checks plus `--json`.
- Existing `cpb report` command implementation - locate through the CLI command registration and include the same readiness payload/report section plus `--json` if report owns separate option parsing.
- Existing shared CLI health/readiness helper module, if present - extend it; if none exists, create a narrowly scoped helper next to the existing CLI command helpers.
- Existing Hub state/client modules - reuse for liveness, writability, stale jobs, stale workers, and stale leases.
- Existing registry modules - reuse for registry consistency checks.
- Existing provider/backoff state modules - reuse for active rate-limit/backoff readiness warnings.
- Existing CLI and readiness tests - add or adjust tests for the requested P0.1 cases without changing unrelated fixtures.

### Evidence
- This is a planning-only handoff. No terminal commands were run in this phase.
- No implementation files were inspected or modified in this phase due to the explicit planning constraint.
- The executor must verify exact file paths during implementation and list them in `deliverable-034.md`.

### Risks
- Exact command module paths are intentionally left to executor discovery because this phase may write only the handoff file and must not run shell commands.
- Existing doctor/report exit-code semantics may differ between commands; preserve current behavior unless the source plan explicitly overrides it.
- Some readiness probes may currently be embedded in tests or command code; avoid moving unrelated logic unless required to share the P0.1 result model.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness coverage for promotion readiness P0.1, including machine-readable JSON output, environment/runtime checks, Hub and registry integrity checks, stale operational-state detection, provider backoff visibility, disk-space warnings, redaction, and focused tests.

**Implementation steps**:

1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and extract only the P0.1 acceptance requirements. Do not implement any P0.2, P1, cleanup, UX polish, or unrelated readiness items.

2. Locate the existing `cpb doctor` and `cpb report` command implementations and current tests. Record the exact touched files in the final deliverable. Prefer extending existing command handlers, option parsing, test helpers, and health/readiness modules.

3. Introduce or extend a shared readiness result shape used by both commands:
   - `schemaVersion`
   - `generatedAt`
   - `overallStatus`: `ok | warn | error`
   - `checks[]`
   - each check has stable `id`, `component`, `label`, `status`, `summary`, optional `details`, optional `remediation`, and optional `metadata`
   - deterministic ordering for checks and JSON fields where the project test style expects stable snapshots
   - aggregation rule: any `error` makes overall `error`; otherwise any `warn` makes overall `warn`; otherwise `ok`

4. Add `--json` output:
   - `cpb doctor --json` prints only the readiness JSON payload to stdout.
   - `cpb report --json` includes the readiness payload in the report JSON or emits the report JSON shape currently expected by the command, extended with readiness.
   - Human output remains the default and keeps existing headings/wording as much as possible.
   - Diagnostics that are not part of the JSON payload go to stderr.
   - Exit-code behavior matches existing hard-failure semantics and does not make warnings fail unless current behavior already does that.

5. Implement environment and runtime checks:
   - Node: report current Node version from the running process and whether it satisfies the project-supported range if such a range exists.
   - npm: report presence and version using the existing command-runner pattern with a bounded timeout.
   - Git: report presence and version using the existing command-runner pattern with a bounded timeout.
   - ACP adapter: verify configured adapter presence, version, and smoke readiness. Prefer existing adapter handshake/health/dry-run APIs; otherwise use the narrowest no-side-effect smoke probe available. Missing adapter must be a tested readiness failure.
   - Rust runtime: when Rust support is enabled by existing config/env/feature detection, verify the configured Rust runtime/tooling is available; when disabled, return a clear `skipped` check. Rust enabled but unavailable must be tested.

6. Implement Hub and state checks:
   - Hub liveness: verify the Hub state/heartbeat indicates a live Hub using existing TTL constants where available.
   - Hub writability: write and remove a temporary marker through the existing Hub storage path or writable-state helper. Never leave probe files behind.
   - Stale Hub: detect stale heartbeat or stale process metadata and surface it as the project-consistent warning/error severity. Add the requested stale Hub test.
   - Stale jobs, workers, and leases: inspect existing Hub operational state, compare timestamps/expirations using existing TTL rules where available, and report stale entries with redacted identifiers. Add the requested stale worker test and include jobs/leases coverage where practical.

7. Implement registry, provider, and disk checks:
   - Registry consistency: verify registered projects/adapters/providers agree with Hub state and local registry schema expectations; report missing paths, duplicate IDs, invalid entries, stale references, or version/schema mismatches without repairing them.
   - Provider backoff/rate limit: read existing provider backoff or rate-limit state and surface active backoff as a readiness warning with redacted provider identifiers and retry timing. Add the requested rate-limit test.
   - Disk space: warn when relevant workspace, Hub, temp, cache, or registry locations fall below existing or source-plan thresholds. Use a portable helper and avoid new dependencies.

8. Add redaction before rendering:
   - Centralize redaction so every check detail and command output passes through it before human or JSON output.
   - Redact tokens, API keys, authorization headers, cookies, credentialed URLs, provider secrets, adapter command env, and known CPB secret-like config keys.
   - Add tests that prove secrets are not present in `--json` output and representative human output.

9. Add focused tests:
   - Missing ACP adapter.
   - Stale Hub.
   - Stale worker.
   - Active provider rate limit/backoff.
   - Rust runtime enabled but unavailable.
   - `cpb doctor --json` valid shape, deterministic check ids, aggregate status, and redaction.
   - `cpb report --json` or report readiness JSON extension, depending on existing command behavior.
   - Default human output still works for doctor/report.

10. Run the project-appropriate verification after implementation:
   - targeted readiness/CLI tests for doctor/report
   - broader affected test suite
   - lint/typecheck/static analysis required by the repo
   - any source-plan-specific verification commands

**Notes**:
- Keep changes scoped to P0.1 readiness behavior.
- Prefer deletion or reuse when touching existing readiness code, but do not perform unrelated refactors.
- Do not modify snapshots, fakes, or fixtures merely to bless changed behavior; add intentional fixtures for new readiness cases.
- Time-dependent tests should use existing fake-clock/test-clock helpers or deterministic timestamp injection.
- Any probe that shells out during real command execution must use existing timeout/process-runner safety patterns and must not hang doctor/report.

### Plan Self-Review
- Every requested readiness area maps to an implementation step and at least one acceptance criterion.
- The plan preserves existing behavior by default and isolates new machine-readable output behind `--json`.
- The requested tests for missing adapter, stale Hub, stale worker, rate limit, and Rust unavailable are explicit.
- No unrelated cleanup, dependency additions, or non-P0 scope is included.

## Next-Action
Implement P0.1 exactly as scoped above. Start by reading the source readiness plan, locate the existing doctor/report code and tests, make the minimal production and test changes, run verification, and write `deliverable-034.md` with changed files, evidence, remaining risks, and any source-plan requirements that were intentionally deferred because they were outside P0.1.

## Acceptance-Criteria
- [ ] The executor confirms `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read before implementation.
- [ ] Only P0.1 doctor/report readiness behavior is implemented; no unrelated cleanup or broader promotion-readiness work is included.
- [ ] `cpb doctor --json` emits a valid, deterministic readiness JSON payload with aggregate status and check details.
- [ ] `cpb report` includes the expanded readiness checks, and `cpb report --json` exposes them in the report JSON shape when the command supports or owns JSON output.
- [ ] Default human-readable doctor/report output remains available and preserves existing behavior except for the added readiness information.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit, and disk-space warnings.
- [ ] Rust readiness is `skipped` when disabled and reports unavailable runtime when enabled but missing.
- [ ] Hub writability probes clean up after themselves.
- [ ] Redaction is applied to all readiness output, including JSON and human output.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker, active rate limit/backoff, Rust unavailable, JSON output shape, and redaction.
- [ ] All affected tests pass, and the deliverable lists the exact commands run plus any verification gaps.
- [ ] Code style follows the existing project patterns and introduces no new dependencies unless the source plan explicitly requires one.
