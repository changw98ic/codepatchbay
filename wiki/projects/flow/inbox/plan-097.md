# TASK-097 Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-097
- **Timestamp**: 2026-05-19

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Keep the implementation centered on the existing readiness surface: root `server/services/readiness-checks.js` already exports `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Make `cpb doctor` and `cpb report` share one structured, redacted readiness result instead of creating separate check implementations.
- Add `--json` as a presentation option only: it must not change the underlying checks, status calculation, or existing human behavior except for adding the new P0.1 checks.
- Use a stable check model with `id`, `label`, `status` (`pass`, `warn`, `fail`, `skip`), `summary`, optional `details`, and optional `remediation`; derive top-level status from the worst check.
- Keep checks read-only except for a bounded Hub writability probe that creates and removes a temporary readiness file.
- Gate Rust runtime checks behind the existing Rust-runtime enablement signal; when Rust is disabled, report `skip`, and when enabled but unavailable, report `fail`.
- Redact before both human and JSON formatting. Do not print provider tokens, API keys, auth headers, home-directory secrets, raw environment values, or command arguments that may contain credentials.

### Rejected
- Do not add new dependencies for CLI parsing, semver, disk checks, redaction, or table rendering; use existing project helpers and Node core APIs.
- Do not broaden into cleanup, file reorganization, or refactors outside readiness/report plumbing.
- Do not modify fake/mock responders, snapshots, fixtures, or test doubles merely to force tests through; update only purpose-built readiness tests or fixtures that directly model P0.1 behavior.
- Do not auto-clean stale jobs, workers, or leases from `doctor`/`report`; this slice only detects and reports readiness.
- Do not copy code from `cpb-task/worktrees/**`; those are task worktrees, not the root implementation target.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first and use only the P0.1 slice as the implementation boundary.
- `server/services/readiness-checks.js` - extend readiness model, check helpers, status aggregation, redaction, and human/JSON formatters.
- `server/services/diagnostics-bundle.js` - wire the expanded readiness result into `cpb report` if report currently gathers diagnostics there.
- `server/services/observability.js` - reuse or align existing diagnostic redaction helpers only if `readiness-checks.js` does not already own redaction.
- `server/services/runtime-cli.js` - reuse existing runtime path/version helpers for Rust runtime readiness if present; avoid changing runtime behavior.
- `server/services/acp-pool-runtime.js` - reuse existing ACP adapter/pool helpers for smoke readiness if present; avoid changing pool lifecycle behavior.
- Existing `cpb` CLI entrypoint that handles `doctor` and `report` - add `--json` parsing/wiring there, preserving current command names and exit behavior.
- Existing readiness test file, or create `server/services/readiness-checks.test.js` if no targeted file exists - cover P0.1 service behavior and formatting.
- Existing CLI/report test file, or create the nearest matching CLI test under the current test layout - cover `cpb doctor --json` and `cpb report --json` output behavior.

### Evidence
- User directive pins the required source-of-truth plan path and exact P0.1 scope.
- Read-only code-intel found root `server/services/readiness-checks.js` with `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`, so the plan uses that existing service instead of introducing a parallel readiness path.
- Planner did not run terminal commands and did not inspect or modify production code.

### Risks
- The exact CLI entrypoint path was not resolved in this planning-only phase; find the existing `doctor` and `report` handlers before editing and keep the change scoped to their `--json` wiring.
- Some checks need time-based thresholds. Use existing TTL/backoff constants where available; if none exist, define local constants in `readiness-checks.js` with names and tests that make the threshold explicit.
- Disk-space APIs differ by Node version. Prefer existing project utilities; otherwise use `fs.statfs` when available and return `skip` with a clear summary when the platform cannot report capacity.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness checks for P0.1 only, with shared structured output, `--json`, complete redaction, and tests for the required failure modes while preserving existing behavior.

**Implementation steps**:
1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and extract only P0.1 requirements. Treat anything outside P0.1 as out of scope.
2. Inspect the root implementation paths, not `cpb-task/worktrees/**`: `server/services/readiness-checks.js`, diagnostics/report wiring, existing redaction helpers, runtime/ACP helpers, and the `cpb` CLI command handlers for `doctor` and `report`.
3. Add or adjust targeted tests first using temporary directories, injected clocks, injected process runners, and injected environment/config where the service already supports injection. Cover:
   - Missing ACP adapter reports a deterministic `fail` or required-check failure with remediation.
   - Stale Hub heartbeat or non-writable Hub storage reports the correct failing Hub check.
   - Stale worker/job/lease state is detected without deleting or mutating it.
   - Active provider rate-limit/backoff state reports a warning with retry timing and redacted provider details.
   - Rust runtime enabled but unavailable reports `fail`; Rust disabled reports `skip`.
   - JSON formatting emits parseable, redacted JSON with no ANSI/prose wrapper.
4. Extend `runReadinessChecks` in `server/services/readiness-checks.js` to gather these check groups:
   - Node.js version from `process.version`; npm version by a timed version probe.
   - Git presence/version by a timed version probe.
   - ACP adapter presence, adapter version, and a bounded smoke readiness probe using existing ACP adapter/pool helpers where possible.
   - Rust runtime readiness only when the existing runtime configuration selects/enables Rust.
   - Hub liveness and Hub-root writability, including stale heartbeat detection if Hub metadata already records heartbeat/update time.
   - Registry consistency across registered projects/jobs/workers/leases and their on-disk state; report missing, duplicate, dangling, or malformed entries.
   - Stale jobs, workers, and leases using existing timestamps and TTL/backoff constants.
   - Provider backoff/rate-limit state with retry timing and safe provider identifiers only.
   - Disk-space warnings for Hub root and project/workspace roots where capacity can be measured.
5. Add or reuse a redaction pass that recursively sanitizes check summaries, details, command outputs, paths, environment values, provider metadata, URLs, headers, and error messages before formatting. Keep useful diagnostics such as command names, version strings, check ids, relative paths, and safe basenames.
6. Preserve and extend formatters:
   - `formatReadinessHuman(result)` keeps the existing human style and adds concise sections for the new check groups.
   - `formatReadinessJson(result)` returns the sanitized structured object or JSON string according to the existing formatter contract; no ANSI, markdown, or extra text.
7. Wire CLI/report behavior:
   - `cpb doctor --json` prints only the readiness JSON.
   - `cpb report --json` includes the expanded readiness report in its JSON diagnostics output, or prints the readiness JSON if report is currently readiness-only.
   - Existing `cpb doctor` and `cpb report` human output continues to work.
   - Exit status remains compatible with existing behavior; if no prior rule exists, return non-zero only when top-level readiness status is `fail`.
8. Run targeted tests for readiness and CLI/report JSON. Then run the project-standard full test/lint/typecheck commands that already exist in package scripts. Record exact commands and outputs in `deliverable-097.md`.

**Notes**:
- Keep changes small and local to readiness/report plumbing.
- Do not introduce background service starts as part of readiness checks.
- All subprocess probes must have short timeouts and return structured `fail`/`warn` results instead of throwing through the command.
- JSON schema should be deterministic enough for tests: stable check ids, stable top-level status, and stable redaction marker such as `[REDACTED]`.
- Prefer dependency injection in tests over mutating real user/global state.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, run the targeted and project-standard verification commands, and write `deliverable-097.md` with changed files, evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only, with top-level status, generated timestamp, and the full redacted checks list.
- [ ] `cpb report --json` includes the expanded redacted readiness result without breaking existing report behavior.
- [ ] Existing human `cpb doctor` and `cpb report` output remains usable and preserves prior behavior while adding P0.1 readiness sections.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Redaction is applied to human and JSON output, including secrets in env values, provider metadata, URLs, headers, command output, and error messages.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker/job/lease state, active rate-limit/provider backoff, and Rust enabled but unavailable.
- [ ] Tests prove Rust disabled reports `skip`, not failure.
- [ ] Tests prove stale-state checks are report-only and do not delete jobs, workers, or leases.
- [ ] Tests prove `--json` output has no ANSI escape sequences, markdown fences, or extra prose.
- [ ] No unrelated cleanup, dependency additions, or behavior changes outside P0.1 are included.
- [ ] All targeted readiness/CLI tests pass.
- [ ] Project-standard lint, typecheck, and test commands pass, or any unavailable command is reported with the exact reason.
