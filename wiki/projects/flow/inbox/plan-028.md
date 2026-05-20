# Plan 028 - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1: expand cpb doctor/report readiness checks with --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and targeted tests

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-028-P0.1-promotion-readiness-doctor-report
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` is the source of truth; implement only the P0.1 doctor/report readiness slice from that plan.
- Keep the implementation centered on the existing readiness-check surface in `server/services/readiness-checks.js`, which already exposes `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Preserve existing human doctor/report behavior while adding complete structured `--json` output for automation; JSON output must be pure JSON on stdout with no ANSI color, prose, or secrets.
- Use existing project patterns and dependency-injection seams for filesystem, subprocess, clock, and state inputs; do not add new dependencies.
- Treat failed readiness checks as structured check objects with stable IDs, category, status, human message, machine-readable details, and remediation.
- Apply redaction before any human or JSON report output so adapter paths, environment values, provider state, logs, and diagnostics cannot leak tokens, keys, session IDs, or authorization material.

### Rejected
- Implementing P0.2/P1/P2 items from the promotion plan | The task explicitly limits this handoff to P0.1.
- Broad CLI/report cleanup or command restructuring | Scope must stay small and preserve existing behavior.
- Replacing the readiness model with a new diagnostics framework | Existing `server/services/readiness-checks.js` already contains the right surface.
- Adding third-party packages for semver, disk checks, JSON formatting, or redaction | The task does not authorize new dependencies.
- Editing fake/mock assets merely to make tests pass | Only update tests or test doubles when they directly express the intended P0.1 behavior.

### Scope

**目标**: Expand `cpb doctor` and report readiness checks according to P0.1 of the promotion readiness plan, with scoped production changes and targeted tests for the required failure/readiness scenarios.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - Read-only source of truth; confirm exact P0.1 wording before editing.
- `server/services/readiness-checks.js` - Add or complete readiness checks, stable check IDs, summary derivation, JSON formatter behavior, redaction entry points, and injected test seams.
- `server/services/diagnostics-bundle.js` - Include the expanded readiness report wherever `cpb report` gathers diagnostics, without changing unrelated diagnostics content.
- `server/services/observability.js` - Reuse or extend existing redaction helpers so readiness output and diagnostics bundles share secret-safe formatting.
- Existing `cpb` CLI entry file referenced by `package.json`'s `bin` configuration - Wire `doctor --json` and report JSON output to `formatReadinessJson`; preserve existing non-JSON command text and exit-code semantics except where errors are now detected.
- Existing readiness/diagnostics/CLI test files under the repo test tree - Add targeted coverage beside the current tests; if no readiness-specific test file exists, create `server/services/readiness-checks.test.js` following the repo's current test runner conventions.

