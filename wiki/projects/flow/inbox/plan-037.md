# Plan 037: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-037-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Read it first and let its exact P0.1 requirements, names, status severities, and thresholds override this handoff where it is more specific.
- Implement only P0.1 readiness expansion for `cpb doctor` and `cpb report`; do not begin any P0.2 or unrelated cleanup work from the promotion plan.
- Use one shared readiness collector/model behind both commands so human output and `--json` output are consistent and testable.
- Add `--json` output without changing the default human output contract except for the new readiness check lines required by P0.1.
- JSON output must be machine-parseable, redacted, deterministic enough for tests, and should contain top-level readiness status plus per-check status, message, details, and remediation fields.
- Preserve existing command exit-code semantics. If the existing implementation already exits nonzero on failed readiness, keep that behavior; warnings such as disk-space or provider backoff should not become hard failures unless the source plan explicitly says so.
- Prefer existing project helpers for CLI parsing, Hub access, registry reading, provider state, ACP adapter resolution, logging, temp files, and tests. Add small local helpers only where no existing utility exists.
- No new runtime dependencies.

### Rejected
- Rejected implementing a new standalone diagnostics subsystem because P0.1 is a scoped expansion of existing `cpb doctor/report` readiness behavior.
- Rejected changing fake/mock fixtures merely to mask production behavior changes. Tests may add focused fakes for new readiness scenarios, but must not weaken existing coverage.
- Rejected broad environment cleanup, registry migrations, Hub rewrites, or provider redesigns because they are outside P0.1.
- Rejected printing raw environment/config/process details in JSON because P0.1 requires redaction.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for promotion readiness P0.1, with `--json` output, redaction, and focused tests for the required failure/warning scenarios while preserving existing behavior.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.1 requirements.
- Existing `cpb doctor` CLI entry point — add/use shared readiness checks and `--json`.
- Existing `cpb report` CLI entry point — add/use shared readiness checks and `--json`.
- Existing readiness/diagnostics/reporting helper modules — extend or create a small shared collector if none exists.
- Existing Hub, registry, provider, ACP adapter, and Rust runtime helper modules — reuse for probes instead of duplicating protocol logic.
- Existing CLI tests for `doctor`, `report`, diagnostics, Hub, registry, provider, adapter, or runtime behavior — add focused tests for P0.1.
- Test fixture files directly owned by those tests — add only purpose-built fixtures needed for the new scenarios.

**实现步骤**:
1. Read the promotion readiness plan and identify the exact P0.1 wording, expected status names, any thresholds, and any pre-existing file/module hints. Keep implementation strictly limited to P0.1.
2. Locate existing `cpb doctor` and `cpb report` command implementations and their current tests. Record current human output, exit-code behavior, and option parsing before editing.
3. Introduce or extend a shared readiness result model with fields equivalent to: check id, label, status, message, remediation, details, and optional redacted raw metadata. Supported statuses should cover pass, warn, fail, and skip/not-applicable if the project already uses that style.
4. Add `--json` handling to both commands. JSON mode must write valid JSON to stdout, avoid ANSI/color formatting, use the same readiness collector as human mode, and preserve the existing fatal-error behavior on stderr.
5. Implement Node/npm and Git checks using existing process/command helpers. Report executable presence and version. Compare against existing project engine/minimum-version metadata only if the current codebase already exposes it or the source plan names it.
6. Implement ACP adapter readiness: presence resolution, version retrieval when supported, and a bounded smoke-readiness probe using existing adapter/protocol helpers. Missing adapter must be reported as a failed check with a concrete remediation.
7. Implement Rust runtime readiness only when Rust runtime is enabled by the project’s existing config/env/feature gate. If enabled and unavailable, report failure. If disabled, report skip/not-applicable without failing.
8. Implement Hub liveness and writability checks through existing Hub APIs or state paths. The writability probe must be non-destructive: create a temporary probe artifact in the existing writable area, clean it up, and never mutate user project data.
9. Implement registry consistency checks by parsing the existing registry source through existing helpers. Report malformed entries, duplicates, missing required fields, and inconsistent project references using the severity specified in the source plan or the existing diagnostics convention.
10. Implement stale jobs, stale workers, and stale leases checks using existing TTL/heartbeat/lease constants if present. If constants are missing, add narrowly named constants near the readiness code and document why. Report stale worker and stale job evidence with age and id only after redaction.
11. Implement provider backoff/rate-limit readiness by reading existing provider backoff state. If a provider is currently rate-limited or in backoff, surface provider id, status, and retry timing without exposing API keys, tokens, headers, or raw URLs with credentials.
12. Implement disk-space warnings against the relevant CPB/Hub/project state locations. Use existing filesystem helpers if present. Warn when free space is below the source-plan threshold; if the source plan has no threshold, use the project’s existing diagnostics threshold if available.
13. Add a recursive redaction layer applied before human detail rendering and before JSON serialization. Redact tokens, API keys, authorization headers, cookies, credentials embedded in URLs, secrets in env/config names, and any adapter/provider payload fields already treated as sensitive by the codebase.
14. Add or adjust tests without broad fixture rewrites. Required scenarios: missing ACP adapter, stale Hub or unwritable/unhealthy Hub, stale worker, provider rate-limit/backoff, Rust runtime enabled but unavailable. Also add JSON parse/redaction coverage if not already covered by those tests.
15. Run the relevant test suite for the changed modules, then the project’s normal lint/typecheck/test commands if practical. Do not claim completion until fresh evidence is captured in the deliverable.

