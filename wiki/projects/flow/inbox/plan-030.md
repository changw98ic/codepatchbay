## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement P0.1 cpb doctor/report readiness checks only.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-030 / P0.1 promotion-readiness doctor-report checks
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the execution authority; implement only its P0.1 slice.
- Keep the implementation centered on the existing `cpb doctor` / `cpb report` readiness path rather than creating a parallel diagnostics command.
- Preserve existing human output and exit behavior unless the source plan explicitly requires a narrower change; add `--json` as an additive output mode.
- Use the existing readiness service surface in `server/services/readiness-checks.js` for check collection and formatting.
- Keep checks structured, redacted, deterministic in tests, and safe to run on developer machines without mutating real Hub state except for an explicit writability probe that cleans up after itself.

### Rejected
- Broad cleanup or refactor outside P0.1; this task is promotion readiness only.
- Adding new dependencies for command execution, disk checks, schema validation, or test fixtures; use Node built-ins and existing project helpers.
- Shelling out from tests to real global tools where fixtures can prove behavior; tests should simulate missing adapters, stale Hub state, rate limits, and unavailable Rust deterministically.
- Editing fake/mock assets merely to make unrelated tests pass; only add purpose-built readiness fixtures for the new scenarios.
- Emitting raw environment, paths with embedded credentials, provider tokens, command lines with secrets, or full process environments in human or JSON output.

### Evidence
- Planning phase only; no terminal commands were executed.
- Non-terminal code-intel lookup identified `server/services/readiness-checks.js` with `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Non-terminal code-intel lookup identified root `cpb` as the command entrypoint with existing `asJson` / `jsonMode` handling near doctor/report logic.

### Files
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use as the source of truth for P0.1 boundaries.
- `cpb` — wire `doctor` and `report` option handling so `--json` is supported consistently and existing non-JSON behavior is preserved.
- `server/services/readiness-checks.js` — expand readiness checks, result schema, redaction, summaries, and human/JSON formatting.
- `server/services/diagnostics-bundle.js` — include the expanded readiness report in report/diagnostics output only if this is already the report integration point.
- `server/services/observability.js` — reuse or minimally extend existing redaction helpers if readiness output needs shared redaction.
- `test` / `tests` readiness coverage file nearest the current project convention — add focused tests for the P0.1 scenarios listed below; create the narrowest new readiness test file only if no suitable file exists.

### Scope

**Goal**: Expand `cpb doctor` / `cpb report` promotion readiness checks for P0.1 only, including JSON output, toolchain checks, ACP adapter readiness, optional Rust runtime readiness, Hub health, registry consistency, stale state detection, provider backoff warnings, disk warnings, output redaction, and focused tests.

**Implementation Steps**:
1. Read `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and confirm the exact P0.1 acceptance language before editing. If it conflicts with this plan, follow the source document and record the difference in the deliverable.
2. Inspect existing `cpb doctor` and `cpb report` flow in `cpb`. Keep current human output and exit-code semantics stable; add or preserve `--json` so both commands can emit machine-readable readiness results without banners, ANSI color, or non-JSON text.
3. Normalize the readiness result contract in `server/services/readiness-checks.js`: each check should have stable `id`, `category`, `status` (`ok`, `warn`, `error`, `skipped`), `label`, optional `details`, optional `remediation`, and redacted metadata. Include a top-level summary with generated timestamp, command name, counts, and overall status.
4. Implement or complete toolchain checks for Node, npm, and Git. Capture presence and version when available, classify missing required tools as `error`, unsupported/minimum-version gaps as `error` or `warn` per existing project policy, and include concise remediation.
5. Implement ACP adapter presence/version/smoke readiness. Check configured or default ACP adapters without assuming a single provider; report missing adapter as `error`, version detection failure as `warn` unless the adapter is unusable, and smoke readiness as `ok` / `warn` / `error` based on timeout, auth, executable, or startup failure.
6. Implement Rust runtime readiness only when Rust runtime support is enabled by existing config/env/feature flag. If disabled, emit `skipped`; if enabled and cargo/runtime binary is unavailable, emit `error` with remediation. Cover "Rust unavailable" in tests.
7. Expand Hub checks: liveness, root/path existence, and writability. Writability should create a temporary sentinel under the Hub-controlled writable area and remove it; stale/unreachable Hub state should not be silently treated as healthy.
8. Add registry consistency checks for project registry entries: missing project root, duplicate IDs, disabled/enabled mismatch, malformed records, and stale references should produce warnings or errors according to severity while preserving existing valid registry behavior.
9. Add stale state checks for jobs, workers, and leases using existing TTL constants or source-plan thresholds. Detect stale running jobs, stale workers, and orphan/expired leases; include bounded examples/counts rather than dumping full state.
10. Add provider backoff/rate-limit checks. If provider state indicates active backoff, rate limiting, or retry suppression, emit a `warn` with provider, redacted reason, and retry timestamp; never expose tokens, raw request payloads, or full provider config.
11. Add disk-space warnings using existing platform-safe APIs or current helper patterns. Report free/available bytes and threshold in JSON; keep human text concise. Low disk should be `warn` unless the source plan requires `error`.
12. Apply redaction to every readiness output path, including nested JSON details and errors. Redact API keys, bearer tokens, credentials in URLs, home-directory secrets, provider config secrets, and command stderr that may contain secrets.
13. Add or adjust tests to cover: missing ACP adapter, stale Hub/liveness or writability failure, stale worker, active provider rate limit/backoff, Rust runtime enabled but unavailable, JSON output parseability, and redaction in both human and JSON paths.
14. Run the smallest relevant test set first, then the repository's standard lint/typecheck/test commands if available. Do not broaden into unrelated cleanup; if unrelated tests fail, record them separately with evidence.

