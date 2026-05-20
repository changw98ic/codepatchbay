## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-071
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan 071: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Keep `cpb doctor` and `cpb report` behavior backward compatible: existing human output remains valid, with new readiness checks appended or integrated without removing current signals.
- Add `--json` output for both doctor and report through the existing CLI option pattern; the JSON and human output must be rendered from the same readiness result model.
- Use a bounded readiness check model with stable check IDs, status values, severity, concise message, redacted details, and remediation text.
- Read provider backoff/rate-limit state from local CPB state only; do not call remote providers merely to test rate limits.
- Check the Rust runtime only when the existing config/env/runtime mode says Rust is enabled; Rust unavailable must not fail readiness when Rust is disabled.
- Redaction applies to both human and JSON output before rendering, including adapter command details, provider state, env/config values, logs, Hub metadata, and registry diagnostics.

### Rejected
- Implementing other promotion-readiness P0/P1 items in the same change | violates the requested P0.1-only scope.
- Rewriting doctor/report around a new framework | too broad and risks changing existing behavior.
- Adding new dependencies for command discovery, disk-space checks, or redaction | this slice can use existing project utilities and Node standard library APIs.
- Performing live provider calls for rate-limit detection | readiness should be deterministic, cheap, and safe offline.
- Making Rust mandatory globally | the task says Rust runtime when enabled.
- Editing mocks, fakes, snapshots, or fixtures only to mask behavior changes | tests must represent the intended real readiness workflow.

### Scope

**目标**: Expand CPB promotion-readiness diagnostics for `cpb doctor` and `cpb report` with JSON output and scoped P0.1 checks: Node/npm, Git, ACP adapter presence/version/smoke readiness, optional Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction. Add or adjust focused tests for missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.1 boundaries.
- Existing `cpb doctor` command implementation — add `--json`, invoke expanded readiness checks, preserve human output.
- Existing `cpb report` command implementation — add `--json` or include readiness JSON consistently with the existing report option model.
- Existing shared CPB readiness/doctor/report modules, or a new shared module colocated with them — hold the common readiness result type, check orchestration, redaction, and render helpers.
- Existing Hub/client/state modules — expose or reuse liveness, writability, stale heartbeat, job, worker, and lease inspection without side effects.
- Existing registry modules — validate registry/project consistency without mutating registry state.
- Existing provider/backoff state modules — report cooldown/rate-limit state without network calls.
- Existing CLI test suites for doctor/report, plus focused fixture helpers where those suites already keep CLI fixtures — cover the required P0.1 scenarios without broad fixture churn.

**实现步骤**:
1. Read the promotion readiness plan and map only P0.1 requirements. Then locate the current owner files for `cpb doctor`, `cpb report`, readiness/health checks, Hub state, registry state, provider backoff state, and their tests. Record the exact files in `deliverable-071.md`.
2. Define or extend one shared readiness result shape used by both commands. Required fields per check: stable `id`, `label`, `status` (`ok`, `warn`, `fail`, `skipped`), `severity`, `message`, optional redacted `details`, optional `remediation`, and optional machine-readable `meta`. Required top-level JSON fields: `generatedAt`, `status`, `ok`, `summary`, `checks`, and `version` or existing CLI/report version field if already present.
3. Add `--json` option handling to `cpb doctor` and `cpb report` using the existing CLI parsing and output conventions. Human output should stay the default. JSON output must be valid parseable JSON on stdout, with diagnostic/progress noise kept off stdout.
4. Implement Node/npm and Git checks using existing command-runner utilities if present. Report presence and version. Use package/runtime engine requirements if already available in the project; otherwise check presence/version without inventing new policy.
5. Implement ACP adapter readiness checks through the existing adapter resolution path. Check configured adapter presence, version when supported, and a bounded smoke probe using the existing adapter smoke/handshake path if one exists. If no first-class smoke path exists, use the least invasive existing readiness/help/version probe with a short timeout and mark unsupported smoke as `skipped` rather than failing.
6. Implement optional Rust runtime readiness. Detect the existing Rust-enabled switch from config/env/runtime settings. When enabled, verify the configured Rust runtime/tooling or packaged binary expected by the project; when disabled, emit `skipped`. If enabled but unavailable, emit the appropriate readiness failure or warning according to existing doctor severity conventions.
7. Implement Hub readiness. Check liveness using the existing Hub health/heartbeat signal, writability by using an existing non-destructive write probe or temp-write/delete under the Hub state location, and stale Hub heartbeat detection using existing TTL constants where available. Do not start, stop, or mutate Hub runtime state beyond a temporary writability probe.
8. Implement registry consistency checks. Validate registered projects/sessions against existing registry schema expectations: unique IDs, valid source paths where the registry already requires paths, missing/broken entries, and mismatches between registry and Hub-visible state. Report inconsistencies with redacted details and remediation.
9. Implement stale jobs/workers/leases checks. Reuse existing state stores and TTLs where present. Detect stale active jobs, workers with old heartbeat/update times, and expired or orphaned leases. Make stale worker reporting specific enough for operators to act without exposing secrets.
10. Implement provider backoff and disk-space checks. Provider backoff should inspect persisted cooldown/rate-limit state and report active backoff windows, retry-after times, and affected provider IDs after redaction. Disk-space should warn for relevant CPB state/cache/project directories using existing thresholds if present; otherwise add conservative constants near the readiness code.
11. Add redaction coverage at the shared readiness serialization layer. Do not rely on each individual check to remember redaction. Redact common secret-bearing keys and values such as tokens, API keys, passwords, authorization headers, cookies, bearer strings, and provider credentials from both human and JSON output.
12. Add focused tests in the existing test style:
    - Missing ACP adapter: configured adapter cannot be resolved; doctor/report JSON includes a failing adapter presence check and no unredacted sensitive config.
    - Stale Hub: stale heartbeat or failed health state produces the expected Hub liveness warning/failure in human and JSON output.
    - Stale worker: old worker heartbeat produces a stale worker warning/failure without marking fresh workers stale.
    - Rate limit/backoff: persisted provider backoff state produces a warning with retry timing, with no remote provider call.
    - Rust unavailable: when Rust is enabled and runtime/tooling is missing, readiness reports the expected failure/warning; when Rust is disabled, the check is skipped or absent according to the result model.