**实现步骤**:
1. Read the promotion readiness plan and extract only P0.1 acceptance requirements. Write a local implementation checklist from that text before editing; do not include P0.2, P1, or cleanup work.
2. Map the current `cpb doctor` and `cpb report` flow from the `package.json` bin entry through the readiness/diagnostics services. Confirm which command currently calls `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, or equivalent report helpers.
3. Normalize the readiness result contract in `server/services/readiness-checks.js`: every check must return `{ id, category, status, title/message, details, remediation }`, `summary` must count `ok`, `warn`, `error`, and `skipped`, and `generatedAt` must use an injectable clock for deterministic tests.
4. Implement or complete toolchain checks for Node, npm, and Git. Capture version strings, timeout/failure reasons, and remediation. Keep existing minimum Node policy if already present; otherwise use the project requirement from the promotion readiness plan or package metadata.
5. Implement or complete ACP adapter checks. Verify adapter presence, version command success, and a safe smoke-readiness probe for each required adapter. Missing adapter must be an `error`; version/smoke failures must include redacted command/error details and remediation.
6. Implement Rust runtime readiness only when Rust runtime support is enabled by the existing config/env flag. If disabled, emit `skipped`; if enabled and unavailable or failing version/smoke readiness, emit `error` with remediation.
7. Implement Hub and state checks: Hub liveness, Hub writability through a safe create/remove temp marker, registry consistency between project registry and Hub state, stale jobs, stale workers, orphan/stale leases, and provider backoff/rate-limit state. Use existing TTL constants or the promotion plan values; avoid mutating real job/worker/lease state except for the temporary writability marker.
8. Implement disk-space warnings using the existing warning threshold when present. Low free space should be `warn`, not `error`, unless the promotion plan explicitly requires a hard failure.
9. Wire `--json` for `cpb doctor` and report readiness output. JSON mode must produce parseable JSON only, include all check details and summary counts, and use the same check statuses as human mode. Human mode must remain stable aside from the new checks and remediation lines.
10. Apply redaction at the final output boundary and within details built from subprocess errors, env/config, provider state, Hub paths, and logs. Add regression assertions that sensitive-looking values are replaced before both JSON and human output are returned.
11. Add/adjust tests using temp directories, fake clocks, and injected subprocess results. Required cases: missing ACP adapter, stale Hub state, stale worker, provider rate limit/backoff, Rust runtime enabled but unavailable. Also cover JSON parseability/shape, Hub writability failure, registry inconsistency, stale job or stale lease, disk-space warning, and redaction of secret-like values.
12. Run the project verification commands after implementation: the focused readiness/CLI tests first, then the broader test suite/lint/typecheck commands used by this repo. If a broad command is too slow or unavailable, record the exact focused command output and the blocker in the deliverable.

**注意事项**:
- Keep changes scoped to P0.1; do not refactor unrelated doctor/report code or change worker/job behavior outside readiness inspection.
- Do not edit generated worktrees under `cpb-task/worktrees/`; implement against the root project files.
- Do not make readiness checks destructive. The Hub writability check may create and remove one uniquely named temp marker only.
- Do not expose secrets in command output, JSON details, logs, thrown errors, or test snapshots.
- Preserve existing behavior for success paths and existing report fields unless the P0.1 source-of-truth plan explicitly says otherwise.
- Prefer stable check IDs such as `toolchain.node`, `toolchain.npm`, `toolchain.git`, `acp.adapter.codex`, `acp.adapter.claude`, `runtime.rust`, `hub.liveness`, `hub.writability`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, and `disk.free`.

### Evidence
- Planning only; no terminal commands were executed.
- Non-shell code-intel showed current root symbols in `server/services/readiness-checks.js`: `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, `checkNode`, `checkNpm`, `checkGit`, `checkAcpAdapter`, `checkRustRuntime`, `checkHubLiveness`, `checkHubWritability`, `checkRegistryConsistency`, `checkStaleJobs`, `checkOrphanLeases`, `checkStaleWorkers`, `checkProviderBackoff`, and `checkDiskSpace`.
- Non-shell code-intel showed related diagnostics/redaction surfaces in `server/services/diagnostics-bundle.js` and `server/services/observability.js`.

### Risks
- CLI entrypoint and test file names were not shell-inspected during this planning-only phase; resolve exact existing paths before editing.
- The promotion readiness plan may define stricter thresholds or check statuses than inferred here; its P0.1 wording overrides this handoff where they differ.
- JSON output may already exist partially; preserve existing keys that consumers depend on while adding missing P0.1 fields.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, confirm the P0.1 requirements, implement the scoped doctor/report readiness changes above, run focused and repo-standard verification, then write `deliverable-028.md` with changed files, evidence, and known risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits pure parseable JSON with generated timestamp, summary counts, and every P0.1 readiness check result.
- [ ] Non-JSON `cpb doctor` and existing report output preserve current behavior while adding the new P0.1 readiness checks and remediation messages.
- [ ] Node, npm, and Git readiness checks report versions or actionable failures.
- [ ] ACP adapter readiness covers presence, version, and safe smoke readiness; missing adapter is tested and reported as an error.
- [ ] Rust runtime readiness is checked only when enabled; enabled-but-unavailable Rust runtime is tested and reported as an error, while disabled Rust runtime is skipped.
- [ ] Hub liveness and writability are checked without destructive state changes; stale Hub state is tested.
- [ ] Registry consistency, stale jobs, stale workers, and stale/orphan leases are checked with stable statuses and remediation; stale worker is tested.
- [ ] Provider backoff/rate-limit state is surfaced as readiness warning/error according to the source plan; rate-limit/backoff behavior is tested.
- [ ] Disk-space warning is emitted below the configured threshold without failing healthy environments.
- [ ] Human and JSON readiness outputs redact secret-like values, tokens, authorization data, and sensitive subprocess/config details.
- [ ] Focused tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, JSON output shape, redaction, and at least one stale job or lease case.
- [ ] Existing tests still pass; any unrun verification is explicitly documented with the reason in `deliverable-028.md`.
- [ ] No unrelated cleanup, dependency additions, generated-worktree edits, or non-P0.1 behavior changes are included.
