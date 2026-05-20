## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-047
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan Title
Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling scope. Read it first and implement only the P0.1 doctor/report readiness slice described there.
- Reuse the existing `cpb doctor` and `cpb report` command paths, readiness helpers, Hub state access, registry access, provider state access, and test conventions. Add a shared readiness collector only if the existing code does not already have one.
- Preserve current human-readable command behavior and exit-code semantics unless the source plan explicitly requires a P0.1 change. Add `--json` as an additive mode for both doctor and report.
- Use a stable JSON schema with redacted values by default: top-level schema version, generated timestamp, overall status, summary counts, and a checks array with check id, label, status, severity, message, remediation, and sanitized details.
- Model readiness check statuses as `pass`, `warn`, `fail`, and `not_applicable`. Required missing runtime pieces are failures; stale or degraded state is warning or failure according to existing project severity conventions and the source plan.
- Apply redaction before printing any human or JSON output. Redact API keys, bearer tokens, provider credentials, auth headers, Hub secrets, registry tokens, and credential-like URLs while preserving enough non-secret context to debug.

### Rejected
- Rewriting the CLI command architecture or broadening into unrelated cleanup. This task is P0.1 only.
- Adding new third-party dependencies for semver, disk checks, redaction, or JSON formatting unless the source plan explicitly permits it. Prefer existing utilities and standard library/runtime APIs.
- Updating fake LLM responders, snapshots, fixtures, or test doubles only to force tests green. Add purpose-built readiness tests or adjust existing doctor/report tests only where they directly cover the intended real behavior.
- Performing adapter smoke checks that start long-running interactive sessions or mutate user state. Use bounded, side-effect-minimal probes such as version, doctor, ping, or an existing no-op smoke surface.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth for P0.1 boundaries and severity expectations.
- Existing `cpb doctor` command implementation - add/route expanded readiness checks and `--json`.
- Existing `cpb report` command implementation - add/route readiness report output and `--json`.
- Existing readiness, Hub, registry, provider, adapter, runtime, redaction, and filesystem utility modules - extend only the modules that already own these responsibilities.
- Existing doctor/report readiness tests - add focused coverage for the required P0.1 scenarios.
- If no current shared readiness module exists, add one narrowly scoped module under the existing CLI or readiness area and keep command-specific formatting in the command layer.

### Evidence
- Planning-only handoff. No terminal commands were run in this Codex planning phase.

### Risks
- The source plan may define exact severity or threshold values for stale Hub, worker, lease, provider backoff, and disk-space states. Follow those values over any assumptions in this handoff.
- Adapter smoke readiness can easily become slow or side-effectful. Keep probes bounded with existing timeout patterns and never launch a persistent adapter session for doctor/report.
- Hub writability checks must clean up after themselves and must not corrupt registry, job, worker, lease, or provider state.
- JSON output must be machine-parseable even when checks fail, dependencies are missing, or exceptions occur. Do not mix prose, ANSI color, stack traces, or progress lines into JSON mode.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness checks for the P0.1 promotion-readiness must-haves, with additive `--json` output, redacted diagnostics, and focused regression tests for the required degraded states.

**Implementation Steps**:
1. Read the source plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
   - Extract only the P0.1 doctor/report readiness requirements, severity rules, stale thresholds, disk thresholds, and any required output fields.
   - Do not implement adjacent P0/P1 items from the same plan.
2. Locate the existing `cpb doctor` and `cpb report` command implementations and their tests.
   - Identify the current command parser, output formatter, exit-code behavior, and any existing readiness checks.
   - Keep current text output compatible with existing tests unless P0.1 explicitly changes it.
3. Add or extend a shared readiness collection path.
   - Return structured check results instead of formatting inside individual probes.
   - Include check ids for: `runtime.node`, `runtime.npm`, `runtime.git`, `adapter.acp`, `runtime.rust`, `hub.liveness`, `hub.writability`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, and `disk.space`.
   - Include status, severity, message, remediation, and sanitized details for each check.
4. Implement `--json` for both `cpb doctor` and `cpb report`.
   - JSON mode must emit only valid JSON to stdout.
   - Use the same readiness collector for both commands so text and JSON modes report the same underlying facts.
   - Include top-level `schemaVersion`, `generatedAt`, `overallStatus`, `summary`, `checks`, and a redaction indicator.
5. Implement runtime/tool checks.
   - Node and npm: detect presence, version, and minimum-version compliance using the project's existing engine or readiness policy.
   - Git: detect presence and version; include repository accessibility only if the existing command already treats that as part of Git readiness or the source plan requires it.
   - ACP adapter: discover adapter location from the existing config/registry/env path, verify presence, collect version, and run a bounded smoke-readiness probe.
   - Rust runtime: only check when the Rust runtime is enabled by existing config or environment. Report `not_applicable` when disabled and `fail` when enabled but unavailable.
