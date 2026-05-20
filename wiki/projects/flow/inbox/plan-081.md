## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-081 — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, but implement only P0.1.
- Keep the change focused on `cpb doctor` / report readiness checks and their tests; do not broaden into unrelated cleanup or adjacent readiness items.
- Add machine-readable `--json` output while preserving existing human-readable behavior by default.
- Model readiness as structured checks with stable IDs, severity/status, sanitized details, and optional remediation hints so CLI and JSON output can share one source of truth.
- Redact sensitive values before printing or serializing diagnostics, including provider/API keys, tokens, auth headers, connection strings, and home-directory/private path details where the current project convention requires masking.
- Cover all required P0.1 readiness categories: Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- Add or adjust focused tests for missing adapter, stale Hub, stale worker, rate limit/provider backoff, and Rust unavailable.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — explicitly out of scope for this handoff.
- Refactoring the whole doctor/report architecture before adding checks — unnecessary risk; use existing patterns and extract only small helpers needed to avoid duplication.
- Shelling out directly from tests to real Node/npm/Git/Rust/Hub state — would make tests environment-dependent; inject or mock command/runtime/filesystem probes following existing project test patterns.
- Emitting JSON by scraping human-readable output — fragile; build human and JSON output from the same structured readiness results.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for the P0.1 promotion-readiness slice, adding `--json` output and required environment/runtime/Hub/provider diagnostics while preserving existing behavior and keeping the diff scoped.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; confirm the exact P0.1 requirements and do not edit.
- CLI entrypoint for `cpb doctor` and any existing report command/module — add `--json` parsing/wiring without changing default output semantics.
- Existing doctor/readiness implementation module(s) — add structured checks for Node/npm, Git, ACP adapter, optional Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing Hub/registry/job/worker/lease/provider state helpers — reuse where available; add narrowly scoped read-only probe helpers only if current helpers do not expose the required state.
- Existing test files for doctor/report readiness — extend coverage for the required scenarios; create a focused new test file only if there is no natural existing location.
- Test fixtures/helpers for command/runtime/filesystem probes — adjust only as needed for deterministic readiness tests; do not modify fake/mock behavior merely to hide a real production mismatch.

**实现步骤**:
1. Read the source-of-truth plan and locate the current `cpb doctor` / report implementation and tests.
   - Confirm the existing command names, option parser, output format, readiness result shape, and test harness.
   - Identify whether `cpb report` consumes doctor checks or has separate readiness logic.
   - Expected output: a minimal map of implementation files and tests to touch.

2. Define or extend a structured readiness result type used by both human and JSON output.
   - Include stable fields such as `id`, `label`, `status`, `severity`, `message`, `details`, and optional `remediation`.
   - Use status values compatible with existing conventions; if none exist, prefer a small set such as `ok`, `warn`, `fail`, `skip`.
   - Ensure details are serializable and redacted before output.
   - Preserve existing exit-code behavior unless tests or source plan explicitly require a change.

3. Add `--json` output for `cpb doctor` and any P0.1-required report surface.
   - Parse `--json` through the existing CLI option pattern.
   - Emit deterministic JSON with top-level metadata plus the readiness checks array.
   - Do not include ANSI color, progress text, stack traces, raw secrets, or environment-specific unstable ordering in JSON.
   - Keep default text output backward-compatible.

4. Implement Node/npm and Git checks.
   - Check presence and version readiness through the existing command probe abstraction if available.
   - Report missing binaries as `fail` or existing equivalent blocking status.
   - Report malformed/unparseable versions as warning/failure according to current doctor severity conventions.
   - Avoid invoking real commands directly in tests; inject probe results.

5. Implement ACP adapter presence/version/smoke readiness checks.
   - Verify the expected adapter binary/package/module is discoverable using the project’s existing ACP configuration.
   - Capture adapter version when available.
   - Add a bounded smoke readiness probe that proves the adapter can be invoked/loaded enough for promotion readiness without performing destructive actions.
   - Report missing adapter, version failure, and smoke failure as distinct structured checks so users can diagnose quickly.

6. Implement Rust runtime readiness when enabled.
   - Detect the existing feature/config/env flag that enables Rust runtime use.
   - When disabled, return a `skip`/non-blocking result rather than failing.
   - When enabled, verify required Rust runtime binary/library availability and version/readiness.
   - Ensure the "Rust unavailable" test covers enabled-and-missing behavior without requiring Rust to be installed or absent on the developer machine.

7. Implement Hub liveness and writability checks.
   - Reuse existing CPB Hub client/state access instead of opening a separate protocol path.
   - Liveness should distinguish unreachable/stale Hub from healthy Hub.
   - Writability should verify that the configured Hub state/output location can accept writes using the least intrusive existing mechanism, preferably a temp/probe write that is cleaned up.
   - Do not mutate real jobs/workers/leases except for an explicitly safe probe artifact, and do not leave residue.

8. Implement registry consistency checks.
   - Compare registered projects/adapters/providers/workers against the current Hub/project state using existing registry readers.
   - Detect missing, duplicate, stale, or internally inconsistent entries.
   - Keep messages specific but sanitized.
   - Avoid changing registry repair behavior; this P0.1 slice reports consistency, it does not auto-fix.

