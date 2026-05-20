# Plan-119: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-119-P0.1-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.1 doctor/report readiness slice.
- Extend the existing `cpb doctor` and `cpb report` surfaces instead of creating a new command or a parallel health-check CLI.
- Add `--json` output to the existing commands with a stable machine-readable readiness schema while preserving current human-readable output and existing exit-code behavior unless the current tests prove a different established contract.
- Implement readiness checks as a small shared collector used by both doctor/report so test coverage and redaction behavior are consistent.
- Keep checks non-destructive: liveness probes and writability probes may create only temporary sentinel data in an existing Hub-owned temp or state area and must clean it up.
- Use existing project utilities, config readers, registries, Hub clients, logging, command runners, fake clocks, and test harnesses. Do not add dependencies for this P0.1 work.
- Redact secrets in both human and JSON output before rendering or logging. Redaction must cover tokens, API keys, bearer values, auth headers, credentials embedded in URLs, and sensitive environment variable values.

### Rejected
- Broad readiness redesign | P0.1 requires scoped expansion of `cpb doctor/report`, not a new observability subsystem.
- Changing job, worker, lease, provider, or Hub runtime behavior | This slice is diagnostic/reporting only.
- Adding new package dependencies for disk, process, or semver checks | Reuse Node built-ins and existing utilities.
- Updating fake/mock tests merely to hide production behavior changes | Adjust fakes only when adding purpose-built coverage for the new readiness checks.
- Making real provider API calls for adapter/provider smoke tests | Readiness must remain safe, fast, and deterministic.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness checks for promotion P0.1 only. The implementation must report JSON and human-readable readiness for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness and writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction. Existing behavior outside these readiness surfaces must remain unchanged.

**Involved files**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read only; confirm P0.1 boundaries before editing.
- Existing `cpb doctor` command module - add/route new readiness collector and `--json` flag support without removing current output.
- Existing `cpb report` command module - expose the same readiness collector and `--json` flag support where report currently surfaces health/readiness information.
- Existing CLI option parsing/types for `cpb doctor` and `cpb report` - add the `json` option using the local option style.
- Existing Hub client/state modules - add liveness and safe writability probes through existing APIs.
- Existing registry/job/worker/lease/provider state modules - add read-only consistency, staleness, and backoff/rate-limit inspection.
- Existing ACP adapter discovery/invocation modules - add presence, version, and safe smoke readiness checks.
- Existing Rust runtime integration/config modules - add an enabled-only runtime availability/version check.
- Existing CLI/readiness tests - add or adjust focused tests for the required P0.1 cases.

**Implementation steps**:
1. Read the source promotion plan and extract only P0.1 requirements. Then inspect the current `cpb doctor` and `cpb report` implementations, their option parsers, output formatters, and related tests. Stop scope expansion if a discovered issue is not necessary for the P0.1 checks.
2. Add a shared readiness result model near the existing CLI health/doctor/report code. Use explicit check IDs, for example `runtime.node`, `runtime.npm`, `runtime.git`, `adapter.acp`, `runtime.rust`, `hub.liveness`, `hub.writability`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, and `disk.space`. Each result should include `status` (`pass`, `warn`, `fail`, or `skip`), `summary`, optional `detail`, optional `remediation`, and redacted `evidence`.
3. Add a shared renderer for human output and JSON output. JSON should include at least `schemaVersion`, `generatedAt`, `command`, `overallStatus`, `summary` counts, `checks`, and `redactions`. Preserve current human text where tests or snapshots depend on it; append new readiness sections instead of replacing unrelated output.
4. Wire `--json` into `cpb doctor` and `cpb report`. The flag must render only JSON to stdout, with no progress logs or unredacted diagnostics mixed into the JSON stream. Preserve the command's existing exit-code policy; if there is no clear existing policy, return non-zero when any required check is `fail`, zero for `pass`, `warn`, or `skip`.
5. Implement Node/npm/Git checks. Use `process.version` for Node. Use the project's existing command-runner abstraction for `npm --version` and `git --version` with a short timeout. Missing or non-runnable required tools should produce `fail`; version command failures should include redacted stderr in evidence.
6. Implement ACP adapter readiness. Use existing ACP adapter discovery/configuration. Report presence, resolved command/path/package identity when available, adapter version when available, and a safe smoke readiness check such as version/help/protocol dry-run already supported by the adapter. Do not call real providers. Missing adapter must produce a `fail`.
7. Implement Rust runtime readiness only when the Rust runtime is enabled by existing config/feature flag/environment. If disabled, report `skip`. If enabled, verify runtime binary/library availability and version with existing integration points. Rust unavailable while enabled must produce `fail`.
8. Implement Hub liveness and writability checks using existing Hub APIs. Liveness should verify the configured Hub can be reached or opened. Writability should create and remove a temporary sentinel record/file in the Hub-owned state area. A stale/unreachable Hub must be reported without corrupting existing state.
9. Implement registry consistency and stale state checks. Validate active registry entries against job, worker, and lease state; detect missing referenced records, duplicate active IDs, invalid timestamps, orphan active leases, stale active jobs, stale workers, and expired leases. Use existing TTL constants when present. If no constants exist, define local diagnostic thresholds in one place with names that make the policy explicit.
10. Implement provider backoff/rate-limit reporting. Read existing provider backoff state and report active backoff/rate-limit windows with provider names redacted only when they contain sensitive material. Active rate-limit/backoff should be `warn` unless current project policy already treats it as fatal readiness failure.
11. Implement disk-space warnings for the repository/HUB state paths using Node built-ins available in the supported runtime, such as `fs.statfs` when present. Warn below a conservative threshold such as less than 1 GiB free or less than 5 percent free, and fail only if the Hub writable path cannot be checked or written where writability is required.
12. Add central redaction coverage used by all readiness renderers. Include direct tests for API-key-like values, bearer tokens, auth headers, credentialed URLs, and sensitive env var names. Redaction must happen before JSON serialization and before human rendering.
13. Add focused tests for the required cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled. Also add tests for valid `--json` output on both `cpb doctor` and `cpb report`, and a regression test that existing human output still contains the previous key sections.
14. Run the narrowest relevant test set first, then the existing CLI test suite that covers doctor/report. Fix only failures caused by this P0.1 change. Record exact commands and outcomes in the deliverable.