6. Implement Hub, registry, and state checks.
   - Hub liveness: use the existing Hub client or state heartbeat mechanism to detect alive versus stale/unreachable Hub.
   - Hub writability: write and remove a small temporary probe in the existing Hub/state location, or use the existing writable-state helper if one exists.
   - Registry consistency: validate schema/version compatibility, duplicate ids, dangling project/adapter/provider references, and missing expected files using existing registry APIs.
   - Stale jobs/workers/leases: use existing TTL/heartbeat constants from the Hub or lease implementation. Do not invent new thresholds if the code or source plan already defines them.
   - Provider backoff: surface active provider rate-limit/backoff state, including retry timing if available, with secret values redacted.
   - Disk space: warn below the source-plan or existing configured thresholds for the repo, Hub/state directory, and temp/cache locations used by CPB.
7. Add a central redaction pass.
   - Reuse any existing redaction helper first.
   - Cover API keys, provider tokens, bearer/basic auth headers, credential-like URLs, Hub secrets, registry credentials, and environment variable values that match secret names.
   - Apply redaction recursively to JSON details and to human-readable readiness text.
8. Add focused tests for the required P0.1 scenarios.
   - Missing ACP adapter produces a failed adapter readiness check and parseable JSON.
   - Stale Hub state produces the expected stale Hub liveness/writability readiness result.
   - Stale worker heartbeat produces the expected stale worker readiness result.
   - Provider rate limit/backoff state is reported without leaking provider secrets.
   - Rust runtime enabled but unavailable produces a failure; Rust disabled produces `not_applicable` or no failure according to the source plan.
   - Add JSON parseability and redaction assertions where they naturally fit these tests.
9. Run focused verification first, then the standard project verification that covers the touched CLI package.
   - Run the doctor/report readiness tests you changed or added.
   - Run the package-level lint/typecheck/test commands required by the repo for this area.
   - If a broader command is too slow or blocked, document the exact blocker and the focused evidence in the deliverable.
10. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-047.md` after implementation.
    - List every changed file.
    - Include the commands run and their results.
    - Include a short note confirming that only P0.1 was implemented and no unrelated cleanup was included.

### Notes for Implementation
- Keep readiness probes deterministic and testable by injecting filesystem, clock, process execution, Hub client, registry, provider state, and config dependencies where the existing code already supports injection.
- Do not expose raw command stderr in JSON details until it has passed through redaction.
- Bound external command probes with the project's existing timeout mechanism.
- Keep disk probes lightweight and do not allocate files to test free space.
- Prefer extending current command tests over creating a parallel test harness.
- If current text output snapshots exist, only update them for intentional P0.1 output additions and call that out in the deliverable.

## Next-Action
Implement TASK-047 according to the scoped steps above. Use the promotion readiness plan as the source of truth, change only the existing doctor/report readiness surface needed for P0.1, add the required tests, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-047.md`.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only, includes the P0.1 readiness checks, includes summary/overall status, and redacts secrets.
- [ ] `cpb report --json` emits valid JSON only, includes the same underlying readiness facts as doctor/report text mode, and redacts secrets.
- [ ] Human-readable `cpb doctor` and `cpb report` behavior remains compatible with existing behavior except for intentional P0.1 readiness additions.
- [ ] Node, npm, and Git readiness checks report presence, version, and minimum-version compliance according to existing project policy or the source plan.
- [ ] ACP adapter readiness reports presence, version, and bounded smoke readiness; missing adapter is covered by a failing test.
- [ ] Rust runtime readiness runs only when enabled; Rust enabled but unavailable is covered by a failing test, and Rust disabled does not fail readiness.
- [ ] Hub liveness and writability are checked; stale or unreachable Hub state is covered by a test.
- [ ] Registry consistency is checked for schema/version issues, duplicate ids, and dangling references using existing registry APIs.
- [ ] Stale jobs, workers, and leases are detected using existing TTL/heartbeat policy; stale worker is covered by a test.
- [ ] Provider rate limit/backoff state is surfaced with retry/backoff detail when available; rate-limit/backoff state is covered by a test and does not leak secrets.
- [ ] Disk-space warnings are reported for the relevant repo, Hub/state, and temp/cache paths without writing large files.
- [ ] Redaction is applied to JSON and human output, including nested details and captured process errors.
- [ ] All added or adjusted tests pass, and the deliverable records focused and package-level verification evidence.
