## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-073
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: P0.1 expand cpb doctor/report readiness checks from /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before editing; implement only its P0.1 doctor/report readiness slice.
- Reuse the existing `cpb doctor` and `cpb report` command surfaces instead of introducing a new readiness command.
- Add `--json` as an output mode on the existing commands, backed by one shared readiness-result model so text and JSON output cannot drift.
- Preserve existing non-JSON behavior, command names, configuration discovery, and exit-code policy unless the current doctor/report implementation already treats failed readiness checks as nonzero.
- Model each readiness check as a structured item with `id`, `label`, `status` (`pass`, `warn`, `fail`, or `skip`), `message`, optional redacted `details`, and optional `remediation`.
- Redact secrets before output formatting, logging, snapshots, or test assertions. Redaction must cover tokens, API keys, bearer/basic auth, credentials embedded in URLs, provider headers, and sensitive environment values.

### Rejected
- Replacing the doctor/report implementation wholesale | Too broad for P0.1 and risks changing existing behavior.
- Adding a separate `cpb readiness` command | The task specifically requires expanding doctor/report readiness checks.
- Hardcoding local machine paths, absolute tool locations, or provider-specific credentials | Promotion readiness must work across developer and CI environments.
- Dumping raw child-process output into JSON/text reports | It can leak credentials and makes tests brittle.
- Editing unrelated cleanup, formatting, or historical worktree files | The task explicitly says to keep changes scoped and not broaden into cleanup.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first and use as the P0.1 authority.
- Existing `cpb doctor` command implementation - add/check wiring for expanded readiness checks and `--json`.
- Existing `cpb report` command implementation - expose the same readiness model and `--json` output without breaking current report behavior.
- Existing diagnostics/readiness service, if present - centralize check collection, redaction, status aggregation, and JSON schema here rather than duplicating command logic.
- Existing Hub/registry/runtime/provider service modules - add only the minimal exported probes needed by readiness checks.
- Existing doctor/report test files - add focused tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, redaction, and JSON output.

### Evidence
- No terminal commands were executed in this planning phase, per instruction.
- Implementation evidence must be supplied by Claude in `deliverable-073.md` after code changes and tests.

### Risks
- The exact doctor/report source paths must be confirmed from the repository before editing; do not modify generated or historical `cpb-task/worktrees/*` copies unless the active task branch explicitly lives there.
- Hub liveness and writability checks can become flaky if they depend on real external services; prefer existing local Hub abstractions, fixture state, or mockable probes in tests.
- Adapter smoke checks can hang if implemented as unbounded child processes; all subprocess probes need short timeouts and redacted captured output.
- Disk-space checks are platform-dependent; keep thresholds configurable or centralized and test by mocking the filesystem/stat layer.
- Rust runtime readiness must be skipped when Rust support is disabled, and must fail only when the runtime is enabled but unavailable.

### Scope

**Goal**: Implement P0.1 only: expand `cpb doctor` and `cpb report` readiness checks with JSON output and checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and output redaction.

**Implementation steps**:
1. Read the promotion readiness plan and identify only the P0.1 requirements. Record any P0.1-specific status names, thresholds, or output schema expectations in the implementation notes or test names.
2. Locate the existing `cpb doctor` and `cpb report` command implementations and their current tests. Confirm current text output and exit-code behavior before changing code.
3. Add or extend a shared readiness collector used by both commands. It should return deterministic structured data: command name, generated timestamp, overall status, summary counts, environment metadata, and an ordered list of checks.
4. Implement `--json` parsing for both commands. JSON mode must write valid JSON only to stdout, avoid ANSI formatting, avoid extra banners, and use the same exit-code policy as the corresponding non-JSON command.
5. Add environment tool checks:
   - Node: report current `process.versions.node` and fail/warn according to the source plan or existing minimum-version policy.
   - npm: probe availability and version with a bounded timeout.
   - Git: probe availability and version with a bounded timeout.
6. Add ACP adapter checks:
   - Resolve the configured adapter using existing configuration rules.
   - Fail when the adapter is missing or not executable/importable.
   - Report adapter version when available.
   - Run a bounded smoke/readiness probe using the existing adapter protocol, without starting long-lived work or requiring real provider credentials.
7. Add Rust runtime checks:
   - Detect whether the Rust runtime is enabled through existing config/env rules.
   - Return `skip` when disabled.
   - When enabled, verify required binary/runtime availability and report `fail` with actionable remediation if unavailable.
