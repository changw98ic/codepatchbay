## Handoff: codex -> claude

# Plan 069 - Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as source of truth; implement P0.1 expanded `cpb doctor/report` readiness checks only

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-069-P0.1-promotion-readiness-doctor-report
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 slice.
- Expand the existing `cpb doctor` / readiness report path rather than creating a parallel diagnostics command.
- Add `--json` output for machine-readable readiness results while preserving the current human-readable behavior by default.
- Model every readiness probe as structured data with severity, stable code, redacted detail, and remediation text so text and JSON output stay consistent.
- Keep checks non-destructive: probes may read files, inspect versions, ping/liveness-check local services, and write only to an intended temporary/scratch path when explicitly validating Hub writability.
- Redact secrets and sensitive paths/tokens from both text and JSON output before printing or persisting diagnostics.
- Add focused tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 | The task explicitly limits this handoff to expanded doctor/report readiness checks.
- Rewriting the diagnostics architecture | Risky and unnecessary; extend the current doctor/report implementation to preserve existing behavior.
- Adding new dependencies for version parsing, disk probing, or redaction | The standing project constraint says no new dependencies without explicit request.
- Making `--json` the default output | This would break existing CLI behavior; keep human output default and JSON opt-in.
- Treating unavailable optional Rust runtime as a failure when Rust integration is disabled | The requirement is "Rust runtime when enabled"; disabled Rust support should be reported as skipped/ok, not failed.

### Files
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - Read first; authoritative scope and acceptance details for P0.1.
- CLI entrypoint for `cpb doctor` and readiness reporting - Add/extend `--json` parsing and route output through the shared readiness result model.
- Existing doctor/readiness/checks module(s) - Add checks for Node/npm, Git, ACP adapter, Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing Hub/registry/job/worker/lease modules - Reuse existing readers/APIs for liveness, writability, registry consistency, and stale state detection; do not duplicate storage parsing where helpers already exist.
- Existing provider/backoff module(s) - Reuse provider state/backoff metadata to report rate-limit/backoff readiness.
- Existing test files for CLI doctor/readiness/report behavior - Extend for `--json`, existing default text output preservation, and new P0.1 probes.
- New focused test fixtures only if existing fixtures cannot express stale Hub, stale worker, missing adapter, provider rate limit, or Rust unavailable states cleanly.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for P0.1 promotion readiness while keeping changes scoped, preserving current behavior, adding JSON output, redacting sensitive output, and covering the required failure modes with tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - Source-of-truth reference; read but do not modify.
- Existing `cpb doctor` CLI command file - Add `--json` option and preserve current text output.
- Existing readiness/doctor report implementation file(s) - Add structured readiness result schema and required P0.1 checks.
- Existing ACP adapter integration/config file(s) - Probe adapter presence, version, and smoke readiness using existing adapter discovery/execution boundaries.
- Existing Hub storage/client file(s) - Probe Hub liveness and writability through existing APIs.
- Existing registry file(s) - Validate registry consistency through existing registry loaders/validators.
- Existing job/worker/lease state file(s) - Detect stale jobs, stale workers, and stale leases using existing timestamp/TTL semantics.
- Existing provider/backoff state file(s) - Report provider rate limit/backoff status without leaking provider credentials.
- Existing test files under the project test tree - Add/adjust tests for the required scenarios while avoiding fake/mock rewrites that hide production behavior changes.

