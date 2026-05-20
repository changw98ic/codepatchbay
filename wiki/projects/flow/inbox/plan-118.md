## Handoff: codex -> claude

# Plan 118: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1 expand cpb doctor/report readiness checks

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-118 / P0.1 promotion readiness doctor-report checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for this slice, but implement only P0.1.
- Expand the existing `cpb doctor` and `cpb report` readiness surfaces through shared diagnostics logic rather than duplicating command-specific checks.
- Add `--json` output as an additive interface while preserving existing human-readable default behavior and existing exit-code semantics unless the current implementation already defines stricter readiness failure behavior.
- Model readiness checks as structured results with stable check ids, categories, status, redacted detail fields, remediation text, and optional machine-readable metadata.
- Keep checks read-only: report readiness, stale state, rate limits, and disk pressure; do not auto-repair Hub state, registries, jobs, workers, leases, provider backoff, or adapters in this P0.1 slice.
- Reuse existing project utilities for config loading, Hub access, registry/state reads, logging, command parsing, redaction, filesystem checks, and test fakes before adding new helpers.

### Rejected
- Broad cleanup of the CLI, Hub, provider, registry, or worker lifecycle code is out of scope for P0.1.
- Adding new runtime dependencies for diagnostics is rejected; use Node standard APIs and existing project utilities.
- Implementing automatic remediation for stale jobs/workers/leases, Hub cleanup, adapter install, or provider backoff reset is rejected because this task is readiness reporting only.
- Changing fake/mock responders merely to force tests green is rejected; adjust production diagnostics and only update test doubles when the test double itself needs to expose an existing real workflow.
- Reworking ACP adapter, Rust runtime, provider backoff, or Hub architecture is rejected; only add readiness probes and reporting.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness checks for the P0.1 promotion-readiness slice. The implementation must include `--json` output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime readiness when enabled, Hub liveness and writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit visibility, disk-space warnings, redaction, and focused tests for missing adapter, stale Hub, stale worker, rate limit, and Rust unavailable.

**Files to inspect and modify only as needed**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth for P0.1 boundaries.
- Existing CLI command implementation for `cpb doctor` - add/route the expanded readiness checks and `--json` option.
- Existing CLI command implementation for `cpb report` - include the same readiness data and support `--json` if the command has its own output mode.
- Existing readiness, diagnostics, health, or environment-check module - extend this if present; create a small shared module near the existing CLI diagnostics only if no shared owner exists.
- Existing Hub client/state/registry modules - add read-only helper calls only when current APIs cannot expose liveness, writability, stale state, registry consistency, or lease data.
- Existing provider/backoff state module - expose read-only backoff/rate-limit status for diagnostics.
- Existing ACP adapter resolution module - expose adapter presence, version, and smoke readiness checks without changing adapter behavior.
- Existing Rust runtime feature/config module - expose enabled/disabled detection and runtime availability checks without changing runtime selection.
- Existing CLI tests for doctor/report/diagnostics - add focused cases for this slice and preserve existing assertions.
- Existing test fixtures/fakes for Hub, workers, leases, providers, adapters, and Rust runtime - update only when needed to represent the real workflow being tested.

**Implementation steps**:
1. Read the promotion readiness plan and copy only the P0.1 requirements into the implementation checklist. Do not implement other P0/P1/P2 items from that plan.
2. Locate the current `cpb doctor` and `cpb report` command owners, their option parsing, output rendering, exit-code behavior, and existing tests. Record the exact files touched in the final deliverable.
3. Define or extend a shared readiness result contract used by both commands. Include at minimum `schemaVersion`, `generatedAt`, `overallStatus`, `checks[]`, and per-check fields: `id`, `category`, `status`, `summary`, `details`, `remediation`, and `metadata`. Keep ids stable and deterministic for tests.
4. Implement output rendering:
   - Default output remains human-readable and compatible with existing behavior.
   - `--json` writes valid JSON to stdout without ANSI styling or unstructured log lines.
   - Sensitive values are redacted before both human and JSON rendering.
   - `overallStatus` is derived from check statuses using existing severity conventions where present; otherwise use `fail > warn > skip > pass`.
5. Add environment prerequisite checks:
   - Node version readiness against the repo's supported version source.
   - npm presence/version readiness when npm is part of supported workflow.
   - Git presence/version readiness.
   - Disk-space warning for the project root, Hub state directory, and temp/output area if these paths are available from existing config. Use existing thresholds if present; otherwise centralize conservative warning/critical thresholds in the diagnostics module.
6. Add ACP adapter checks:
   - Presence/resolution of the configured/default ACP adapter.
   - Version reporting when available.
   - Smoke readiness using the lightest existing adapter handshake/version/capabilities path. The smoke check must be bounded, read-only, and must not start long-running jobs.
   - Missing adapter must produce a deterministic `fail` or existing-equivalent unhealthy status with remediation.
7. Add runtime and Hub checks:
   - Rust runtime check is `skip` when Rust support is disabled, and unhealthy when Rust support is enabled but required runtime/tooling is unavailable.
   - Hub liveness check verifies the current Hub endpoint/process/heartbeat using existing APIs.
   - Hub writability check verifies that the Hub state path can be written or safely probed using existing filesystem helpers. Do not mutate durable state beyond a temporary probe file if the project already uses that pattern.
   - Stale Hub state must be detected through existing heartbeat or lock/socket metadata and reported distinctly from "Hub not running."