9. Implement stale jobs/workers/leases checks.
   - Use existing TTL/heartbeat semantics if present; do not invent incompatible thresholds.
   - If no threshold exists, define a local constant in the readiness module with a clear name and test it.
   - Report stale jobs, stale workers, and stale leases separately or with detail arrays under a single stable check if that matches current output style.
   - Include enough redacted IDs/timestamps/counts to troubleshoot without leaking sensitive paths or payloads.

10. Implement provider backoff / rate-limit readiness.
   - Inspect existing provider backoff state or rate-limit metadata.
   - Report active backoff/rate-limit as a warning unless the current project treats it as blocking.
   - Include provider name, retry-after/backoff-until, and reason when available, after redaction.
   - Add a deterministic rate-limit test with fixture state.

11. Implement disk-space warnings.
   - Probe free space for the relevant CPB state, Hub, registry, temp, or workspace location(s) using existing filesystem utilities when possible.
   - Warn when below the existing or source-plan threshold; if no threshold exists, choose a conservative named constant and document it in code only if necessary.
   - Do not fail on platforms where disk stats are unavailable; emit a warning/skip with sanitized detail.

12. Centralize redaction before all doctor/report output.
   - Reuse any existing redaction helper.
   - Ensure both text and JSON paths pass through redaction.
   - Add tests or assertions that sensitive provider/backoff/adapter/Hub details are not emitted raw.

13. Add/adjust tests for required P0.1 scenarios.
   - Missing adapter: doctor/report returns a failed adapter presence check and sanitized JSON/text details.
   - Stale Hub: liveness check reports stale/unhealthy Hub without mutating Hub state.
   - Stale worker: stale worker/lease/job detection reports warning/failure with redacted identifiers.
   - Rate limit/provider backoff: active provider backoff appears in JSON and text as a warning with retry timing.
   - Rust unavailable: when Rust runtime is enabled and probe fails, readiness reports the expected failure; when disabled, the check is skipped/non-blocking.
   - `--json`: JSON is parseable, deterministic, contains all required categories, and contains no ANSI/control formatting.

14. Run the targeted and standard verification expected by the repository.
   - Run the focused doctor/report readiness tests first.
   - Then run the project’s relevant lint/typecheck/test command set for the touched package(s).
   - Capture exact commands and summarized outputs in `deliverable-081.md`.
   - If any standard verification cannot run, document the blocker and any narrower evidence collected.

**注意事项**:
- Preserve existing human-readable output and exit codes unless the source plan or existing tests clearly require different behavior.
- Keep changes scoped to P0.1; do not implement unrelated P0/P1 promotion readiness items.
- Do not add new dependencies without explicit approval.
- Prefer existing command probe, filesystem, Hub, registry, and provider helpers over new abstractions.
- Do not edit snapshots/fixtures/test doubles only to mask production behavior changes; update tests only to cover the intended P0.1 behavior.
- Ensure all diagnostic details are redacted before output, including JSON.
- Keep readiness checks deterministic in tests by injecting time, command results, filesystem stats, Hub state, and provider state where needed.

## Next-Action
Implement the scoped P0.1 doctor/report readiness expansion following the steps above, run the relevant verification, and write `deliverable-081.md` with changed files, evidence, remaining risks, and any source-plan details that affected implementation.

## Acceptance-Criteria
- [ ] `cpb doctor` supports `--json` and emits parseable deterministic JSON for readiness results.
- [ ] Existing default `cpb doctor` human-readable behavior is preserved except for the newly required readiness checks.
- [ ] The report readiness surface required by P0.1 includes the same structured readiness information or delegates to the shared doctor readiness implementation.
- [ ] Readiness checks cover Node and npm presence/version.
- [ ] Readiness checks cover Git presence/version.
- [ ] Readiness checks cover ACP adapter presence, version, and bounded smoke readiness.
- [ ] Readiness checks cover Rust runtime readiness only when Rust runtime is enabled, and skip/non-block when disabled.
- [ ] Readiness checks cover CPB Hub liveness and writability without leaving probe residue.
- [ ] Readiness checks cover registry consistency.
- [ ] Readiness checks cover stale jobs, stale workers, and stale leases.
- [ ] Readiness checks cover provider backoff/rate-limit state.
- [ ] Readiness checks include disk-space warnings for relevant CPB/Hub/workspace paths.
- [ ] Text and JSON output redact secrets, tokens, sensitive provider data, and unsafe path/detail fields according to existing project conventions.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub.
- [ ] Tests cover stale worker, and include stale job/lease coverage if these share the same detector.
- [ ] Tests cover provider rate limit/backoff.
- [ ] Tests cover Rust unavailable when Rust runtime is enabled.
- [ ] Tests cover `--json` parseability, required categories, and absence of ANSI/control formatting.
- [ ] All targeted doctor/report readiness tests pass.
- [ ] Relevant lint/typecheck/test commands for touched packages pass, or any inability to run them is clearly documented in `deliverable-081.md`.
- [ ] Code style matches existing project patterns and the diff remains scoped to P0.1.
