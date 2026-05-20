## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-018
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before editing implementation files.
- Implement only P0.1 readiness coverage for `cpb doctor` and `cpb report`; do not broaden into unrelated cleanup, dependency changes, CLI redesign, or non-P0 work.
- Add `--json` output through the existing CLI/reporting patterns so human-readable output remains backward compatible.
- Model readiness checks as structured results with stable status/severity fields, redact sensitive values at the boundary, and reuse existing diagnostics, registry, Hub, provider, and runtime helpers where present.
- Cover the required failure modes with focused tests: missing ACP adapter, stale Hub, stale worker, provider rate/backoff state, and Rust unavailable when Rust runtime support is enabled.

### Rejected
- Rejected broad refactor of doctor/report internals: the task is a P0 slice and must preserve existing behavior.
- Rejected adding new dependencies for command probing, disk checks, or redaction: existing project utilities and Node standard APIs should be sufficient unless the source plan explicitly requires otherwise.
- Rejected changing fake/mock assets merely to force tests green: adjust tests only when they encode the intended readiness behavior or add purpose-built fixtures for this slice.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for the P0.1 promotion-readiness slice, including structured JSON output, environment/toolchain checks, ACP adapter readiness, optional Rust runtime readiness, Hub and registry health, stale runtime state detection, provider backoff visibility, disk-space warnings, redaction, and regression tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first as the implementation source of truth; do not edit unless the plan explicitly says to.
- CLI entry files for `cpb doctor` and `cpb report` — add/route `--json` and include the expanded readiness checks while preserving current text output.
- Existing doctor/report readiness modules — add check implementations for Node/npm, Git, ACP adapter, optional Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing ACP adapter integration helpers — detect presence, version, and smoke readiness without introducing side effects beyond an explicit readiness probe.
- Existing Hub and registry persistence helpers — verify liveness, writability, consistency, and stale-state signals using current storage contracts.
- Existing provider/backoff modules — surface active rate-limit/backoff state as readiness warnings/errors without clearing or mutating provider state.
- Existing test files for doctor/report CLI and readiness behavior, or new colocated tests following the same pattern — add coverage for required P0.1 cases.

**实现步骤**:
1. Read the promotion-readiness plan and identify the exact existing doctor/report files, test conventions, severity vocabulary, and any constraints specific to P0.1.
2. Locate current `cpb doctor` and `cpb report` command flow, including argument parsing, output formatting, diagnostic aggregation, and test harnesses.
3. Define a small structured readiness result shape if one does not already exist: include check id, label, status, severity, message, details, remediation hint when useful, and redacted machine-readable fields for JSON.
4. Add `--json` support to `cpb doctor` and `cpb report` using existing CLI option style. Ensure JSON output is parseable, deterministic enough for tests, and free of ANSI/text-only formatting.
5. Preserve existing human-readable output unless new required readiness checks add additional lines. Do not remove existing checks, change exit semantics, or rename existing user-visible checks unless the source plan requires it.
6. Implement Node/npm readiness checks:
   - confirm current Node runtime version is available;
   - confirm npm is available/versioned through the existing command-probing abstraction or a safe equivalent;
   - report missing/unparseable npm as a readiness issue without crashing.
7. Implement Git readiness checks:
   - confirm Git executable availability/version;
   - surface missing Git as a clear readiness issue;
   - avoid running repository-mutating commands.
8. Implement ACP adapter readiness:
   - detect required adapter presence;
   - collect adapter version when available;
   - run a bounded smoke-readiness probe through existing adapter APIs or the minimal current adapter command path;
   - return actionable diagnostics for missing adapter, unknown version, or failed smoke readiness.
9. Implement Rust runtime readiness only when the relevant Rust runtime path/feature/configuration is enabled:
   - detect Rust runtime availability/version;
   - report unavailable Rust as the required testable readiness issue;
   - skip or mark not-applicable when Rust runtime is disabled.