13. Run the project’s targeted doctor/report tests first, then the broader relevant CLI test suite, lint, typecheck, and any static analysis command already documented for this repo. If a broad command is unavailable or unrelated failures exist, include the exact evidence and scope in `deliverable-071.md`.
14. Self-review the diff before handoff: confirm no unrelated cleanup, no new dependency, no behavior regression in default human output, no secret leakage in JSON/human output, and no implementation outside the P0.1 slice.

**注意事项**:
- Preserve existing exit-code semantics unless the current doctor/report code already derives exit codes from readiness failures. If exit-code behavior must change to satisfy an existing readiness contract, document it explicitly in the deliverable.
- Keep each readiness probe bounded and deterministic. No hanging subprocesses, no long network calls, and no destructive writes.
- Prefer existing project utilities for command execution, config loading, redaction, Hub state, registry access, provider state, and test fixtures.
- Do not broaden into promotion release automation, packaging, publish workflows, UI changes, or unrelated cleanup.
- Avoid snapshot churn. If snapshot updates are unavoidable because human output legitimately gains P0.1 checks, keep them minimal and explain the semantic change.

## Next-Action
Implement the scoped P0.1 doctor/report readiness expansion above, run focused and relevant verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-071.md` with changed files, evidence, risks, and any non-P0.1 items intentionally left untouched.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with top-level readiness summary and per-check results for the P0.1 readiness checks.
- [ ] `cpb report --json` emits valid JSON or includes the same readiness block through the existing report JSON shape, without breaking existing report behavior.
- [ ] Default human output for `cpb doctor` and `cpb report` remains backward compatible and includes the new readiness signals in a readable form.
- [ ] Node/npm and Git presence/version checks are implemented and tested or covered by existing command-check tests.
- [ ] ACP adapter presence, version, and bounded smoke readiness are implemented, including a missing-adapter test.
- [ ] Rust runtime readiness is conditional on the existing Rust-enabled setting, including a Rust-unavailable test and disabled-Rust non-failure behavior.
- [ ] Hub liveness, Hub writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warning checks are implemented without destructive side effects.
- [ ] Tests cover stale Hub, stale worker, provider rate-limit/backoff, missing adapter, and Rust unavailable.
- [ ] Human and JSON output redact secrets and sensitive provider/config values; tests or assertions cover redaction for at least the new JSON path.
- [ ] No unrelated cleanup, new dependencies, or non-P0.1 promotion-readiness work is included.
- [ ] Relevant tests, lint, typecheck, and static analysis pass, or the deliverable documents exact pre-existing/unrelated failures with evidence.
- [ ] `deliverable-071.md` lists changed files, verification evidence, remaining risks, and confirms the source-of-truth plan was consulted.
