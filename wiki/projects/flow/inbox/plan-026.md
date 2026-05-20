## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-026
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Anchor the implementation in the existing readiness surface. Read-only code intelligence found `server/services/readiness-checks.js` with `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, and check helpers for Node, npm, Git, ACP adapter, Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk space, `common.sh`, and server dependencies.
- Wire the readiness runner into the existing `cpb doctor` and `cpb report` command paths instead of creating a parallel diagnostics command.
- Preserve existing human-readable output as the default. Add `--json` as an opt-in output mode for both `doctor` and `report`; JSON output must contain no ANSI styling and must be parseable from stdout.
- Use a stable check shape for both human and JSON output: `id`, `category`, `status`, `message`, optional `details`, and optional `remediation`, plus a top-level summary generated from check statuses.
- Redact secrets before formatting or returning either output mode. Redaction applies recursively to check messages, details, remediation text, environment-derived paths/URLs when they contain credentials, provider backoff data, and error output.
- Readiness checks are observational only. They must not clean stale jobs, workers, leases, registry rows, or Hub files.
- Add focused tests for the required P0.1 scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when Rust is enabled.

### Rejected
- Broad cleanup/refactor outside P0.1 | the task explicitly says to keep changes scoped and preserve existing behavior.
- Adding new dependencies for CLI parsing, disk checks, command execution, or redaction | existing code and Node built-ins should be sufficient.
- Changing fake/mock responders, snapshots, fixtures, or unrelated test doubles merely to make tests pass | only adjust tests that directly cover readiness behavior or existing command output contracts affected by this P0.1 slice.
- Making `--json` the default output | this would break existing CLI behavior.
- Auto-repairing stale Hub/job/worker/lease state in `doctor` or `report` | P0.1 is readiness reporting, not remediation execution.
- Emitting raw subprocess stderr/stdout or provider errors directly | all externally sourced strings must pass through redaction.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness reporting for promotion readiness P0.1 only. The result should report toolchain, adapter, runtime, Hub, registry, stale state, provider backoff, disk, and redaction readiness in human and JSON forms while preserving current behavior for users who do not pass `--json`.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — source-of-truth requirements; read before editing and use only P0.1.
- `server/services/readiness-checks.js` — central readiness check implementation and human/JSON formatting.
- Existing `cpb doctor` command handler — add or verify `--json` support and invoke `runReadinessChecks`.
- Existing `cpb report` command handler or report/diagnostics builder — add or verify `--json` support and include the same readiness result.
- Existing diagnostics/redaction helper, likely under `server/services/observability.js` if still current — reuse or align redaction behavior instead of duplicating incompatible sanitizers.
- Existing CLI/readiness tests — add focused coverage for the required P0.1 scenarios and command output behavior.

**实现步骤**:
1. Read the source-of-truth plan and extract only the P0.1 readiness checklist. Ignore P0.2+ and any unrelated cleanup ideas.
2. Inspect the current `cpb doctor` and `cpb report` command paths. Identify where arguments are parsed and where stdout/stderr/exit status are decided.
3. Verify `server/services/readiness-checks.js` already covers the required check categories. Fill only concrete gaps:
   - Node and npm presence/version checks.
   - Git presence/version check.
   - ACP adapter presence, version detection, and lightweight smoke readiness.
   - Rust runtime check only when Rust mode/runtime is enabled; report skipped when disabled and error/warn when enabled but unavailable according to the source plan.
   - Hub liveness and Hub root writability checks.
   - Registry consistency checks for missing/invalid project/job references.
   - Stale jobs, stale workers, and orphan/stale leases using existing TTL/constants and existing state file semantics.
   - Provider backoff/rate-limit readiness, including backoff-until/reason metadata after redaction.
   - Disk-space warnings using the existing warning threshold or the threshold specified by the source plan.
4. Ensure `runReadinessChecks` accepts dependency injection for tests where practical: command runner, clock, filesystem roots, adapter overrides, environment, and Hub root. Do not add injection surfaces that production code does not need.
5. Make `formatReadinessHuman` preserve the existing default user experience. Include grouped check status, actionable remediation for warnings/errors, and no raw secrets.
6. Make `formatReadinessJson` return a stable JSON object with at least: `command`, `generatedAt`, `summary`, and `checks`. Ensure every emitted value has passed through the redaction path and that JSON stdout has no ANSI codes or trailing human prose.
7. Wire `cpb doctor --json` to print only the JSON readiness result. Preserve existing default `cpb doctor` behavior when `--json` is absent, including exit status semantics unless the source plan explicitly changes them.
8. Wire `cpb report --json` to include the same readiness result or readiness section expected by the existing report command. Preserve current report behavior when `--json` is absent.
9. Add or adjust tests in the existing test style:
   - Missing ACP adapter produces a failing readiness check with remediation and redacted details.
   - Stale Hub state is reported without mutating Hub files.
   - Stale worker is reported using the configured TTL/clock.
   - Provider rate limit/backoff is reported with redacted reason/details.
   - Rust runtime unavailable is reported when Rust runtime is enabled, and skipped when Rust is disabled.
   - `doctor --json` and `report --json` emit parseable JSON with the expected summary/check fields and no ANSI escape codes.
   - Existing human output behavior remains covered so default output does not regress.
10. Run the project’s relevant readiness/CLI test suite, then the broader lint/type/test commands normally used for this repository. Capture exact commands and outcomes in `deliverable-026.md`.

**注意事项**:
- Keep this P0.1-only. Do not implement promotion readiness items outside `doctor`/`report` checks.
- Do not introduce new dependencies.
- Do not alter state files as part of readiness checks.
- Do not broaden redaction into unrelated logging behavior unless the readiness output uses that shared redaction path.
- Prefer extending existing checks and formatters over creating another readiness subsystem.
- If existing code already implements part of this checklist, verify it with tests and leave it structurally intact.
- If a command’s exit-status contract is unclear, preserve current behavior and document it in the deliverable.

### Evidence
- Read-only code intelligence found the current readiness implementation anchor at `server/services/readiness-checks.js`.
- Read-only code intelligence found no external references to `runReadinessChecks` or `formatReadinessHuman` from that file, so the executor should verify and complete command wiring for `cpb doctor` and `cpb report`.
- No terminal commands were executed during planning.

### Risks
- The source-of-truth plan may define exact status severity or thresholds that differ from current constants; use the plan over assumptions.
- CLI command files were not shell-inspected in this planning phase, so the executor must identify the exact command handlers before editing.
- Existing test helpers may lack injection points for filesystem, clock, command runner, or provider state; add the smallest production-safe seams needed for deterministic tests.
- JSON schema consumers may already exist. Preserve any current fields and add new fields compatibly where possible.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above. Read the source-of-truth plan first, patch only the readiness/doctor/report surfaces and focused tests, run verification, and write the implementation handoff to `wiki/projects/flow/outputs/deliverable-026.md`.

## Acceptance-Criteria
- [ ] `cpb doctor` still provides the existing human-readable readiness output by default.
- [ ] `cpb doctor --json` prints parseable JSON only, with no ANSI codes or human prose.
- [ ] `cpb report` preserves existing default behavior.
- [ ] `cpb report --json` includes the expanded readiness result in parseable JSON.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale/orphan leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime is skipped when disabled and reported as unavailable when enabled but missing or failing.
- [ ] Missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable scenarios have focused tests.
- [ ] All readiness output is redacted recursively; tests prove representative tokens, credentials, provider keys, and credential-bearing URLs are not emitted.
- [ ] Readiness checks do not mutate Hub, registry, job, worker, lease, or provider state.
- [ ] Existing behavior outside this P0.1 doctor/report slice is preserved.
- [ ] Relevant CLI/readiness tests pass, and broader lint/type/test verification is recorded in `deliverable-026.md`.
- [ ] Code style matches the existing project patterns and no new dependencies are added.