10. Implement Hub readiness:
    - check Hub liveness using the existing Hub client/heartbeat/state contract;
    - verify Hub storage/writability with a non-destructive temporary write or existing writable probe;
    - detect stale Hub state and report it with age/threshold details.
11. Implement registry consistency checks:
    - verify registered projects/workspaces/adapters are internally consistent;
    - surface missing targets, duplicate/conflicting entries, or invalid metadata as warnings/errors based on existing severity conventions.
12. Implement stale jobs/workers/leases checks:
    - detect stale jobs, worker heartbeats, and leases using existing timestamp/TTL semantics;
    - include stale identifiers and ages in JSON after redaction;
    - avoid deleting or repairing stale records in doctor/report.
13. Implement provider backoff checks:
    - surface active provider rate-limit/backoff state with provider id, retry timing, and severity;
    - redact tokens, keys, URLs with embedded credentials, headers, and request payload fragments.
14. Implement disk-space warnings:
    - check free space for relevant project, Hub, registry, cache, or runtime paths;
    - use conservative warning thresholds from the source plan or existing config;
    - report warning rather than failure unless the source plan defines a hard error threshold.
15. Centralize or reuse redaction:
    - ensure JSON and text output both redact secrets;
    - add tests or assertions for representative sensitive fields if there is existing redaction coverage nearby.
16. Add or adjust tests for the required cases:
    - missing ACP adapter;
    - stale Hub;
    - stale worker;
    - provider rate-limit/backoff;
    - Rust unavailable when Rust runtime is enabled.
17. Add tests for `--json` on doctor/report:
    - output parses as JSON;
    - includes expected check ids/status/severity;
    - excludes unredacted sensitive values;
    - preserves expected exit code semantics.
18. Run the smallest relevant test targets first, then the repository’s standard verification for this slice. Fix production code rather than weakening fake/mock behavior unless the fake/test double itself is the intended subject.
19. Produce `deliverable-018.md` with changed files, evidence, simplifications made, and remaining risks.

**注意事项**:
- Keep changes scoped to P0.1. Do not implement other P0/P1/P2 readiness items from the promotion plan.
- Do not add dependencies without explicit human approval.
- Do not mutate Hub, registry, leases, provider backoff, or adapter state as part of doctor/report checks except for bounded non-destructive writability probes.
- Make stale thresholds configurable or reuse existing constants; do not hardcode contradictory TTLs if the project already defines them.
- Ensure all readiness details that may include paths, environment variables, tokens, headers, provider payloads, credentials, or command output pass through redaction before display or JSON serialization.
- Prefer adding narrow, behavior-locking tests before production edits when the existing behavior is not already covered.
- Keep failure messages actionable but concise; include remediation hints only where the project already has that convention or where the source plan requires it.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then modify the current `cpb doctor` and `cpb report` readiness paths, add focused tests, run verification, and write `deliverable-018.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid redacted JSON with structured readiness results and preserves existing non-JSON behavior.
- [ ] `cpb report --json` emits valid redacted JSON that includes the expanded readiness checks or readiness section expected by the existing report architecture.
- [ ] Readiness checks include Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Missing ACP adapter is reported with a clear check id/status/severity and covered by a test.
- [ ] Stale Hub state is reported with age/threshold context and covered by a test.
- [ ] Stale worker state is reported with age/threshold context and covered by a test.
- [ ] Provider rate-limit/backoff state is reported without clearing or mutating it and covered by a test.
- [ ] Rust unavailable is reported only when Rust runtime support is enabled and is covered by a test.
- [ ] JSON and text outputs redact secrets, tokens, credential-bearing URLs, sensitive headers, and provider payload fragments.
- [ ] Existing doctor/report behavior and exit semantics are preserved except where the promotion-readiness plan explicitly requires new readiness failures or warnings.
- [ ] No unrelated cleanup, broad refactor, dependency addition, or non-P0 implementation is included.
- [ ] Relevant tests pass, and the deliverable records exact verification commands and results.
- [ ] Code style remains consistent with existing project patterns.
