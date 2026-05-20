## Handoff: codex -> claude

## Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-014-P0.1-cpb-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation authority; read it first and implement only the P0.1 doctor/report readiness slice.
- Add one shared readiness collection layer used by both `cpb doctor` and `cpb report`, rather than duplicating probe logic in each command.
- Add `--json` output for the doctor/report readiness surface with a stable, redacted schema containing summary counts, individual check results, versions, warnings/errors, and remediation hints.
- Preserve existing non-JSON output and exit behavior except for appending the new scoped readiness findings in the existing command style.
- Model readiness results as severity-based checks: `ok`, `warn`, and `error`; stale or degraded runtime state should report diagnostics and remediation, not mutate Hub state.
- Use existing command-runner, Hub, registry, provider, and runtime abstractions where present so tests can mock probes without depending on real local tools.
- Apply redaction before rendering both JSON and text output, including command output, environment-derived values, paths that include secret-looking segments, tokens, API keys, bearer headers, and provider credentials.
- Keep all tests deterministic with mocked filesystem/process/network boundaries; do not require real ACP adapters, Rust, Hub daemon, Git, npm, or network access in unit tests.

### Rejected
- Broad cleanup or reorganization outside P0.1; this task is readiness coverage only.
- Adding new dependencies for CLI parsing, disk inspection, redaction, or schema validation; use the project’s existing utilities and Node standard APIs.
- Auto-fixing stale jobs/workers/leases/registry entries from doctor/report; report readiness only.
- Live provider calls for smoke checks in tests; mock provider backoff and adapter probes instead.
- Changing fake/mock responders merely to force passing tests after production changes; update test doubles only when the new readiness API contract requires explicit coverage.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for this slice.
- Existing `cpb doctor` command module — add `--json` flag handling and render shared readiness results.
- Existing `cpb report` command module — include the same readiness result payload and `--json` rendering behavior expected by the source plan.
- Existing Hub client/state module — reuse for liveness, writability, jobs, workers, leases, and stale-state inspection.
- Existing registry module — reuse for registry consistency checks.
- Existing provider/backoff state module — reuse for active rate-limit/backoff readiness checks.
- Existing ACP adapter/runtime module — reuse for adapter presence, version, and smoke-readiness checks.
- Existing Rust runtime/config module — check Rust only when the project’s current configuration enables Rust/runtime features.
- Existing CLI test files for doctor/report, or adjacent new tests following the current test naming/location convention — cover the required P0.1 cases.

### Evidence
- Planning-only phase: no terminal commands were executed.
- This handoff was written under the allowed path: `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/plan-014.md`.
- Repository file paths beyond the named source plan and inbox output must be resolved by Claude during execution because this Codex phase was constrained from shell inspection.

### Risks
- The exact existing file names for doctor/report/readiness helpers must be resolved before editing; do not invent parallel command surfaces if suitable modules already exist.
- Existing exit-code behavior may already encode command-specific semantics; preserve it and add tests that document the current behavior before changing output shape.
- ACP adapter smoke readiness may be expensive or side-effectful if implemented naively; use the lightest existing no-op/help/version probe that proves the adapter can be invoked.
- Hub writability checks must create only temporary sentinel data through existing safe APIs and must clean up after themselves.
- Disk-space thresholds may already exist in project config; prefer existing thresholds. If none exist, use conservative warnings only and document the threshold in tests.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for P0.1 only, with JSON output, redaction, runtime/tooling checks, Hub/registry/provider state diagnostics, disk-space warnings, and focused tests for the mandated failure/degraded cases.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — execution must read this first and follow its P0.1 wording.
- The existing CLI modules that register and implement `cpb doctor` and `cpb report` — add flags/rendering without changing unrelated commands.
- The existing shared utility/module location used by CLI commands — add a readiness collector only if no equivalent already exists.
- The existing Hub, registry, provider, ACP adapter, Rust/runtime, and filesystem/process probe modules — extend or reuse narrowly for readiness data.
- The existing doctor/report test suites — add regression coverage for P0.1 and preserve current behavior.

**实现步骤**:
1. Read the promotion readiness source plan and extract only the P0.1 acceptance requirements. Confirm no P1/P2 or unrelated cleanup items enter the implementation.
2. Locate current `cpb doctor` and `cpb report` command registration, argument parsing, output rendering, exit-code handling, and tests. Add a regression test or snapshot-free assertion for the current default human output/exit behavior before changing rendering.
3. Define a shared readiness result contract in the existing CLI/domain style:
   - top-level fields: command/report metadata, timestamp, summary counts, `checks`, and optional `environment`;
   - check fields: stable `id`, `label`, `category`, `severity`, `status`, `message`, optional `details`, optional `version`, optional `remediation`;
   - no raw secrets or unredacted command output in any field.
