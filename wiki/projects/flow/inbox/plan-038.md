# Plan 038 - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.1 expand cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-038-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 readiness slice.
- Keep the implementation centered on the existing readiness service surface: `server/services/readiness-checks.js`, which already exposes `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson`.
- Preserve existing human output while adding or completing deterministic `--json` behavior for `cpb doctor` and `cpb report`.
- Add checks as structured readiness records with stable `id`, `category`, `status`, `summary`, `details`, and `remediation` fields so human and JSON output share one source of truth.
- Use existing hub/runtime helpers before adding new primitives: `server/services/hub-registry.js`, `server/services/runtime-cli.js`, `server/services/diagnostics-bundle.js`, and adjacent services for jobs, leases, workers, registry, and provider rate limits.
- Redact secrets before any report/JSON serialization, including tokens, API keys, bearer values, auth headers, provider credentials, and absolute paths only when the existing diagnostics redaction policy already treats them as sensitive.
- Report unavailable optional Rust runtime as `skipped` when Rust is disabled, and as `error` or `warn` only when Rust runtime is explicitly enabled but missing or unusable.
- Tests must cover the requested P0.1 failure modes: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.

### Rejected
- Broad CLI cleanup or command restructuring: out of scope for P0.1 and risks changing existing behavior.
- New runtime dependencies for disk checks, command probing, or JSON formatting: use Node built-ins and existing project helpers.
- Fake success by weakening or rewriting unrelated mocks/fixtures: add targeted readiness fixtures/tests only where the readiness behavior itself is under test.
- Rust runtime implementation changes beyond readiness detection: P0.1 asks for promotion readiness checks, not runtime feature work.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` readiness checks for P0.1 promotion readiness, including JSON output, local toolchain checks, adapter readiness, Rust runtime readiness when enabled, Hub and registry health, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction, while preserving existing behavior outside this slice.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read first; source of truth for P0.1 boundaries only.
- `server/services/readiness-checks.js` - primary implementation surface for readiness check collection and human/JSON formatting.
- `server/services/diagnostics-bundle.js` - wire readiness output into `cpb report` and enforce report redaction.
- `server/services/observability.js` - reuse or tighten existing redaction helpers if readiness/report output can expose secrets.
- `server/services/runtime-cli.js` - reuse `shouldUseRustRuntime`, `resolveRuntimeBin`, `getRuntimeBackend`, and rate-limit helpers for Rust/provider readiness checks.
- `server/services/hub-registry.js` - reuse `hubStatus`, `loadRegistry`, worker status, and registry metadata for Hub liveness and registry consistency.
- Existing `cpb` CLI entrypoint file - locate the current `doctor` and `report` command dispatch and add/confirm `--json` handling without reshaping unrelated commands.
- Existing readiness/diagnostics/CLI test files - add focused tests next to the current tests for readiness checks and command output.

**实现步骤**:
1. Read the P0.1 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and write down the exact must-have checklist in your deliverable evidence; do not implement P1/P2 items or adjacent cleanup.
2. Locate the current `cpb doctor` and `cpb report` command dispatch. Confirm whether they already call `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, or `gatherDiagnostics`; wire them to the shared readiness service if they do not already share it.
3. Normalize the readiness result schema in `server/services/readiness-checks.js`: keep existing fields, add any missing stable IDs/categories, and ensure `deriveSummary` distinguishes `ok`, `warn`, `error`, and `skipped` without changing current successful behavior.
4. Complete local toolchain checks: Node version, npm presence/version, and Git presence/version. Missing npm/Git should be actionable `error`; unsupported Node should be `error`; usable versions should include redacted version details.
5. Complete ACP adapter readiness checks: detect configured adapter presence, version command readiness when available, and a low-cost smoke readiness probe. Missing adapter must produce a stable machine-readable check ID and remediation. Smoke probes must time out and must not start long-running sessions.
6. Complete Rust runtime readiness: when Rust runtime is enabled by the existing runtime configuration, verify binary resolution and a cheap backend/version/smoke command. If enabled but unavailable, surface a stable `error` with remediation. If disabled, emit `skipped` instead of failing.
7. Complete Hub readiness: check Hub root liveness, required directory/file presence, and writability with a reversible temporary probe. Treat missing/unreadable Hub as `error`; treat low disk space as `warn`; remove any temporary probe file after the check.
8. Complete registry consistency: load registry through existing helpers, verify version shape, project entries, enabled project paths, duplicate IDs or broken source paths, and stale registry locks. Return warnings for recoverable inconsistencies and errors for unreadable/corrupt registry state.
9. Complete stale operational checks: report stale jobs, stale workers, and orphan/stale leases using existing TTL/status helpers. Include counts and capped sample IDs in `details`, not full unbounded payloads.
10. Complete provider backoff checks: read existing provider rate-limit/backoff state through current runtime helpers, flag active backoff/rate limit as `warn`, include provider name and expiration time, and redact reasons that contain credentials.
11. Complete disk-space warnings using built-in filesystem/stat APIs or existing project helpers. Use a conservative warning threshold already present in readiness code if available; avoid platform-specific shell commands.
12. Ensure all readiness output paths call a redaction function before serialization. Add tests that intentionally include token-like values in adapter output, provider reason, env-derived details, and diagnostics/report payloads, then assert secrets are absent from both human and JSON output.
13. Add or adjust tests for the exact requested scenarios: missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust enabled but unavailable. Prefer unit tests around `runReadinessChecks` with temp directories and injected command/runtime adapters; add CLI snapshot/assertion tests only for `--json` behavior.
14. Verify the existing happy path still passes: human `cpb doctor` output remains readable and grouped; `cpb doctor --json` emits parseable JSON with summary and checks; `cpb report --json` includes readiness data and redacts sensitive fields.
15. Keep the final diff scoped. Do not modify unrelated UI, dashboard, workflow, runtime queue, policy compiler, fake LLM responders, broad fixtures, snapshots unrelated to readiness, or promotion plan docs.

