## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-046
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before making implementation edits.
- Implement only P0.1: expanded `cpb doctor` / readiness-report checks and their tests.
- Preserve existing human-readable doctor/report behavior while adding machine-readable `--json` output.
- Model readiness as structured check results with stable identifiers, severities, statuses, redacted details, and remediation messages so text and JSON output share the same underlying data.
- Keep checks best-effort and non-destructive: diagnostics must report readiness problems without mutating Hub, registry, provider, adapter, job, worker, or lease state.
- Add tests for the explicitly required failure modes: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad cleanup of doctor/report internals outside the P0.1 readiness surface — rejected because the task requires scoped must-have implementation only.
- Replacing existing text output with JSON-only output — rejected because existing behavior must be preserved.
- Shelling out directly from tests to real Node/npm/Git/Rust/adapter binaries — rejected because tests must be deterministic and should use injectable probes/fakes around existing command-runner or environment-detection seams.
- Emitting raw environment variables, tokens, paths with embedded secrets, provider headers, adapter command lines, or Hub payloads in reports — rejected because readiness output must be redacted.

### Scope

**目标**: Expand `cpb doctor` / report promotion-readiness checks for P0.1 only, adding JSON output, required runtime/HUB/provider/registry/staleness/disk diagnostics, redaction, and targeted tests while preserving existing behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; do not modify.
- CLI entrypoint file(s) that define `cpb doctor` and readiness/report commands — add `--json` parsing and route output through the shared readiness result model.
- Existing doctor/readiness implementation module(s) — add or extend check collection for Node/npm, Git, ACP adapter, optional Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- Existing Hub/registry/job/worker/lease/provider helper modules — reuse existing APIs where possible; only add narrow read-only helpers if there is no current seam for liveness, writability probe, staleness, or backoff state.
- Existing test files for doctor/report CLI behavior — adjust expected output only where necessary for the new checks while preserving prior assertions.
- New or existing focused doctor/readiness test file(s) — add deterministic tests for missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable.

**实现步骤**:
1. Read the source-of-truth promotion readiness plan and identify the exact P0.1 requirements, terminology, expected severities, and any existing command names; do not implement P0.2+ items.
2. Locate current `cpb doctor` / report command wiring, output formatting, and tests. Record the smallest existing seam for adding structured check results without changing unrelated command behavior.
3. Introduce or extend a readiness check result shape with stable fields such as `id`, `label`, `status`, `severity`, `summary`, `details`, and `remediation`. Ensure all user-controlled or secret-bearing detail fields pass through the project’s existing redaction helper, or add a narrow redaction helper if none exists.
4. Add `--json` support to the relevant doctor/report command path. JSON output should serialize the same readiness results used by text output, include an overall status, and avoid ANSI/control formatting. Existing non-JSON output must remain human-readable and compatible with current tests except for intentional added checks.
5. Add environment/tooling checks for Node/npm and Git. Use existing version/probe utilities if available; otherwise add injectable read-only probes that return installed/missing/version/error states without hardcoding local-machine assumptions.
6. Add ACP adapter readiness checks covering presence, version discovery when supported, and a smoke-readiness probe. Treat missing or failed smoke readiness as actionable readiness failures, with redacted command/output details.
7. Add Rust runtime readiness only when the Rust runtime is enabled by existing config/env/project settings. When enabled, report missing/unavailable Rust runtime as a failure or warning according to the source plan; when disabled, do not fail readiness.
8. Add Hub readiness checks for liveness and writability using existing Hub APIs where possible. The writability check must be non-destructive or clean up any temporary probe it creates. Detect and report stale Hub state without treating a healthy inactive Hub as stale unless existing state timestamps exceed the project’s staleness threshold.
9. Add registry consistency checks that compare registered projects/workers/jobs/leases against existing Hub or registry sources of truth. Report mismatches, orphaned entries, corrupt records, or inconsistent identifiers with redacted paths/values where needed.
10. Add stale jobs/workers/leases checks using existing timestamp/heartbeat/TTL conventions. Report stale workers separately from stale jobs and stale leases so remediation is specific.
11. Add provider backoff/rate-limit readiness checks. Surface active backoff, recent rate-limit state, retry-after timing, and provider identity in redacted form; do not perform live provider calls solely for doctor readiness unless an existing cheap probe already exists.
12. Add disk-space warnings for relevant workspace, Hub, cache, registry, and temp directories. Use project-standard thresholds from the source plan if specified; otherwise choose conservative warning-only thresholds and document them in code/tests.
13. Update tests with fakes/injected probes for all new checks. Required coverage must include missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when enabled. Include at least one `--json` test that proves valid JSON, stable status fields, and redaction of secrets.
14. Run the project’s relevant test suite and formatting/lint/type checks. If a broad suite is expensive, run focused doctor/report tests first, then the standard verification commands expected by the repo. Capture exact commands and results in `deliverable-046.md`.

**注意事项**:
- Do not broaden into unrelated cleanup, dependency upgrades, command renames, snapshot churn, or behavior changes outside P0.1.
- Do not modify fake/mock tests merely to hide changed production behavior. Only update or add fakes to represent the new readiness scenarios.
- Prefer existing project helpers for command execution, config loading, Hub access, registry reads, redaction, logging, and JSON formatting.
- Every new readiness check should degrade gracefully: unexpected probe errors should become structured readiness findings, not uncaught crashes, unless the existing command contract intentionally fails hard.
- Preserve exit-code semantics unless the source plan explicitly requires new behavior. If adding failure exit codes for `--json`, keep them aligned with existing doctor/report conventions.
- Keep user-facing remediation concrete and short: what is missing/stale/backing off and what command or state should be checked next.
- Ensure JSON output never contains ANSI color codes, stack traces by default, provider tokens, adapter credentials, raw authorization headers, or unredacted secret-like environment values.

## Next-Action
Implement the scoped P0.1 readiness expansion exactly as described above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then modify only the doctor/report readiness surface and focused tests. After implementation and verification, write `deliverable-046.md` with changed files, test commands, results, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` / report readiness checks include Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] A `--json` mode exists for the relevant doctor/report command and emits valid machine-readable readiness output with stable check identifiers, statuses, severities, details/remediation, and an overall status.
- [ ] Existing non-JSON doctor/report behavior is preserved except for intentional additional readiness findings.
- [ ] ACP adapter checks report missing adapter, version/probe failure, and smoke-readiness failure without leaking secrets.
- [ ] Rust runtime readiness is checked only when Rust runtime is enabled, and unavailable Rust is reported by a deterministic test.
- [ ] Hub liveness and writability are checked through non-destructive or cleaned-up probes, and stale Hub state is covered by a deterministic test.
- [ ] Registry consistency and stale jobs/workers/leases are reported as separate actionable readiness checks, with a deterministic stale-worker test.
- [ ] Provider backoff/rate-limit state is surfaced without making unnecessary live provider calls, and rate-limit/backoff is covered by a deterministic test.
- [ ] Disk-space warnings cover the relevant project/Hub/cache/registry/temp storage locations using source-plan thresholds or conservative documented defaults.
- [ ] Readiness text and JSON output redact tokens, authorization headers, secret-like environment values, and sensitive payload fields; at least one test proves redaction.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, and JSON output.
- [ ] All relevant tests and standard lint/typecheck/static checks pass, or any skipped/unavailable verification is explicitly documented with reason in `deliverable-046.md`.
- [ ] Changes remain scoped to P0.1 and do not include unrelated cleanup or broader promotion-readiness work.
