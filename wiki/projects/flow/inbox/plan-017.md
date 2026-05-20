## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-017 / P0.1 promotion readiness doctor-report checks
- **Timestamp**: 2026-05-19

### Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth, but implement only P0.1.
- Keep the work limited to `cpb doctor` / readiness report behavior and its direct test coverage.
- Add `--json` output as a stable machine-readable report surface while preserving the existing human-readable output as the default.
- Model readiness checks as structured results with status, severity, message, details, and redacted diagnostic fields so human and JSON output come from the same data.
- Prefer deterministic dependency injection or existing test helpers for Hub, registry, adapter, provider, Rust, and disk checks so tests do not require real external services.
- Preserve existing behavior for commands and checks that are not part of P0.1.

### Rejected
- Broad CLI cleanup or doctor/report rewrites beyond P0.1 — explicitly out of scope.
- Changing fake/mock assets only to make tests pass — forbidden unless the fake itself is the product bug or the test coverage intentionally models the new readiness behavior.
- Adding new dependencies for command parsing, table formatting, redaction, semver, or disk checks — use existing project utilities or standard runtime APIs unless the repository already has a suitable dependency.
- Making JSON output a separate code path — risks divergent readiness results between human and machine output.
- Performing network-heavy smoke tests by default — readiness checks should be bounded, local, and deterministic unless an existing doctor check already performs a safe liveness probe.

### Scope

**目标**: Expand CodePatchbay promotion-readiness diagnostics for `cpb doctor` / readiness reporting so operators can see and automate launch blockers for local runtime prerequisites, ACP integration, Hub health, registry state, stale runtime records, provider rate limiting/backoff, disk space, Rust runtime availability, and secret-safe output.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use as the source of truth for P0.1 acceptance details; do not edit.
- CLI entrypoint for `cpb doctor` and any `cpb report` or readiness-report command modules — add `--json`, preserve default output, and wire new readiness checks.
- Existing doctor/readiness service modules — add or extend structured readiness checks for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing Hub/client/registry/job/worker/lease/provider helper modules — reuse current APIs for liveness, writability, state reads, and provider status instead of duplicating protocols.
- Existing test files for CLI doctor/report behavior — add coverage for human output preservation and JSON shape.
- New or existing readiness test files — add focused tests for missing ACP adapter, stale Hub state, stale worker, provider rate limit/backoff, and Rust unavailable when Rust mode is enabled.

**实现步骤**:
1. Read the promotion readiness plan and locate the exact P0.1 section. Extract only the P0.1 requirements into local implementation notes; ignore other P0/P1/P2 work.
2. Map the existing `cpb doctor` and report/readiness command flow. Identify the single readiness aggregation point, current output formatter, current exit-code policy, and available test harnesses.
3. Introduce or extend a structured readiness result type:
   - `id`: stable check identifier such as `node`, `npm`, `git`, `acp_adapter`, `hub_liveness`, `hub_writability`, `registry_consistency`, `stale_workers`, `provider_backoff`, `disk_space`, `rust_runtime`.
   - `status`: `pass`, `warn`, `fail`, or `skip`.
   - `severity`: existing project severity if one exists, otherwise use minimal `info`/`warning`/`error`.
   - `message`: concise human-readable summary.
   - `details`: JSON-safe structured diagnostics with secrets redacted.
   - `remediation`: optional short next action when a failure is actionable.
4. Implement `--json` for `cpb doctor` and any readiness report command covered by the existing command surface. JSON output must contain only the structured report, with no banners, spinners, ANSI control characters, stack traces, or unredacted paths/tokens beyond existing safe diagnostics.
5. Preserve the default human-readable output. It should include the new checks in a compact readable form, preserve existing wording where tests or users likely depend on it, and avoid printing secrets or raw provider credentials.
6. Add environment prerequisite checks:
   - Node present and version captured.
   - npm present and version captured.
   - Git present and version captured.
   - Each check reports `fail` when required and unavailable, `warn` only when the promotion plan says degraded operation is acceptable.
7. Add ACP adapter readiness:
   - Detect adapter presence using the existing adapter resolution path.
   - Capture adapter version when available.
   - Run a bounded smoke readiness check that proves the adapter can be invoked or initialized without doing real user work.
   - Missing adapter must produce a deterministic failure covered by tests.
8. Add Rust runtime readiness only when Rust is enabled by existing config or feature flags:
   - If Rust mode is disabled, report `skip` or omit according to existing doctor conventions.
   - If enabled and unavailable, report a clear failure.
   - If enabled and available, capture runtime/version details.
9. Add Hub readiness:
   - Liveness: verify the Hub can be reached or its local state can be loaded through existing APIs.
   - Writability: verify the configured Hub/state location can accept required writes without mutating durable user data unexpectedly; prefer a temporary probe or existing health endpoint.
   - Stale Hub: detect stale or unreachable Hub state and report `fail`/`warn` per the promotion plan.