**注意事项**:
- Preserve existing behavior for non-JSON output and existing report fields unless the P0.1 source-of-truth explicitly requires a change.
- Prefer dependency injection for tests over mutating global environment. Restore any environment variables, temp directories, or fake clocks after each test.
- Do not make network calls in readiness checks. Liveness means local Hub/filesystem/process readiness only unless existing code already defines a local endpoint check.
- Cap arrays in JSON details for stale jobs/workers/leases so `cpb report --json` remains bounded.
- Mark optional checks as `skipped` with a reason instead of hiding them; readiness consumers need to distinguish absent optional features from successful checks.
- Use stable IDs such as `toolchain.node`, `toolchain.npm`, `toolchain.git`, `acp.adapter`, `runtime.rust`, `hub.liveness`, `hub.writable`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, and `disk.space`.
- Exit status policy should remain compatible with current behavior: if current `doctor` exits non-zero on `error`, keep that; warnings alone should not become fatal unless existing behavior already does so.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, run the targeted and existing test suites needed to prove it, then write `deliverable-038.md` with changed files, test evidence, behavior notes for `cpb doctor --json` and `cpb report --json`, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` still produces the existing human-readable readiness report, with added P0.1 checks grouped by category and no unrelated behavior changes.
- [ ] `cpb doctor --json` emits valid JSON with `summary`, `generatedAt`, and structured `checks`; no ANSI color codes or human-only formatting appear in JSON.
- [ ] `cpb report --json` includes the same readiness check data or a clearly named readiness section derived from `runReadinessChecks`.
- [ ] Node, npm, and Git readiness checks report usable versions when available and actionable errors when missing or unsupported.
- [ ] ACP adapter readiness reports presence, version when available, and smoke readiness; missing adapter is covered by a failing test.
- [ ] Rust runtime readiness is `skipped` when disabled and reports an error or warning when enabled but unavailable; Rust unavailable is covered by a failing test.
- [ ] Hub liveness and writability checks detect missing, stale, unreadable, or unwritable Hub state without leaving probe files behind; stale Hub is covered by a failing test.
- [ ] Registry consistency checks detect corrupt/unreadable registry data, broken enabled project paths, duplicate project IDs, and stale locks with bounded details.
- [ ] Stale jobs, stale workers, and stale leases checks use existing TTL/status semantics and include bounded counts/sample IDs; stale worker is covered by a failing test.
- [ ] Provider backoff/rate-limit readiness reports active backoff as `warn` with provider and expiration details; rate limit/backoff is covered by a failing test.
- [ ] Disk-space readiness reports low-space conditions as warnings without shelling out to platform-specific commands.
- [ ] Human and JSON outputs redact tokens, API keys, bearer values, auth headers, and provider credentials; redaction is covered by tests.
- [ ] Tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable fail before the implementation and pass after it.
- [ ] Existing relevant tests pass after the change, including readiness/diagnostics/CLI tests and any existing report tests.
- [ ] The deliverable explicitly confirms that only P0.1 was implemented and no unrelated cleanup was included.
