## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-105
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth. Read it before changing code and implement only P0.1.
- Keep the change scoped to `cpb doctor` / `cpb report` readiness behavior, the shared readiness/report data model behind them, and tests that prove the required P0.1 cases.
- Add `--json` output through the existing CLI framework. Human and JSON output must be rendered from the same collected readiness report so behavior cannot drift.
- Use existing project helpers, config loading, Hub access, registry access, provider/backoff state, job/worker/lease storage, command spawning, logging, and test patterns. Do not add dependencies.
- Model each readiness item with a stable check id, status, summary, remediation/details, and redacted metadata. Use statuses equivalent to pass/warn/fail/skip, mapped to existing conventions if they already exist.
- Preserve current exit-code behavior where it is already tested or documented. If no contract exists, use non-zero only for failing readiness blockers, not warnings.
- Rust runtime checks are conditional: disabled Rust support reports skipped/omitted according to existing project conventions; enabled Rust support with an unavailable runtime reports a failure.
- Redaction is part of the readiness pipeline, not a presentation-only afterthought. JSON and human output must both avoid leaking tokens, secrets, credentials, private adapter args, and sensitive env values.

### Rejected
- Broad refactors of CLI, Hub, registry, provider, job, worker, or lease internals outside what P0.1 needs.
- Separate hand-built JSON logic for `doctor` and `report`; that would duplicate policy and make future readiness checks inconsistent.
- Real network/provider calls for adapter or provider smoke readiness. Use local process/config/handshake checks with bounded timeouts.
- Modifying fake responders, snapshots, fixtures, or mocks merely to make tests pass. Only adjust test doubles when the readiness behavior being tested requires a purpose-built fake.
- Adding a new command framework, output library, disk-space library, or version parser dependency.

### Scope

**Target**: expand `cpb doctor` / `cpb report` readiness checks for P0.1 only:
- `--json` output
- Node/npm readiness
- Git readiness
- ACP adapter presence, version, and smoke readiness
- Rust runtime readiness when Rust is enabled
- Hub liveness and writability
- registry consistency
- stale jobs, workers, and leases
- provider backoff/rate-limit visibility
- disk-space warnings
- redaction
- tests for missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable

**Read-only source**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - authoritative P0.1 requirements and any severity/threshold details.

**Implementation files to locate and keep scoped**:
- Existing CLI registration/handler for `cpb doctor`.
- Existing CLI registration/handler for `cpb report`.
- Existing readiness/report/health model or service used by those commands; if none exists, create the smallest adjacent module needed to share collection and rendering between both commands.
- Existing Hub client/storage/health helpers needed for liveness, writability, and stale Hub detection.
- Existing registry loader/validator used by CPB.
- Existing job, worker, and lease stores or lifecycle helpers.
- Existing provider backoff/rate-limit state helpers.
- Existing runtime/toolchain helpers for Node/npm/Git/Rust, or the narrowest adjacent helpers if none exist.
- Existing test files for doctor/report/CLI readiness. Add tests next to the closest current coverage.

**Out of scope**:
- P0.2 or lower-priority promotion-readiness work.
- Changes to unrelated commands, provider behavior, adapter execution semantics, Hub protocol, registry format migrations, or worker scheduling.
- Cosmetic rewrites, naming sweeps, snapshot churn, and unrelated cleanup.

**Implementation steps**:
1. Read the promotion readiness plan and extract the P0.1 requirements, expected severities, thresholds, and any naming/schema guidance. If the document disagrees with this handoff, follow the document and mention the difference in the deliverable.
2. Inspect the existing `cpb doctor` and `cpb report` handlers, their current tests, current output shape, and exit-code behavior. Identify the smallest shared readiness collection layer that both commands can use.
3. Define or extend the shared readiness report shape with stable check ids, status, human summary, optional remediation, optional machine metadata, and aggregate pass/warn/fail counts. Ensure the shape can render deterministic JSON and existing-style human output.
4. Implement runtime/tooling checks:
   - Node version and availability, using the project/package engine policy where available.
   - npm version and availability.
   - Git version and availability.
   - All external process checks must use existing safe process helpers or direct argv arrays with bounded timeouts; do not use shell interpolation.
5. Implement ACP adapter checks:
   - Resolve the configured/default ACP adapter using existing config and resolution rules.
   - Report missing adapter as a failing readiness check with a clear remediation.
   - Report adapter version when available via existing metadata or a bounded `--version`-style probe.
   - Add smoke readiness that proves the adapter can be located/spawned or locally handshaken without contacting a real provider. Time out cleanly and redact command/env details.
6. Implement conditional Rust readiness:
   - Detect whether Rust runtime support is enabled through existing config, feature flag, environment, or plan-specified mechanism.
   - When disabled, return skipped/omitted according to existing report style.
   - When enabled, verify the runtime/binary/library availability and version if available. Report unavailable Rust as a failing readiness check.