**Notes and constraints**:
- Keep the diff small and local to doctor/report readiness, CLI option parsing, shared readiness helpers, and tests.
- Do not modify unrelated snapshots, fixtures, fake LLM responders, or broad mocks unless the new P0.1 tests require a purpose-built fake state.
- Do not introduce network calls to providers or destructive Hub operations.
- Make check status deterministic in tests by injecting clock, command runner, config, Hub state, and provider state through existing seams or minimal local parameters.
- If existing report/doctor naming differs, keep the existing names and place the shared readiness code adjacent to the current implementation.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - source of truth, read only.
- Existing `cpb doctor` command implementation - modify.
- Existing `cpb report` command implementation - modify.
- Existing readiness/health/diagnostic helpers adjacent to doctor/report - modify or add one small shared module.
- Existing ACP adapter discovery module - read and minimally integrate.
- Existing Rust runtime config/integration module - read and minimally integrate.
- Existing Hub state/client module - read and minimally integrate.
- Existing registry, job, worker, lease, and provider state modules - read and minimally integrate.
- Existing CLI doctor/report tests - modify or add focused P0.1 tests.

### Evidence
- Planning-only phase. No terminal commands were executed.
- The implementation plan is constrained to the explicit P0.1 requirements supplied in the task prompt.
- Required test cases from the task are included: missing adapter, stale Hub, stale worker, rate limit, and Rust unavailable.

### Risks
- Existing `cpb doctor` and `cpb report` may not share a current health-check abstraction. If so, add the smallest shared readiness collector rather than refactoring the commands broadly.
- Rust runtime enablement may be represented by config, env, build feature, or package availability. Follow existing project convention and test both enabled-unavailable and disabled-skip paths.
- Disk-space APIs differ by Node version and platform. Use available built-ins and report `skip` or `warn` with remediation if the platform cannot provide free-space data.
- Existing exit-code behavior may be undocumented. Preserve behavior shown by current tests and add explicit tests for the new JSON path.

## Next-Action
Implement the P0.1 doctor/report readiness expansion exactly as scoped above. Read the promotion readiness plan first, make the minimal code and test changes, run the targeted and relevant CLI tests, then write `deliverable-119.md` with changed files, verification commands/output, remaining risks, and any deviations from this plan.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only, with schema/version metadata, summary counts, overall status, check list, and redaction metadata.
- [ ] `cpb report --json` emits valid JSON only and includes the same readiness checks where report currently exposes readiness/health details.
- [ ] Existing human-readable `cpb doctor` and `cpb report` behavior is preserved, with new readiness information added without unrelated output rewrites.
- [ ] Node, npm, and Git readiness checks report presence/version and correctly fail or warn according to existing command policy.
- [ ] ACP adapter readiness reports presence, version when available, and safe smoke readiness; missing adapter is covered by a failing test.
- [ ] Rust runtime readiness is skipped when disabled and fails when enabled but unavailable; Rust unavailable is covered by a test.
- [ ] Hub liveness and safe writability are checked without destructive writes; stale/unavailable Hub is covered by a test.
- [ ] Registry consistency checks detect inconsistent active jobs/workers/leases without mutating runtime state.
- [ ] Stale jobs, workers, and leases are reported deterministically; stale worker is covered by a test.
- [ ] Provider backoff/rate-limit state is reported; active rate limit/backoff is covered by a test.
- [ ] Disk-space warnings are produced for low free space on relevant repo/Hub paths, with deterministic test coverage if the project has an existing fs abstraction.
- [ ] Secrets are redacted from both human and JSON output, including tokens, API keys, bearer values, auth headers, credentialed URLs, and sensitive environment values.
- [ ] No unrelated cleanup, dependency additions, provider network calls, or broad runtime behavior changes are included.
- [ ] Targeted doctor/report tests pass, and the deliverable records exact verification commands and results.
