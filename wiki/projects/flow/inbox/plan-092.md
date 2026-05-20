## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-092 / P0.1 promotion readiness doctor-report checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the requirements source of truth and implement only P0.1 from that plan.
- Extend the existing `cpb doctor` / `cpb report` readiness surface in place. Do not create a second readiness command, new CLI namespace, or broad cleanup pass.
- Add machine-readable `--json` output while preserving the existing default human-readable output and exit behavior unless the source plan explicitly says otherwise.
- Model readiness checks as structured results with stable IDs, status, severity, message, optional details, and remediation text so both text and JSON outputs use the same collector.
- Include checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- Redact sensitive values in both text and JSON output before anything is printed, logged, or returned from report generation.
- Add or adjust focused tests for missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, and Rust unavailable when Rust is enabled. Add redaction assertions around the new outputs.

### Rejected
- Rejected implementing other P0/P1/P2 promotion-readiness work because this handoff is limited to P0.1.
- Rejected unrelated refactors of command registration, provider orchestration, Hub protocol, or registry layout because the task requires a scoped readiness expansion.
- Rejected adding new dependencies unless an existing project dependency cannot provide a required check and the source plan explicitly permits it.
- Rejected changing fake/mock responders, snapshots, fixtures, or test doubles merely to make production changes pass. Update test fixtures only when the new readiness behavior is the subject of the test.
- Rejected live network/provider calls in tests. Use existing fakes, dependency injection, temp directories, fake clocks, and local stubs.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only requirements source; confirm P0.1 details before editing.
- Existing `cpb doctor` command implementation - locate by searching command registration for `doctor`; add `--json` and readiness output wiring in the current file.
- Existing `cpb report` command implementation - locate by searching command registration for `report`; share the same readiness collector where report includes doctor/readiness data.
- Existing readiness, diagnostics, Hub, registry, provider-state, and redaction utilities - reuse current modules before adding new helpers.
- Existing CLI/doctor/report test files - add focused tests near current command coverage and adjust only behavior-relevant fixtures.

### Evidence
- Planning-only phase. No terminal commands were executed and no code was inspected or changed.
- Implementation evidence must be supplied in `deliverable-092.md` after Claude runs the required tests.

### Risks
- Exact implementation paths are intentionally left to repository discovery because this planning phase may not run terminal commands.
- ACP adapter smoke readiness can become slow or side-effectful if implemented as a real session start. Keep it bounded, local, timeout-protected, and aligned with any existing adapter probe.
- Rust runtime status must be skipped when Rust is disabled; reporting it as a failure while disabled would be a behavior regression.
- Hub liveness and stale worker/lease detection depend on existing heartbeat and TTL semantics. Reuse current constants where available instead of inventing new thresholds.
- Redaction must run on nested JSON details, command output snippets, provider errors, environment-derived strings, and remediation text.

### Scope

**Goal**: Expand P0.1 promotion-readiness coverage for `cpb doctor` / `cpb report` with structured JSON output and focused tests, without broadening into unrelated cleanup.

**Implementation steps**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and note any explicit severity, exit-code, field-name, or threshold requirements. If this handoff conflicts with the source plan, follow the source plan.
2. Locate the current `cpb doctor` and `cpb report` implementations plus their tests. Capture the current default output and exit behavior from existing tests before editing.
3. Introduce or extend a shared readiness collector that returns a structured result:
   - `schemaVersion`
   - `generatedAt`
   - `ok`
   - `summary` counts for pass/warn/fail/skip
   - `checks[]` with stable `id`, `label`, `status`, `severity`, `message`, optional `details`, and optional `remediation`
4. Wire `--json` into `cpb doctor` and the relevant `cpb report` path using the shared readiness result. JSON output must be deterministic enough for tests, avoid ANSI formatting, and preserve default text output when `--json` is absent.
5. Implement environment/tool checks:
   - Node: detect current Node version from the running process or existing runtime utility and compare against existing project requirements if available.
   - npm: verify availability/version using the existing command runner or executable probe abstraction.
   - Git: verify availability/version with the same runner/probe abstraction.
6. Implement ACP adapter readiness:
   - Detect configured adapter presence.
   - Report adapter version when available.
   - Add a bounded smoke probe that proves the adapter is invocable/readiness-capable without starting a real long-running workflow.
   - Missing adapter must produce a clear failed readiness check with actionable remediation.
