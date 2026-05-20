# Plan 084 - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-084 / P0.1 cpb doctor/report readiness checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative source. Before editing, read its P0.1 section and follow it over this handoff if there is a discrepancy.
- Keep the implementation limited to `cpb doctor` and `cpb report` readiness behavior, plus directly related tests. Do not refactor unrelated CLI, Hub, registry, provider, or runtime code.
- Build one shared readiness collector/report model and have both `doctor` and `report` consume it, so JSON and human output do not diverge.
- Add `--json` support for readiness output. JSON output must be machine-parseable, deterministic enough for tests, free of ANSI/progress text, and redacted before writing to stdout.
- Preserve existing human-readable behavior and exit-code conventions where they already exist. New checks may add diagnostics, but must not remove or rename existing user-facing checks unless the source-of-truth plan explicitly requires it.
- Use existing project utilities, constants, command registration patterns, test helpers, and fixtures. Do not add dependencies for semver, disk stats, redaction, process spawning, or JSON validation unless the repo already depends on them.
- Classify readiness findings as `pass`, `warn`, `fail`, or `skip`. `fail` blocks readiness; `warn` surfaces degraded state such as active provider backoff or low-but-not-critical disk; `skip` is for disabled optional runtimes such as Rust when not enabled.
- Apply a single redaction pass to every string and structured detail emitted by `doctor` and `report`, including JSON. Redact tokens, API keys, auth headers, credentials in URLs, provider secrets, and sensitive env/config values.

### Rejected
- Rejected broad cleanup of command parsing, registry storage, Hub lifecycle, worker cleanup, or provider retry logic because P0.1 asks only to report readiness.
- Rejected separate doctor/report implementations because duplicated readiness logic will drift and makes JSON contract tests weaker.
- Rejected live destructive smoke checks because readiness must be safe to run repeatedly; smoke checks should be read-only or use temporary files that are cleaned up.
- Rejected snapshot-only coverage because the required regressions need focused assertions for status, remediation, redaction, and exit behavior.

### Scope

**目标**: Implement P0.1 from the promotion readiness must-haves plan by expanding `cpb doctor` and `cpb report` readiness checks, adding JSON output, and covering the required failure/degraded scenarios without broadening into unrelated cleanup.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the P0.1 details.
- Existing `cpb doctor` command implementation file — add/use shared readiness collection, human output rendering, `--json`, and exit handling.
- Existing `cpb report` command implementation file — add/use shared readiness collection and `--json` output without changing unrelated report content.
- Existing CLI option/parser registration for `doctor` and `report` — register `--json` consistently with current command style.
- Existing Hub client/state utilities — read Hub health/heartbeat and perform a safe writability probe through existing paths.
- Existing registry utilities — validate registry parseability, schema/version compatibility, duplicate IDs, and referential consistency.
- Existing provider/backoff state utilities — surface active rate limit/backoff state without changing retry behavior.
- Existing worker/job/lease state utilities — detect stale jobs, workers, and leases using existing TTL/heartbeat constants where available.
- Existing ACP adapter configuration/resolution utilities — check adapter presence, version, and read-only smoke readiness.
- Existing Rust runtime enablement/resolution utilities — only check Rust runtime when enabled; otherwise report `skip`.
- Existing test files for CLI doctor/report/readiness behavior, or new colocated tests following current naming conventions — add required regression coverage.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and inspect the current `cpb doctor`, `cpb report`, Hub, registry, provider, worker, ACP adapter, Rust runtime, and test patterns. Record any source-of-truth nuance in the deliverable.
2. Define or extend the shared readiness data model with stable fields: overall status, generated timestamp, command/source metadata, and an ordered `checks` array. Each check should include at minimum `id`, `status`, `severity`, `summary`, optional `details`, and optional `remediation`.
3. Add a shared readiness collector that runs these checks in a bounded, timeout-aware way:
   - Node and npm availability/version, including Node engine compatibility if the repo already declares it.
   - Git availability/version and basic repository readiness using existing shell/process helpers.
   - ACP adapter presence, version, and read-only smoke readiness through the configured adapter path/package.
   - Rust runtime availability/version/smoke only when Rust support is enabled; otherwise emit `skip`.
   - Hub liveness and writability, including stale heartbeat detection and a temporary write/delete probe.
   - Registry consistency: parseable registry files, expected schema/version, duplicate IDs, unresolved references, and adapter/provider references that cannot be resolved.
   - Stale jobs, workers, and leases based on existing heartbeat/TTL/lease expiry rules.
   - Provider backoff/rate-limit state, including retry timing and whether at least one usable provider remains.
   - Disk-space warnings using existing filesystem APIs or Node built-ins, with warning/critical thresholds matching the source-of-truth plan or existing config.