10. Add registry consistency checks:
   - Verify registered projects/workspaces/providers reference existing or valid records.
   - Detect dangling, duplicate, malformed, or mutually inconsistent registry entries.
   - Keep the check read-only unless an existing doctor repair mode explicitly handles fixes.
11. Add stale runtime record checks:
   - Jobs: detect stale queued/running jobs using existing timestamps and timeout semantics.
   - Workers: detect stale workers, including the required stale-worker test case.
   - Leases: detect expired or orphaned leases.
   - Ensure thresholds come from existing constants/config where possible and are stable in tests through injected clocks.
12. Add provider backoff/rate-limit readiness:
   - Surface active provider backoff or rate-limit state as a warning or failure according to the promotion plan.
   - Include provider identity only in redacted/safe form.
   - Test the rate-limit/backoff case deterministically without calling a live provider.
13. Add disk-space warnings:
   - Check relevant workspace, Hub, cache, or registry paths used by CodePatchbay.
   - Warn below the threshold specified in the promotion plan or existing config.
   - Do not fail unless the plan explicitly defines a fail threshold.
14. Add central redaction:
   - Reuse an existing redaction helper if present.
   - Ensure JSON and human output redact tokens, API keys, auth headers, provider secrets, user credentials, and sensitive connection strings.
   - Add a focused test if no existing redaction coverage exercises doctor/report output.
15. Add/adjust tests:
   - Missing ACP adapter.
   - Stale Hub or stale Hub state.
   - Stale worker.
   - Provider rate limit/backoff.
   - Rust unavailable when Rust runtime is enabled.
   - `--json` output parses as JSON, has stable top-level shape, includes statuses, and contains no ANSI or unredacted secrets.
   - Existing default output behavior remains covered.
16. Run the narrow relevant tests first, then the broader project verification appropriate for this CLI slice. If tests reveal unrelated failures, document them in the deliverable and do not broaden implementation.
17. Self-review the diff for scope creep before handoff: only P0.1 code/tests/docs directly needed for doctor/report readiness should be changed.

**注意事项**:
- Keep all implementation behavior-compatible except for the intentional new readiness checks and `--json` output.
- Do not implement other promotion readiness plan items outside P0.1.
- Do not introduce automatic repair, cleanup, migration, registry mutation, worker killing, lease deletion, provider reset, or Hub restart behavior unless P0.1 explicitly requires it.
- Prefer existing project terminology for Hub, ACP adapter, registry, workers, jobs, leases, and providers.
- Keep smoke checks bounded with short timeouts and injectable dependencies.
- JSON schema should be stable enough for automation; avoid embedding localized prose as the only machine-readable signal.
- Use redaction before formatting, logging, or serializing readiness details.
- If the promotion plan contradicts this handoff, the promotion plan wins for P0.1.

### Evidence
- Planning-only phase; no terminal commands were executed by Codex Planner per constraint.
- No files outside `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/` were written by Codex Planner.
- Source task and required P0.1 scope were provided in the prompt; Claude must read the referenced promotion readiness plan before implementation.

### Risks
- The exact command/module filenames are not listed here because this phase was forbidden from executing terminal commands for repository inspection.
- Existing doctor/report tests may assert exact human-readable output; preserve old lines where practical and add new checks without unnecessary churn.
- Hub writability probes can accidentally mutate durable state if implemented carelessly; use temp/probe APIs or guaranteed cleanup.
- Smoke-testing the ACP adapter could become slow or side-effectful; keep it bounded and readiness-only.
- Provider backoff and stale runtime checks depend on clock semantics; inject or freeze time in tests to avoid flakiness.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, confirm the P0.1 details, then implement the scoped `cpb doctor` / readiness report expansion following the steps above. Run targeted tests plus the relevant broader verification, then write `deliverable-017.md` with changed files, verification evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` and the relevant readiness report command support `--json` with parseable JSON-only output.
- [ ] Existing default human-readable doctor/report output remains usable and does not regress unrelated behavior.
- [ ] Readiness report includes Node, npm, and Git availability/version checks.
- [ ] Readiness report includes ACP adapter presence, version when available, and bounded smoke readiness.
- [ ] Readiness report checks Rust runtime availability when Rust mode is enabled and skips or omits it consistently when disabled.
- [ ] Readiness report checks Hub liveness and Hub writability.
- [ ] Readiness report checks registry consistency without mutating registry state.
- [ ] Readiness report detects stale jobs, stale workers, and stale leases using existing timeout semantics.
- [ ] Readiness report surfaces active provider backoff/rate-limit state.
- [ ] Readiness report warns on low disk space for relevant CodePatchbay paths.
- [ ] Human and JSON outputs redact secrets, tokens, credentials, auth headers, provider keys, and sensitive connection strings.
- [ ] Tests cover missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled.
- [ ] Tests cover `--json` shape/parsing and redaction in readiness output.
- [ ] No unrelated cleanup, broad refactor, new dependency, or non-P0.1 promotion work is included.
- [ ] Relevant tests pass, and any unrelated pre-existing failures are clearly documented in `deliverable-017.md`.