8. Add Hub checks:
   - Verify Hub liveness through the existing local Hub status/heartbeat mechanism.
   - Verify Hub writability with a safe temporary write in the configured Hub state area, then clean it up.
   - Report stale Hub state when heartbeat or status age exceeds the existing TTL or the P0.1 threshold.
9. Add registry consistency checks:
   - Load the existing registry through its normal parser.
   - Detect malformed entries, missing referenced projects/providers/adapters, duplicate IDs, dangling worker/job/lease references, and version/schema mismatches covered by P0.1.
10. Add stale state checks:
   - Detect stale jobs, workers, and leases using existing timestamps/TTL semantics.
   - Include counts and redacted/truncated identifiers in details.
   - Classify stale workers and leases at the severity required by the source plan, defaulting to `warn` if the system can self-heal and `fail` if readiness is blocked.
11. Add provider backoff/rate-limit checks:
   - Inspect existing provider state for active backoff, cooldown, rate-limit, or circuit-breaker state.
   - Surface active backoff as a warning unless the source plan requires failure.
   - Redact provider names, URLs, headers, tokens, and request IDs where sensitive.
12. Add disk-space checks:
   - Check the workspace, Hub state directory, and any runtime cache directory used by CPB.
   - Warn below the P0.1 warning threshold and fail only below the critical threshold if one exists.
   - Keep filesystem probing mockable for tests.
13. Apply redaction at the shared readiness-result boundary and again before formatting output. Add regression coverage proving secrets do not appear in text or JSON.
14. Add focused tests:
   - Missing ACP adapter produces a failed readiness check and JSON code/details are redacted.
   - Stale Hub produces the expected stale Hub status.
   - Stale worker produces the expected stale worker warning/failure and count.
   - Provider rate limit/backoff produces the expected readiness warning without leaking provider secrets.
   - Rust unavailable fails only when Rust runtime is enabled and skips when disabled.
   - `cpb doctor --json` and `cpb report --json` emit parseable JSON with no ANSI/banners and stable check IDs.
15. Run the relevant targeted tests first, then the existing doctor/report suite, then the project-standard lint/typecheck/test commands required by the promotion plan. Do not edit mocks, fixtures, snapshots, or test doubles merely to mask production behavior changes.
16. Write `wiki/projects/flow/outputs/deliverable-073.md` with changed files, implementation notes, test evidence, and any remaining risks.

**Notes**:
- Keep the diff small and limited to doctor/report readiness, shared diagnostics helpers, minimal probe exports, and tests.
- Prefer existing service abstractions and configuration readers over new global utilities.
- Do not add dependencies unless the source plan explicitly requires one; use Node standard library and existing project helpers where possible.
- Do not make network calls to real remote providers in tests.
- Do not expose raw environment variables, command lines with credentials, adapter stdout/stderr, provider headers, or Hub registry secrets.
- If a readiness probe is unavailable in the current architecture, return a structured `skip` with a remediation only when the source plan permits skipping; otherwise implement the minimal probe.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, using the promotion readiness plan as the authority. After implementation, run the targeted and project-standard verification commands, then write `wiki/projects/flow/outputs/deliverable-073.md` with evidence for Codex review.

## Acceptance-Criteria
- [ ] The implementation references and follows only P0.1 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] `cpb doctor --json` emits valid JSON only, with deterministic top-level fields for overall status, summary counts, generated timestamp, environment metadata, and ordered checks.
- [ ] `cpb report --json` emits valid JSON only and includes the same readiness checks without breaking existing report content in non-JSON mode.
- [ ] Existing non-JSON `cpb doctor` and `cpb report` behavior remains compatible except for the added readiness information required by P0.1.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence, ACP adapter version, ACP adapter smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime readiness returns `skip` when disabled and `fail` when enabled but unavailable.
- [ ] Provider rate-limit/backoff state is surfaced with the P0.1 severity and does not leak credentials or raw provider headers.
- [ ] Missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable are covered by focused automated tests.
- [ ] Text and JSON outputs redact tokens, API keys, bearer/basic auth values, credentials in URLs, sensitive environment values, and raw adapter/provider output.
- [ ] All new probes are bounded by timeouts and are mockable or fixture-driven in tests.
- [ ] Existing doctor/report tests still pass without broad snapshot rewrites.
- [ ] Claude's deliverable lists changed files, exact verification commands run, command results, simplifications made, and remaining risks.