**实现步骤**:
1. Read the promotion readiness plan and identify only the P0.1 acceptance details relevant to `cpb doctor` / report readiness checks.
2. Locate the current `cpb doctor` command, current report/readiness output path, and existing tests that assert doctor/report behavior.
3. Introduce or extend a shared readiness result shape with stable fields: `code`, `name`, `status`, `severity`, `summary`, `details`, `remediation`, and optional `metadata`; valid statuses should cover at least `ok`, `warn`, `fail`, and `skipped`.
4. Add `--json` handling to the `cpb doctor` command so it emits the full structured readiness report as JSON and exits with the same success/failure semantics as the text mode.
5. Preserve existing human-readable output by rendering the new structured results back through the current text/report format; update snapshots only if they reflect intentional output additions.
6. Add Node/npm checks: detect `node` and `npm`, capture versions, warn/fail according to existing project version policy if present, and redact executable paths if they include sensitive home/workspace fragments.
7. Add Git checks: detect Git availability/version and report failure or warning when unavailable, using the same command-execution abstraction the CLI already uses.
8. Add ACP adapter checks: verify configured/discovered adapter presence, version availability, and smoke readiness; report missing adapter as a failing readiness item with actionable remediation.
9. Add Rust runtime checks only when Rust runtime support is enabled by config/environment: verify runtime/tool availability and report unavailable runtime as the required failure case; report `skipped` when Rust support is disabled.
10. Add Hub checks: verify liveness through existing Hub client/heartbeat APIs and verify writability using the safest existing write probe or temporary scratch record; ensure stale Hub state is detected and reported.
11. Add registry consistency checks: load the registry through existing validators and report missing, corrupt, duplicate, dangling, or inconsistent entries without mutating the registry.
12. Add stale state checks for jobs, workers, and leases using existing TTL/heartbeat rules; surface stale workers separately from stale jobs/leases so the required stale worker test has a stable diagnostic code.
13. Add provider backoff checks: inspect provider state for active rate-limit/backoff windows, return `warn` for recoverable active backoff and `fail` only if existing policy treats it as blocking readiness.
14. Add disk-space checks: warn when available space is below the project threshold; use an existing threshold if present, otherwise define a small local constant near the check and document it in the diagnostic remediation text.
15. Centralize redaction for doctor/report output and apply it before both text and JSON rendering; cover tokens, API keys, bearer values, secrets, home-directory sensitive paths where existing project policy requires it, and provider-specific credential names.
16. Add tests for default text output preservation and `--json` structure, including stable status/code assertions instead of brittle full-output matching where possible.
17. Add focused failure-mode tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.
18. Run the project’s relevant test target(s), then broader lint/typecheck/test commands already standard for this repository; capture exact command output in the deliverable.
19. Write `deliverable-069.md` with changed files, evidence, known risks, and any source-of-truth P0.1 items intentionally left out because they were outside the requested slice.

**注意事项**:
- Do not implement other P0/P1 promotion readiness tasks.
- Do not modify unrelated cleanup, formatting, fixtures, snapshots, or test doubles merely to force tests to pass.
- Do not add dependencies unless the promotion readiness plan explicitly requires one and no standard/project utility can satisfy the check.
- Keep all probes deterministic in tests by injecting command runners, clocks, filesystem roots, Hub clients, and provider state readers if the project already supports that pattern.
- Do not leak secrets in assertion failures, logs, JSON, text output, or deliverable evidence.
- Preserve existing exit-code semantics unless the source-of-truth plan explicitly changes them; if changing exit codes is required, add tests that document the new contract.
- Prefer existing project constants for stale thresholds, disk thresholds, config locations, and adapter names.

## Next-Action
Implement the P0.1 `cpb doctor` / report readiness expansion exactly as scoped above, run the relevant tests and standard verification commands, then write `deliverable-069.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor` still supports its current default human-readable output and existing behavior is preserved except for intentional added readiness lines.
- [ ] `cpb doctor --json` emits valid JSON with stable readiness fields for every check and no unredacted secrets.
- [ ] Readiness covers Node/npm availability/version, Git availability/version, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is reported with a stable failing diagnostic code and actionable remediation.
- [ ] Stale Hub state is detected and covered by a test.
- [ ] Stale worker state is detected separately from stale jobs/leases and covered by a test.
- [ ] Provider rate-limit/backoff state is surfaced in readiness output and covered by a test.
- [ ] Rust unavailable while Rust runtime is enabled is surfaced in readiness output and covered by a test.
- [ ] Redaction is applied consistently to text output, JSON output, logs, and error details.
- [ ] Registry consistency failures are reported without mutating registry data.
- [ ] Hub writability probe is non-destructive or cleans up its temporary/scratch state.
- [ ] Tests cover `--json` success/failure shape and required P0.1 failure scenarios.
- [ ] Relevant lint, typecheck, and test commands pass, with exact verification evidence recorded in `deliverable-069.md`.
- [ ] Changed files remain scoped to P0.1 doctor/report readiness; no unrelated cleanup or broader promotion-readiness work is included.