4. Implement redaction as a reusable boundary function applied to both human and JSON output. It must recursively sanitize strings, arrays, objects, errors, URLs, command output, and remediation/detail fields before rendering.
5. Wire `cpb doctor --json` to emit only the readiness JSON object to stdout. Keep human `cpb doctor` output compatible with existing behavior while adding the new checks in a readable order.
6. Wire `cpb report --json` to include the same readiness model in the report JSON. If `report` already has a JSON schema, extend it additively; if it does not, make the output explicit and testable without mixing human text into stdout.
7. Preserve exit behavior:
   - Any `fail` readiness check makes `doctor` fail according to existing doctor conventions.
   - Warning-only results remain non-fatal unless the source-of-truth plan says otherwise.
   - `report` should keep its existing success/failure semantics while exposing readiness status in JSON.
8. Add or adjust tests for the required scenarios using existing test helpers and fake state:
   - Missing ACP adapter produces a failed adapter readiness check and actionable remediation.
   - Stale Hub produces a failed Hub liveness/readiness check.
   - Stale worker produces the expected stale worker/job/lease readiness warning or failure per the source-of-truth thresholds.
   - Provider rate limit/backoff produces a provider readiness warning, includes retry timing, and does not leak secrets.
   - Rust runtime unavailable while Rust is enabled produces a failed Rust readiness check; Rust disabled produces `skip`.
9. Add focused tests for `--json` parseability and redaction. Assert no ANSI/progress text appears in JSON stdout and sensitive sample values are replaced consistently.
10. Run the relevant unit/CLI test suite and any project-required lint/typecheck commands. If the full suite is too expensive or blocked, run the narrow readiness/CLI tests and document the gap in the deliverable.

**注意事项**:
- Keep all edits scoped to P0.1 readiness/reporting and its tests. Do not fix unrelated flaky tests, rename existing commands, or rework Hub lifecycle behavior.
- Avoid changing fake/mock assets just to force tests green. If an existing fake no longer represents the real workflow, add a purpose-built readiness fixture/helper and explain the mismatch.
- Use existing timeout/process execution helpers so readiness checks cannot hang on adapter, npm, git, Rust, or Hub probes.
- Do not print raw command output or exception messages until after redaction.
- Make JSON status ordering stable for tests: prefer a fixed check order over object iteration order.
- Include remediation text only where it is concrete, for example install/configure the ACP adapter, start/repair Hub, clear stale worker state with the existing supported command, wait for provider backoff, free disk, or install/disable Rust runtime.
- If the source-of-truth plan defines exact thresholds, check IDs, or JSON field names, use those exact values.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`
- Existing `cpb doctor` command file
- Existing `cpb report` command file
- Existing CLI command registration/parser file
- Existing readiness/Hub/registry/provider/worker/adapter/runtime utilities touched by the minimal implementation
- Existing or new colocated doctor/report/readiness tests

### Evidence
- Planning-only handoff. No terminal commands were run in this phase by Codex because the task explicitly forbids terminal execution.
- The required implementation scope is the user-provided P0.1 directive and the referenced promotion readiness plan path.

### Risks
- The exact file paths for CLI commands and utilities must be discovered by the executor before editing; keep the diff in the existing ownership boundaries.
- Adapter and Rust smoke checks may have platform-specific behavior. Use existing abstractions and timeouts, and make tests mock those boundaries.
- Disk-space APIs can differ by Node version. Prefer existing utilities or guarded built-ins with a clear `warn`/`skip` fallback if the source-of-truth plan allows it.
- Redaction can be under-applied if rendering bypasses the shared reporter. Route all details through the same redaction/rendering path.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 as described above, run the relevant tests/lint/typecheck, and then write `deliverable-084.md` with changed files, verification output, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` reports readiness for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit, and disk-space warnings.
- [ ] `cpb doctor --json` writes valid JSON only, with no ANSI/progress/human text on stdout, and includes an overall status plus ordered per-check results.
- [ ] `cpb report` includes the expanded readiness checks in its existing report flow without removing existing report behavior.
- [ ] `cpb report --json` exposes the readiness model in parseable JSON and preserves any existing report JSON fields additively.
- [ ] JSON and human output are redacted for tokens, API keys, auth headers, credentials in URLs, provider secrets, sensitive env/config values, and raw error/command output containing secrets.
- [ ] Missing ACP adapter is covered by a test and produces a failed adapter readiness check with remediation.
- [ ] Stale Hub is covered by a test and produces a failed Hub liveness/readiness check.
- [ ] Stale worker is covered by a test and produces the source-of-truth expected warning/failure for stale worker/job/lease state.
- [ ] Provider rate limit/backoff is covered by a test and produces a readiness warning with retry timing and no leaked secrets.
- [ ] Rust runtime unavailable while enabled is covered by a test and produces a failed Rust readiness check; Rust disabled is skipped.
- [ ] Warning-only readiness results do not become fatal unless the existing command behavior or source-of-truth plan requires it.
- [ ] Existing non-JSON command output and exit behavior are preserved except for additive readiness diagnostics.
- [ ] All added checks use existing project utilities/patterns and introduce no new dependency.
- [ ] Relevant readiness/CLI tests pass, and any skipped broader verification is explicitly documented in `deliverable-084.md`.