**注意事项**:
- Keep changes scoped to P0.1. Do not implement later promotion-readiness items, redesign reports, reorganize directories, or do unrelated cleanup.
- Preserve existing default command behavior for users who do not pass `--json`.
- JSON output must not contain secrets even in failing diagnostics.
- Do not hide readiness failures by downgrading required failures to warnings unless the source plan explicitly says they are warnings.
- Do not edit fake LLM responders, snapshots, broad fixtures, or unrelated mocks merely to make tests pass.
- Prefer deterministic tests with injected clocks, temp dirs, fake command runners, and existing test helpers over sleeping or depending on the developer machine’s real environment.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above. After implementation and verification, write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-037.md` with changed files, test evidence, behavior notes, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid redacted JSON with top-level readiness status and per-check results.
- [ ] `cpb report --json` emits valid redacted JSON using the same readiness collector/model as `doctor`.
- [ ] Default human output for `cpb doctor` and `cpb report` remains compatible with existing behavior while including the new P0.1 readiness checks.
- [ ] Readiness checks cover Node/npm presence/version, Git presence/version, ACP adapter presence/version/smoke readiness, Rust runtime readiness when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is covered by a test and produces the expected failed readiness result.
- [ ] Stale or unhealthy Hub behavior is covered by a test and produces the expected readiness result.
- [ ] Stale worker behavior is covered by a test and produces the expected readiness result.
- [ ] Provider rate-limit/backoff behavior is covered by a test and produces the expected readiness result without leaking secrets.
- [ ] Rust runtime enabled but unavailable is covered by a test and produces the expected failed readiness result.
- [ ] Redaction is applied to JSON and human diagnostic details for tokens, API keys, authorization headers, cookies, credentialed URLs, and known sensitive provider/adapter fields.
- [ ] Existing relevant tests still pass, and new tests are focused on P0.1 behavior.
- [ ] No new runtime dependency is added.
- [ ] Deliverable includes changed files, simplifications or reuse decisions, exact verification commands and outputs, and remaining risks.

### Evidence
- Planning-only phase completed under the constraint not to execute terminal commands.
- Wrote this handoff plan to `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/plan-037.md`.

### Risks
- This plan was written without command-line inspection because the current phase forbids terminal commands. Claude must read the source promotion-readiness plan and existing command/test files before editing.
- Exact module paths, version thresholds, stale-age thresholds, and status names must be taken from the source plan and current codebase during implementation.