7. Implement Rust runtime readiness only when the project/config enables Rust runtime support:
   - When enabled, verify required Rust runtime binary/toolchain availability using existing config and probe utilities.
   - When disabled, emit a skipped check or omit the check only if the source plan requires omission.
   - Rust unavailable while enabled must be covered by tests.
8. Implement Hub and registry readiness:
   - Hub liveness: report reachable/running/heartbeat status using current Hub protocol or state files.
   - Hub writability: verify the Hub-owned state/registry/cache location is writable with a safe temporary probe or existing write check.
   - Registry consistency: detect invalid paths, missing project records, duplicate IDs/names, orphaned Hub entries, or mismatches already represented in current registry data.
9. Implement stale-state readiness:
   - Detect stale jobs, workers, and leases using existing heartbeat timestamps, TTLs, and lease ownership rules.
   - Report stale state as warnings or failures according to the source plan and existing severity conventions.
   - Do not delete or mutate stale state unless existing doctor behavior already performs cleanup for the same condition.
10. Implement provider backoff and disk checks:
   - Surface active provider rate-limit/backoff state with provider name, status, and safe timing metadata.
   - Never expose API keys, tokens, request payloads, raw headers, or unredacted provider errors.
   - Add disk-space warnings for Hub state, registry/cache, workspace, and temp locations using existing filesystem utilities where available.
11. Add redaction coverage:
   - Centralize redaction through the existing redaction utility if one exists.
   - Apply it to text output and recursively to JSON string fields/details before output.
   - Include tests proving secrets/tokens are not present in `--json` or text output.
12. Add focused tests:
   - Missing ACP adapter reports the correct failed check and remediation.
   - Stale Hub reports liveness/heartbeat failure or warning without crashing.
   - Stale worker is reported distinctly from stale jobs and leases.
   - Provider rate-limit/backoff appears as a readiness warning with redacted details.
   - Rust unavailable is reported only when Rust runtime is enabled.
   - Existing default doctor/report behavior remains compatible when `--json` is not passed.
13. Run the project’s relevant verification commands after implementation:
   - Targeted doctor/report tests.
   - Broader CLI/readiness tests if present.
   - Typecheck/lint/test commands required by the repository.
14. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-092.md` using the execute-to-review handoff format with changed files, test output, known gaps, and any source-plan nuance discovered during implementation.

### Notes
- Keep edits small and local to readiness collection, doctor/report output, and directly related tests.
- Prefer existing command-runner abstractions over direct shell calls so probes are testable and timeout-controlled.
- Prefer existing config/env parsing utilities over ad hoc environment reads.
- Preserve human output ordering where practical; append new readiness lines rather than rearranging unrelated sections.
- Use stable check IDs such as `runtime.node`, `runtime.npm`, `tool.git`, `acp.adapter`, `rust.runtime`, `hub.liveness`, `hub.writable`, `registry.consistency`, `state.jobs.stale`, `state.workers.stale`, `state.leases.stale`, `provider.backoff`, and `disk.space` unless the source plan defines different IDs.

## Next-Action
Read the source promotion-readiness plan, implement only P0.1 according to the steps above, run the relevant verification, then write `deliverable-092.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid machine-readable readiness JSON with summary, stable check IDs, statuses, severities, messages, and redacted details.
- [ ] `cpb report` includes the expanded readiness data in the appropriate existing report path and supports JSON readiness data where the command already supports or is extended to support JSON output.
- [ ] Default non-JSON `cpb doctor` / `cpb report` behavior remains backward-compatible except for the scoped addition of P0.1 readiness findings.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is reported with a failed readiness check and actionable remediation.
- [ ] Stale Hub state is reported without crashing and without deleting state.
- [ ] Stale worker state is reported distinctly from stale jobs and stale leases.
- [ ] Provider rate-limit/backoff state is reported without exposing secrets, tokens, raw headers, request bodies, or unredacted provider errors.
- [ ] Rust unavailable is reported when Rust runtime support is enabled and skipped or omitted when Rust runtime support is disabled, according to the source plan.
- [ ] Text and JSON outputs are redacted recursively and covered by tests.
- [ ] Focused tests for missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable pass.
- [ ] Existing relevant doctor/report tests pass or are adjusted only for intentional P0.1 behavior changes.
- [ ] Lint, typecheck, and the repository’s relevant test suite pass, or any unavailable verification is explicitly documented in `deliverable-092.md`.