4. Implement `--json` for `cpb doctor` and `cpb report` using the shared readiness payload. JSON mode must be valid parseable JSON on stdout, must not include decorative text, and must use the same redaction path as human output.
5. Add toolchain checks:
   - Node: report current runtime version and whether it satisfies the project’s supported range if that range is already encoded.
   - npm: probe availability/version through the existing command runner abstraction.
   - Git: probe availability/version through the existing command runner abstraction.
6. Add ACP adapter readiness checks:
   - presence: configured/default adapter can be resolved;
   - version: version can be obtained when the adapter supports it;
   - smoke readiness: light no-side-effect invocation succeeds, with timeout/error handling and redacted stderr/stdout.
7. Add Rust readiness only when enabled by existing configuration/runtime selection:
   - if disabled, omit or mark skipped according to the project’s current readiness convention;
   - if enabled and unavailable, emit a `warn` or `error` consistent with the source plan and existing command severity semantics;
   - include a focused test for Rust enabled but unavailable.
8. Add Hub readiness checks:
   - liveness: Hub process/service/API responds through the existing client;
   - writability: safe temporary write/delete or equivalent existing write probe succeeds;
   - stale Hub state: detect stale heartbeat/state using existing TTLs or constants, and report without mutation.
9. Add registry consistency checks:
   - registry file/store can be read;
   - entries have required identifiers/paths;
   - duplicate IDs/names, missing paths, malformed entries, and dangling active references are reported with remediation.
10. Add stale state checks for jobs, workers, and leases:
    - use existing job/worker/lease stores and TTL/heartbeat fields;
    - report stale jobs, stale workers, expired leases, and orphaned references with counts and representative redacted IDs;
    - add the required stale worker test and include stale job/lease coverage if current fixtures make it straightforward.
11. Add provider backoff/rate-limit readiness:
    - inspect existing provider state/backoff metadata;
    - report active rate limit/backoff with provider name, retry time/duration, and remediation;
    - add the required rate-limit/backoff test.
12. Add disk-space warnings:
    - inspect relevant writable paths used by Hub/registry/logs/workspaces;
    - warn when free space falls below an existing threshold; if no threshold exists, use a conservative warning threshold and keep it configurable/testable;
    - do not fail hard solely for low disk unless the source plan explicitly requires it.
13. Add central redaction coverage:
    - apply redaction before both JSON and text rendering;
    - test that secret-like values from environment/config/command output/provider state are masked.
14. Add required tests:
    - missing ACP adapter produces a readiness failure in both human and JSON surfaces;
    - stale Hub state is reported;
    - stale worker is reported;
    - active provider rate limit/backoff is reported;
    - Rust enabled but unavailable is reported;
    - `--json` output parses and contains the expected check IDs/severities without unredacted secrets.
15. Run the project’s relevant test, lint, typecheck, and static-analysis commands. If the repo has a narrower command for CLI/readiness tests, run that first, then the standard suite required by project docs. Record exact commands and results in `deliverable-014.md`.

**注意事项**:
- Keep changes scoped to P0.1 readiness checks and tests.
- Do not broaden into unrelated cleanup, formatting sweeps, dependency upgrades, command rewrites, or fake/test-double rewrites unrelated to the new readiness API.
- Preserve existing non-JSON user-facing behavior as much as possible; additive diagnostics are acceptable only where required by P0.1.
- Prefer existing utilities and constants over new abstractions; add a new helper only when it avoids duplicating readiness probe/rendering logic across doctor/report.
- Ensure readiness checks degrade gracefully when optional tools are absent: collect all checks and print a complete report instead of throwing on the first failure.
- Ensure all external probes have timeouts and return structured diagnostics with redacted output.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 as described above, run focused and standard verification, then write `deliverable-014.md` with changed files, test output, behavior notes, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid redacted JSON with summary counts and structured readiness checks.
- [ ] `cpb report --json` emits valid redacted JSON including the same readiness check payload or the source-plan-required report equivalent.
- [ ] Existing non-JSON `cpb doctor` and `cpb report` behavior is preserved except for the scoped P0.1 readiness additions.
- [ ] Readiness checks include Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is covered by an automated test.
- [ ] Stale Hub state is covered by an automated test.
- [ ] Stale worker state is covered by an automated test.
- [ ] Active provider rate limit/backoff is covered by an automated test.
- [ ] Rust enabled but unavailable is covered by an automated test.
- [ ] JSON output tests parse stdout as JSON and assert stable check IDs/severities.
- [ ] Redaction tests prove secrets do not appear in human or JSON output.
- [ ] All relevant tests pass, plus project lint/typecheck/static analysis commands required by the repo.
- [ ] `deliverable-014.md` lists changed files, simplifications made, verification evidence, and remaining risks.