7. Implement Hub, registry, lifecycle, provider, and disk checks:
   - Hub liveness: use the existing health endpoint/socket/client path where available.
   - Hub writability: perform a temporary write/read/delete readiness probe in the Hub-owned writable location and clean it up.
   - Stale Hub: detect stale heartbeat/lock/process metadata using existing TTL constants or the plan-specified threshold.
   - Registry consistency: validate schema, required records, duplicate ids, dangling references, and project/adapter/job references without mutating the registry.
   - Stale jobs/workers/leases: report expired or orphaned lifecycle records using existing TTL semantics.
   - Provider backoff/rate-limit: surface active backoff state, provider name/id if safe, retry-after timing, and remediation as a warning unless the source plan says it is a failure.
   - Disk space: check Hub, registry/project, and temp/work directories that the system writes to. Use plan/project thresholds if present; otherwise warn for clearly low free space while preserving existing behavior.
8. Centralize redaction before rendering:
   - Redact env values and keys containing token, secret, password, key, credential, auth, cookie, bearer, or similar sensitive markers.
   - Redact credentials embedded in URLs.
   - Redact adapter command args or config values that may include secrets.
   - Keep enough non-sensitive context for debugging, such as check ids, safe binary names, versions, relative labels, status, and remediation.
9. Wire `--json`:
   - `cpb doctor --json` prints only valid JSON on stdout.
   - `cpb report --json` prints only valid JSON on stdout.
   - Suppress banners, spinners, progress text, and human diagnostics from stdout in JSON mode. If diagnostics must appear, route them through the existing stderr/logging path.
   - Human output remains compatible with current behavior except for the newly required readiness rows/warnings.
10. Add or adjust focused tests:
   - Missing ACP adapter produces the expected failing check and redacted JSON/human output.
   - Stale Hub state is detected and reported.
   - Stale worker state is detected and reported.
   - Active provider rate-limit/backoff state is surfaced with retry/backoff details and no secret leakage.
   - Rust enabled but unavailable produces the expected failing check.
   - `doctor --json` and `report --json` parse as JSON, include aggregate status/checks, and contain no human-only noise on stdout.
   - Redaction removes secrets from both JSON and human output.
   - Add registry consistency, stale job, stale lease, and disk warning tests where existing test seams make this practical without broad harness rewrites.
11. Run the relevant existing test suite for the touched doctor/report/readiness areas, then run the project-standard lint/typecheck/test commands if available. Do not update unrelated snapshots or fakes to hide production regressions.
12. Write `wiki/projects/flow/outputs/deliverable-105.md` using the execute-to-review handshake format. Include actual changed files, exact verification commands/results, behavior notes, and any source-plan ambiguity.

### Evidence
- Planner phase only. No terminal commands were executed because this task explicitly prohibited terminal use during planning.
- This handoff was written only under `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/`.

### Risks
- The exact file paths and severities must be confirmed from the source plan and existing code before implementation; this handoff intentionally avoids guessing repo internals.
- ACP adapter smoke readiness can accidentally become too expensive or stateful. Keep it local, bounded, and provider-network-free.
- Disk-space APIs can vary by Node/runtime/platform. Use existing project helpers first; otherwise isolate platform handling and test fallback behavior.
- JSON output may expose more detail than human output. Apply redaction before rendering and assert against representative secrets.

### Self-Review
- Scope matches the requested P0.1 slice only.
- Plan includes the named readiness checks and the five explicitly required test scenarios.
- Plan preserves existing behavior and rejects unrelated cleanup.
- Plan gives Claude implementation authority but requires fresh verification evidence before completion claims.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 for `cpb doctor` / `cpb report` readiness checks using the scoped steps above, run focused and project-standard verification, then write `wiki/projects/flow/outputs/deliverable-105.md` for Codex review.

## Acceptance-Criteria
- [ ] The implementation explicitly follows P0.1 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and does not include unrelated cleanup or later-priority work.
- [ ] `cpb doctor --json` emits valid machine-readable JSON on stdout with aggregate status and per-check readiness results.
- [ ] `cpb report --json` emits valid machine-readable JSON on stdout with aggregate status and per-check readiness results.
- [ ] Human `cpb doctor` and `cpb report` behavior is preserved except for the newly required readiness checks/warnings.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate limits, and disk-space warnings.
- [ ] Missing ACP adapter is covered by a regression test.
- [ ] Stale Hub state is covered by a regression test.
- [ ] Stale worker state is covered by a regression test.
- [ ] Provider rate-limit/backoff state is covered by a regression test.
- [ ] Rust enabled but runtime unavailable is covered by a regression test.
- [ ] JSON and human output are redacted; tests prove representative secrets are not leaked.
- [ ] Existing behavior is preserved: no broad rewrites, no new dependencies, no unrelated snapshot churn, and no fake/mock edits merely to make tests pass.
- [ ] Relevant focused tests pass, and project-standard lint/typecheck/test verification is run or any inability to run it is documented in the deliverable.
- [ ] `wiki/projects/flow/outputs/deliverable-105.md` lists actual changed files, verification evidence, simplifications made, and remaining risks.