8. Add registry, worker, job, lease, and provider checks:
   - Registry consistency checks for broken references, invalid project/session ownership, duplicate active records, and leases without live owners where this data is already represented.
   - Stale jobs, workers, and leases checks must use existing TTL/heartbeat constants where present. If constants do not exist, define them once in the diagnostics layer and document why.
   - Provider backoff check surfaces active backoff, rate-limit state, retry timing, provider id/name, and scope without exposing tokens, prompts, request bodies, API keys, or raw headers.
   - Rate-limit/backoff should be a warning when recovery is scheduled and a failure only when existing provider state marks it terminal or blocks all configured providers.
9. Add or adjust tests:
   - Missing ACP adapter: `cpb doctor --json` reports the adapter check as unhealthy, redacts paths/secrets as required, and exits according to existing doctor failure semantics.
   - Stale Hub: stale heartbeat/socket/lock state is reported separately from a live Hub and from a missing Hub.
   - Stale worker: stale worker and related lease/job references are counted and surfaced in registry/stale-state checks.
   - Provider rate limit: active backoff/rate-limit state appears in JSON and human output with retry information and without sensitive fields.
   - Rust unavailable: when Rust runtime is enabled and unavailable, readiness is unhealthy; when disabled, the Rust check is skipped.
   - Add redaction assertions covering secrets in env/config/provider/adapter/Hub detail payloads.
   - Preserve existing doctor/report tests and assertions for default output.
10. Run targeted and full verification using the repo's existing package scripts. Capture the exact commands and important output in the deliverable. If a full suite is too expensive or unavailable, explain the gap and include targeted test evidence.

**Check ids to prefer unless the codebase already has a naming convention**:
- `env.node`
- `env.npm`
- `env.git`
- `env.disk_space`
- `adapter.acp.presence`
- `adapter.acp.version`
- `adapter.acp.smoke`
- `runtime.rust`
- `hub.liveness`
- `hub.writability`
- `registry.consistency`
- `state.stale_jobs`
- `state.stale_workers`
- `state.stale_leases`
- `provider.backoff`
- `security.redaction`

**Notes and constraints**:
- Keep the diff small and scoped to P0.1 readiness checks.
- Preserve existing behavior for non-JSON output, config loading, command names, and provider/Hub/runtime behavior.
- Do not broaden into unrelated cleanup, formatting churn, dependency changes, architecture rewrites, or remediation commands.
- Prefer dependency injection or existing test harness seams over global process mutation in tests.
- Ensure JSON tests parse stdout as JSON rather than relying only on snapshots.
- Ensure timestamps, paths, and ordering are deterministic or normalized in tests.

### Evidence
- Planner phase did not run terminal commands because TASK-118 explicitly prohibits terminal commands in this phase.
- Planner phase did not inspect repository files through shell commands. Claude must read the source plan and current code before editing.
- This handoff is based on the provided P0.1 task text and the required handshake protocol.

### Risks
- Exact implementation file paths are intentionally not asserted here because this planning phase was constrained from using terminal inspection. Claude must identify existing command/module owners before editing.
- Existing exit-code semantics for `cpb doctor` and `cpb report` are unknown from this planning phase; preserve them unless current tests/specs prove a change is required.
- Rust enablement and ACP adapter smoke paths may already have project-specific abstractions; use those existing abstractions rather than creating parallel detection logic.
- Hub writability probes can accidentally mutate durable state if implemented carelessly; keep probes temporary and use existing safe filesystem helpers.

## Next-Action
Implement only P0.1 from the promotion readiness plan. First inspect `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and the existing `cpb doctor`/`cpb report` code, then make the smallest scoped production and test changes needed to satisfy the acceptance criteria. Run targeted and full available verification. When complete, write `deliverable-118.md` with changed files, verification evidence, remaining risks, and any not-tested gaps.

## Acceptance-Criteria
- [ ] `cpb doctor` includes readiness checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] `cpb report` exposes the same readiness data or calls the same shared readiness collector, without duplicating divergent check logic.
- [ ] `cpb doctor --json` emits valid redacted JSON with stable check ids, statuses, summaries, remediation text, and an overall status.
- [ ] `cpb report --json` emits valid redacted JSON including readiness data, if `cpb report` has or receives a JSON mode for this slice.
- [ ] Default human-readable output for existing `cpb doctor` and `cpb report` behavior remains compatible with current tests and user workflows.
- [ ] Missing ACP adapter is covered by a test and produces a clear unhealthy readiness result with remediation.
- [ ] Stale Hub state is covered by a test and is reported distinctly from a live Hub and a missing Hub.
- [ ] Stale worker state is covered by a test and includes stale worker/lease/job counts where available.
- [ ] Provider rate-limit/backoff state is covered by a test and exposes retry/backoff information without leaking credentials, prompts, raw headers, or tokens.
- [ ] Rust unavailable is covered by a test for the enabled-runtime case, and disabled Rust support is reported as skipped rather than failed.
- [ ] Redaction is covered by tests for JSON and human output paths.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, architecture rewrites, remediation commands, or broad behavior changes are included.
- [ ] Targeted tests for the new readiness cases pass.
- [ ] The repo's relevant existing verification commands are run and reported in `deliverable-118.md`, with explicit `Not-tested` notes for any unavailable verification.

### Planner Self-Review
- The plan addresses the exact P0.1 task and does not expand into unrelated promotion-readiness work.
- The plan is implementation-oriented, bite-sized, and includes concrete acceptance criteria.
- The plan preserves behavior and asks Claude to inspect current code before choosing exact file owners.
- The plan honors the planner-phase constraints by writing only this inbox handoff file and not running terminal commands.