**Notes**:
- Prefer dependency injection in `runReadinessChecks` for filesystem, process execution, time, environment, and Hub paths so tests do not depend on the developer machine.
- Keep the `--json` schema stable enough for CI/readiness consumers: no ANSI color, no circular data, no raw Error objects, no unbounded arrays.
- Use bounded timeouts for adapter/version/smoke probes so `doctor` remains responsive.
- Preserve existing behavior for healthy systems: current successful `doctor` / `report` output should remain recognizable, with additional readiness rows/details appended in the established style.
- Do not modify generated worktrees under `cpb-task/worktrees`; implement in the main source files only.

### Risks
- The source plan file must be checked before implementation; if it defines exact thresholds or statuses, those override the thresholds implied here.
- `cpb` appears to be a root executable without extension; preserve its current runtime assumptions and shebang behavior.
- Adapter smoke checks can become flaky if they invoke real providers; prefer local startup/version probes and deterministic test doubles.
- Hub writability probes must clean up even on failure to avoid introducing new stale files.
- JSON consumers may depend on existing fields if `--json` already exists; make schema changes additive unless the source plan explicitly says otherwise.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then update only the relevant `cpb` doctor/report readiness code and focused tests. After implementation, run verification and write `deliverable-030.md` with changed files, test evidence, and any source-plan deviations.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only, with stable summary and per-check objects.
- [ ] `cpb report --json` includes the expanded readiness report without breaking existing report behavior.
- [ ] Human `cpb doctor` / `cpb report` output remains usable and preserves existing behavior aside from the added readiness checks.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing required adapter is reported as a readiness failure with remediation and is covered by a test.
- [ ] Stale or unwritable Hub state is reported with bounded details and is covered by a test.
- [ ] Stale worker detection is covered by a test.
- [ ] Provider rate-limit/backoff detection is covered by a test.
- [ ] Rust runtime enabled but unavailable is reported correctly and covered by a test.
- [ ] Human and JSON outputs redact secrets in nested details, stderr/error messages, URLs, provider config, and environment-derived values.
- [ ] Checks use bounded timeouts and deterministic test injection; tests do not depend on real global ACP adapters, real provider credentials, or the developer's actual Hub.
- [ ] No unrelated cleanup, dependency additions, fixture rewrites, or generated worktree edits are included.
- [ ] Relevant lint/typecheck/tests pass, or any unrelated pre-existing failures are documented with command output in `deliverable-030.md`.
