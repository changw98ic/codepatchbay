## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-036
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan Title
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand `cpb doctor`/`cpb report` readiness checks, including `--json` output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for P0.1. If it conflicts with this handoff, follow the source plan for P0.1 only and do not implement other P0/P1/P2 items.
- Build on the existing readiness surface in `server/services/readiness-checks.js`; the code index shows `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson` already live there.
- Reuse existing Hub/runtime helpers in `server/services/runtime-cli.js` and `server/services/hub-registry.js` for Rust runtime gating, registry state, worker status, queue/job state, leases, and provider rate-limit/backoff state.
- Keep the default human output and exit-code semantics compatible with current `cpb doctor` and `cpb report`; add `--json` as an additive output mode.
- Make all readiness output redacted by default, including JSON, human text, and report bundles. Prefer the existing redaction helpers in `server/services/diagnostics-bundle.js` and `server/services/observability.js` before adding new redaction code.

### Rejected
- Rewriting the CLI command framework or report pipeline; P0.1 is a readiness expansion, not a CLI redesign.
- Adding new dependencies for command execution, disk inspection, schema validation, or redaction; use Node built-ins and existing project helpers.
- Broad cleanup of Hub, registry, queue, worker, or runtime internals; touch those files only where a small helper export is necessary for readiness checks.
- Editing fake/mock responders, snapshots, fixtures, or unrelated test doubles just to make tests pass. Add purpose-built tests for the P0.1 scenarios instead.
- Making Rust checks mandatory for JavaScript-only deployments. Rust runtime readiness is checked only when the existing runtime selection says Rust is enabled.

### Scope

**目标**: Implement P0.1 readiness checks for `cpb doctor` and `cpb report`, with scoped code changes, structured `--json` output, redacted diagnostics, and focused tests for the requested failure/degraded states.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first; source-of-truth for the exact P0.1 boundaries.
- `server/services/readiness-checks.js` - central readiness check collection, check result model, human formatter, JSON formatter, redaction, disk/toolchain/adapter/runtime/Hub/registry/job/worker/lease/provider checks.
- `server/services/diagnostics-bundle.js` - include or verify readiness report data in `cpb report`, and ensure bundle-level redaction covers readiness details.
- `server/services/runtime-cli.js` - reuse existing `shouldUseRustRuntime`, `resolveRuntimeBin`, `getRuntimeBackend`, queue/job/lease/rate-limit helpers; export only minimal helper data if current exports are insufficient.
- `server/services/hub-registry.js` - reuse `resolveHubRoot`, `loadRegistry`, `hubStatus`, `workerStatus`, and TTL constants; avoid schema migrations.
- `server/services/observability.js` - reuse redaction behavior if readiness output needs shared secret masking.
- Existing CLI entrypoint that owns `cpb doctor` and `cpb report` argument parsing - wire `--json` to the readiness/report formatter without changing unrelated commands.
- Existing test files for readiness/diagnostics/CLI behavior, or a new colocated readiness test file following the current test runner pattern - add the five required scenarios plus JSON/redaction assertions.

**实现步骤**:
1. Read the promotion readiness plan and identify only the P0.1 bullets. Then inspect the current `cpb doctor`/`cpb report` command wiring and the exports from `server/services/readiness-checks.js`; do not begin P0.2 or unrelated cleanup.
2. Normalize the readiness result contract in `server/services/readiness-checks.js`: each check should expose a stable `id`, `category`, `status` (`ok`, `warn`, `error`, `skipped`), `message`, redacted `details`, and optional `remediation`. The top-level JSON should include `command`, `generatedAt`, `summary`, and `checks`.
3. Complete the toolchain checks: Node version, npm presence/version, and Git presence/version. Node should use the current process version where possible; npm/Git should use the existing subprocess helper with the current timeout and produce actionable remediation on failure.
4. Complete ACP adapter readiness: detect configured Codex/Claude ACP adapters through existing config/env conventions, report presence, version, and smoke readiness, and keep failures scoped to the adapter check. A missing required adapter must be an `error`; a version/smoke problem should be `error` when the adapter cannot run and `warn` when only metadata is unavailable.
5. Complete runtime and Hub checks: gate Rust runtime checks through `shouldUseRustRuntime`; when enabled, validate the resolved runtime binary/backend and report unavailable Rust runtime as `error`. Check Hub liveness and writability using a non-destructive temp marker/write path under the Hub root, and always clean up temporary readiness files.
6. Complete state consistency checks: validate registry shape/version/projects, duplicate or invalid project IDs, missing project roots/source paths, stale registry locks, stale jobs, stale workers, and orphan/expired leases. Use existing TTL constants and queue/registry helpers; report stale workers and active stale leases as `warn` unless current behavior already treats them as hard failures.
7. Complete provider/disk checks: report active provider backoff or rate-limit state with provider name, redacted reason, and `until` timestamp; warn on low disk space using the existing threshold constant. Do not expose absolute secret-bearing paths or tokens in details.
8. Wire output modes: `cpb doctor` keeps the existing human output by default and emits JSON only for `--json` with no ANSI color or extra prose. `cpb report` must include the same readiness object in its structured output and keep existing report fields intact.
9. Add focused tests using dependency injection/stubs rather than real system mutation. Required scenarios: missing adapter, stale Hub/liveness or unwritable Hub, stale worker, active provider rate limit/backoff, and Rust runtime unavailable when Rust is enabled. Also add/adjust tests for `--json` parseability and secret redaction in both doctor/report output.
10. Run the smallest targeted readiness/diagnostics tests first, then the project’s existing relevant test suite. If a broader suite fails for unrelated pre-existing reasons, capture the exact failing command/output in the deliverable and keep P0.1 changes clean.

