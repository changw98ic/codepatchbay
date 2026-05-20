# Plan: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand `cpb doctor`/`cpb report` readiness checks.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-023-P0.1-promotion-readiness-doctor-report
- **Timestamp**: 2026-05-19

### Decided
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` is the source of truth; implement only the P0.1 doctor/report readiness slice.
- Keep the readiness implementation centralized in `/Users/chengwen/dev/flow/server/services/readiness-checks.js`; do not create a second readiness engine.
- Expose the same readiness result to human output and `--json` output so `cpb doctor`, `cpb doctor --json`, `cpb report`, and `cpb report --json` cannot drift.
- Preserve existing behavior and exit semantics unless a failing readiness check already maps to a non-zero exit in the current command path.
- Use existing hub/runtime/registry/observability services where available: `/Users/chengwen/dev/flow/server/services/hub-runtime.js`, `/Users/chengwen/dev/flow/server/services/hub-registry.js`, `/Users/chengwen/dev/flow/server/services/runtime-cli.js`, `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.js`, and `/Users/chengwen/dev/flow/server/services/observability.js`.
- Add test seams through optional dependency injection on readiness helpers instead of shelling out in tests or mutating global process state unnecessarily.
- Redact secrets in both human and JSON readiness/report output before printing or returning diagnostics.

### Rejected
- Broad cleanup of CLI, hub, worker, registry, or provider code; this task is P0.1 only.
- New npm dependencies for command parsing, redaction, disk checks, or test helpers; use the standard library and existing project utilities.
- Changing fake/mock tests or fixtures merely to force green tests; update tests only when they directly cover P0.1 behavior or an existing fake no longer represents the real readiness workflow.
- Running destructive repair actions from `doctor`; this slice diagnoses readiness and reports remediation, it does not mutate hub state except for a temporary writability probe.
- Making Rust runtime mandatory when the Rust runtime feature/path is disabled; disabled runtime should be reported as `skipped`, enabled-but-unavailable should be `error`.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.1 scope.
- `/Users/chengwen/dev/flow/server/services/readiness-checks.js` — expand readiness checks, add JSON-safe/redacted result shape, and keep human formatting in sync.
- `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.js` — ensure `cpb report` includes the expanded readiness report and uses the redacted JSON formatter/result.
- `/Users/chengwen/dev/flow/server/services/observability.js` — reuse or tighten existing redaction only if `readiness-checks.js` cannot safely redact all P0.1 fields through existing helpers.
- `/Users/chengwen/dev/flow/server/services/hub-runtime.js` — use existing liveness metadata; change only if a small read-only status surface is missing for stale Hub detection.
- `/Users/chengwen/dev/flow/server/services/hub-registry.js` — use existing registry status/worker status; change only if consistency data needed by readiness is not currently exported.
- `/Users/chengwen/dev/flow/server/services/runtime-cli.js` — use existing Rust runtime binary resolution/version calls for enabled-runtime readiness; change only if readiness needs a small exported helper.
- Existing `cpb` CLI command entrypoint that currently implements `doctor`/`report` — wire `--json` to `formatReadinessJson` and keep existing human output as default.
- Existing server-side readiness/diagnostics tests, or new focused tests beside them such as `/Users/chengwen/dev/flow/server/services/readiness-checks.test.js` and `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.test.js` — cover P0.1 scenarios without unrelated fixture churn.

### Evidence
- Code index shows `/Users/chengwen/dev/flow/server/services/readiness-checks.js` already defines `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, and check categories for toolchain, disk, ACP, runtime, hub, registry, jobs, workers, leases, and provider.
- Code index shows `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.js` owns diagnostics/report gathering.
- Code index shows `/Users/chengwen/dev/flow/server/services/hub-runtime.js` exposes `readHubLiveness`.
- Code index shows `/Users/chengwen/dev/flow/server/services/hub-registry.js` exposes registry/project/worker status functions.
- Code index shows `/Users/chengwen/dev/flow/server/services/observability.js` tracks worker status and provider `rateLimitedUntil`.
- No terminal commands were executed in this planning phase.

### Risks
- The exact `cpb` CLI entrypoint path was not read during planning because this phase forbids terminal commands; locate it by source inspection before editing and keep the command wiring minimal.
- Some readiness checks may already exist partially; prefer completing and testing the current implementation over rewriting it.
- Disk-space checks can be platform-sensitive; tests should inject filesystem stats instead of relying on the host.
- ACP adapter smoke checks must be non-invasive and bounded by timeout; avoid starting real long-running sessions.
- Redaction tests must include representative secret-bearing fields to prevent `--json` from leaking tokens, authorization headers, API keys, or provider credentials.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for promotion readiness P0.1 only, including parseable `--json`, required environment/runtime/hub/provider checks, redaction, and focused tests for the specified failure scenarios.

**实现步骤**:
1. Read the P0.1 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and compare it against the current `server/services/readiness-checks.js` exported checks. Record only P0.1 gaps in the implementation notes or deliverable; do not implement later P0/P1 items.
2. In `server/services/readiness-checks.js`, normalize the readiness result schema so every check returns `{ id, category, status, title, details, remediation, metadata }`, with `status` limited to `ok`, `warn`, `error`, and `skipped`; ensure `summary` includes total counts and an overall status derived from errors first, then warnings.
3. Complete toolchain checks for Node, npm, and Git:
   - Node reports current version and errors below the project minimum.
   - npm and Git run bounded version probes through `execFile` without shell interpolation.
   - Missing binaries produce `error` with remediation; version output is trimmed and redacted.
4. Complete ACP adapter readiness:
   - Detect configured/default ACP adapter path or command.
   - Report adapter presence, version, and smoke readiness with a bounded non-invasive probe.
   - Missing adapter is an `error`; failed smoke is an `error` or `warn` only if the source plan says smoke is optional.
5. Complete Rust runtime readiness:
   - If Rust runtime is disabled by current config/env, return `skipped` with reason.
   - If enabled, verify runtime binary presence and a bounded version/smoke command using existing `runtime-cli` helpers when possible.
   - Enabled-but-unavailable runtime is an `error` with remediation.
6. Complete Hub checks:
   - Liveness uses `readHubLiveness` or equivalent existing metadata and reports stale/missing/dead Hub as `warn` or `error` according to current semantics.
   - Writability creates and removes a temporary probe file under the Hub root without modifying registry or queue data.
   - JSON output includes redacted `hubRoot`, liveness state, pid/started metadata if already exposed, and probe result.
7. Complete registry consistency checks:
   - Load/normalize registry through `hub-registry` helpers.
   - Warn/error on malformed registry, unsupported/missing version, duplicate project ids, missing required project fields, missing source/project paths, or inconsistent enabled project counts.
   - Do not rewrite or repair the registry in this task.
8. Complete stale jobs, workers, and leases checks:
   - Identify stale running/claimed jobs from existing Hub queue data using existing timestamps/status fields.
   - Identify stale workers from `hubStatus`/worker heartbeat metadata and current TTL constants.
   - Identify orphan/stale leases using the existing lease manager data shape; report count and sample ids only.
   - Keep samples capped and redacted so large hubs do not produce noisy output.
9. Complete provider backoff and disk-space checks:
   - Provider backoff reads existing observability/provider state and warns when any provider is currently rate-limited/backed off, including `until` and redacted reason.
   - Disk-space check uses filesystem stats for the relevant root and warns below the existing threshold; tests must inject low-space stats.
10. Wire `--json` into the existing `cpb doctor` and `cpb report` command path:
   - Default output remains human-readable.
   - `--json` writes only valid JSON to stdout, with no color codes, banners, progress lines, stack traces, or unredacted secrets.
   - Both command paths use the same `runReadinessChecks` result and formatter.
11. Update diagnostics/report integration in `server/services/diagnostics-bundle.js`:
   - Include expanded readiness results in the diagnostic bundle/report.
   - Ensure report JSON uses the same redaction path as doctor JSON.
   - Preserve existing report fields and ordering unless required for P0.1.
12. Add or adjust focused tests:
   - Missing ACP adapter produces an `error` check and valid redacted JSON.
   - Stale Hub liveness produces the expected warning/error without attempting repair.
   - Stale worker heartbeat is counted and sampled.
   - Provider rate limit/backoff produces a warning with `rateLimitedUntil`.
   - Rust runtime enabled but unavailable produces an `error`; disabled runtime produces `skipped`.
   - `--json` formatter output parses as JSON and contains no ANSI codes or representative secrets.
13. Run the project’s relevant verification commands after implementation and include exact command output in `deliverable-023.md`: targeted readiness tests first, then the repository’s normal lint/type/test command set if available.

**注意事项**:
- Keep changes scoped to P0.1 readiness/report behavior.
- Do not broaden into unrelated cleanup, dashboard changes, worker execution changes, registry repair commands, or new dependencies.
- Preserve existing check ids if they already exist; add new ids only for missing P0.1 checks.
- Use short, actionable remediation text; do not print secret values in details or remediation.
- Avoid shell string commands for version/smoke probes; use argument arrays and timeouts.
- Tests should isolate temp Hub roots and injected dependencies so they are deterministic and do not depend on the developer machine.

## Next-Action
Implement the scoped P0.1 changes above, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-023.md` with changed files, test evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` still produces human-readable readiness output with existing behavior preserved.
- [ ] `cpb doctor --json` prints valid JSON only, with no ANSI codes or extra text.
- [ ] `cpb report --json` includes the expanded readiness report using the same redacted check schema as doctor JSON.
- [ ] Readiness covers Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is covered by a test and reports an `error` with remediation.
- [ ] Stale Hub liveness is covered by a test and reports the expected non-ok status without repair side effects.
- [ ] Stale worker heartbeat is covered by a test and reports worker count/sample data.
- [ ] Provider rate limit/backoff is covered by a test and reports a `warn` status with redacted details.
- [ ] Rust runtime enabled but unavailable is covered by a test and reports an `error`; disabled runtime reports `skipped`.
- [ ] JSON/human output redacts representative secrets including API keys, bearer tokens, authorization headers, and provider credential values.
- [ ] Tests do not require real npm/Git/ACP/Rust binaries for failure scenarios; they use injected probes or temp fixtures.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup or non-P0.1 behavior changes are included.
- [ ] Verification evidence is captured in `deliverable-023.md`, including exact commands and outputs.