**注意事项**:
- Preserve existing behavior: default human output remains readable, existing report fields remain present, and warning-only states should not unexpectedly change command failure behavior unless current code already does that.
- Keep changes scoped to P0.1. Do not implement promotion items outside doctor/report readiness.
- Use existing helper patterns before adding new abstractions. Add a small helper only when it removes duplicated readiness logic or enables deterministic tests.
- Redact before formatting, not after string concatenation. JSON consumers must never receive raw secrets that are merely hidden in human output.
- Do not run destructive Hub or registry repair from doctor/report. These commands diagnose readiness; they do not mutate real state except for a temporary Hub writability probe that is removed immediately.

### Evidence
- Planning-only phase: Codex did not execute terminal commands.
- Non-terminal code-index lookup found `server/services/readiness-checks.js` with `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, and existing check symbols for Node, npm, Git, disk, ACP adapter, Rust runtime, Hub liveness/writability, registry consistency, stale jobs, orphan leases, stale workers, and provider backoff.
- Non-terminal code-index lookup found supporting symbols in `server/services/runtime-cli.js`, `server/services/hub-registry.js`, `server/services/diagnostics-bundle.js`, and `server/services/observability.js`.

### Risks
- The current implementation may already contain partial P0.1 work; avoid duplicating checks and instead close only observable gaps against the source plan.
- CLI wiring paths were not confirmed in this planning phase; locate the existing `cpb doctor` and `cpb report` parser before editing and keep argument changes minimal.
- Hub writability probes can create noise if cleanup is incomplete; use a unique readiness temp filename and remove it in `finally`.
- Rate-limit/backoff semantics may differ between runtime backends; rely on existing runtime helpers and test both enabled/unavailable paths where the project already supports them.

## Next-Action
Implement only P0.1 according to this plan. Read the source promotion plan first, make the scoped code/test changes, run targeted and relevant existing tests, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-036.md` with changed files, verification evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` still supports the existing human output path and now supports `--json` that emits parseable JSON only, with top-level `command`, `generatedAt`, `summary`, and `checks`.
- [ ] `cpb report` includes the same readiness data in structured output without removing existing report fields.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff or rate-limit state, and disk-space warnings.
- [ ] All readiness details are redacted in JSON, human output, and report bundles; tests prove representative token/API-key/secret values are not emitted.
- [ ] Missing required ACP adapter is reported as an `error` with remediation.
- [ ] Stale Hub liveness or unwritable Hub is reported with the correct degraded/error status and remediation.
- [ ] Stale worker state is detected using the existing worker TTL semantics.
- [ ] Active provider rate limit/backoff is detected and includes a safe provider name and until timestamp.
- [ ] Rust runtime unavailable is reported only when Rust runtime is enabled; JavaScript-only runtime remains skipped/ok according to existing semantics.
- [ ] Focused tests for missing adapter, stale Hub, stale worker, rate limit/backoff, Rust unavailable, `--json` parseability, and redaction pass.
- [ ] No unrelated cleanup, dependency additions, broad rewrites, fake responder changes, or behavior changes outside P0.1 are included.
