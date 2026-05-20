## Handoff: codex -> claude

# Plan-062: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-062
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the governing source for P0.1; implement only the cpb doctor/report readiness-check slice named in this handoff.
- Preserve current command behavior and add structured `--json` output without removing or reshaping existing human-readable output unless existing tests prove that output is already intended to change.
- Keep implementation scoped to the existing cpb doctor/report command path, its existing readiness-check helpers, and directly related tests.
- Model readiness checks as explicit status objects with severity, stable machine-readable codes, human text, evidence fields, and redacted diagnostic details.
- Redact secrets, tokens, credentials, Authorization headers, provider keys, and local sensitive values before both terminal/report output and `--json` serialization.
- Add or adjust focused tests for the required P0.1 cases: missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Rejected broad promotion-readiness cleanup outside P0.1 because the task explicitly limits the implementation to this P0 slice.
- Rejected replacing existing doctor/report internals wholesale because preserving current behavior and keeping diffs reviewable is required.
- Rejected adding new dependencies for command output, disk checks, or process probing unless the repository already has an established dependency/helper that covers the need.
- Rejected tests that only snapshot a large report blob because the required readiness states need targeted assertions on status codes, severity, and redaction.

### Scope

**目标**: Expand cpb doctor/report readiness checks for P0.1 only, preserving existing behavior while adding JSON output, deeper environment/runtime/hub/registry/job/provider/disk diagnostics, redaction, and focused regression coverage.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the exact P0.1 requirements before editing.
- Existing cpb doctor/report command entrypoint file(s) — add/route `--json` output and ensure the new checks are included in both doctor and report flows where the current command architecture expects readiness diagnostics.
- Existing readiness/check helper module(s) — add Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk-space, and redaction checks using current project patterns.
- Existing report/serialization formatter module(s) — add stable JSON schema support and redacted diagnostic serialization without regressing human-readable output.
- Existing test files for cpb doctor/report/readiness checks — add focused coverage for required scenarios and update only assertions that directly reflect the new P0.1 behavior.
- Test fixture/helper files only if they are already the established way to simulate adapters, Hub state, workers, provider backoff, Rust runtime availability, or disk state.

**实现步骤**:
1. Read the promotion readiness plan and identify only the P0.1 doctor/report readiness requirements. Do not begin unrelated P0/P1/P2 items even if nearby text suggests them.
2. Locate the existing cpb doctor/report command entrypoint, readiness-check aggregation path, output formatter, and related tests. Record the smallest set of files needed for this slice.
3. Define the readiness-result shape in the existing style. It should support human output and `--json`, with fields equivalent to `code`, `status` or `severity`, `message`, optional `details`, and optional remediation/evidence where current patterns support it.
4. Add `--json` handling to cpb doctor/report. The flag should emit deterministic machine-readable JSON, include all readiness checks, set an appropriate command exit status using the existing severity policy, and avoid interleaving non-JSON logs on stdout.
5. Implement or extend checks for Node/npm and Git availability/version. Use existing command/probe helpers where available, avoid brittle shell parsing, and mark missing/unusable tools with stable warning/error codes.
6. Implement ACP adapter readiness checks: presence, version discoverability, and smoke readiness. Missing adapter must produce a targeted failure/warning, not a generic process error.
7. Implement Rust runtime readiness only when the Rust runtime is enabled by existing configuration/env. When enabled and unavailable, report the required unavailable state; when disabled, report skipped/not-applicable without failing.
8. Implement Hub liveness and writability checks using existing Hub/client/storage abstractions. Distinguish unreachable/stale Hub from non-writable Hub state with stable codes and redacted details.
9. Implement registry consistency checks using existing registry loaders. Detect mismatched, missing, duplicate, or unreadable entries according to current registry invariants without changing registry semantics.
10. Implement stale jobs, stale workers, and stale leases checks using existing state locations and timeout/heartbeat conventions. Prefer current lease/job age thresholds; if the plan defines thresholds, use those exact thresholds.
11. Implement provider backoff/readiness checks. Surface rate-limit/backoff state with retry timing if already available, but redact provider identifiers or keys and avoid calling live providers in normal doctor tests.
12. Add disk-space warnings using existing filesystem/stat helpers. Report low space as warning unless the source plan specifies a stricter severity; include path and free-space information after redaction/normalization.
13. Apply redaction centrally so both human output and JSON output are protected. Cover common secret patterns and project-specific provider/adapter tokens already represented in config or env handling.
14. Add focused tests for missing adapter, stale Hub, stale worker, provider rate-limit/backoff, and Rust unavailable. Include at least one `--json` assertion that validates parseable JSON, stable codes/statuses, and absence of unredacted secrets.
15. Run the relevant targeted tests first, then the repository's standard lint/typecheck/test commands for this area. If full-suite execution is too expensive, run the established scoped command plus document the gap in the deliverable.
16. Produce `deliverable-062.md` with changed files, implementation summary, exact test commands/output, and any remaining risks.

**注意事项**:
- Do not broaden into unrelated promotion readiness items, cleanup, command redesign, UI work, or documentation rewrites outside direct test/update needs.
- Preserve existing human-readable doctor/report behavior unless a test or the P0.1 plan requires a precise addition.
- Do not modify fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to make tests pass after production behavior changes. Only adjust test doubles when they are the explicit mechanism for simulating the P0.1 readiness states.
- Keep readiness codes stable and specific enough for automation, for example `adapter.missing`, `hub.stale`, `worker.stale`, `provider.backoff`, and `rust.unavailable`, adapted to the repository's existing naming style.
- Ensure JSON output is valid JSON on stdout and diagnostic logs, if any, go through the project's established stderr/log path.
- Redaction is mandatory; no tokens, provider keys, Authorization values, credentials, or secret-bearing URLs should appear in human output, JSON output, failures, or test snapshots.

### Evidence
- Planning-only phase. No terminal commands were executed and no source files were inspected because this handoff was constrained to write only under `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/`.

### Risks
- The exact source-of-truth plan contents were not read in this planning phase due to the explicit no-terminal-command constraint. Claude must read `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` before implementation and treat it as authoritative where it is more specific than this handoff.
- Existing command architecture may split `doctor` and `report` across separate modules; keep additions shared where current patterns already support sharing, but avoid inventing broad new abstractions.
- Some readiness checks may depend on time-based thresholds. Use existing thresholds or the source plan's explicit values to avoid flaky stale-state tests.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 for cpb doctor/report readiness checks according to the scoped steps above, run targeted and standard verification, then write `deliverable-062.md` for Codex review.

## Acceptance-Criteria
- [ ] The implementation is limited to P0.1 cpb doctor/report readiness checks from the promotion readiness plan and does not include unrelated cleanup or broader readiness work.
- [ ] cpb doctor/report supports `--json` output that is valid JSON, deterministic enough for tests, includes the readiness checks, and does not mix non-JSON logs into stdout.
- [ ] Readiness checks include Node/npm availability/version, Git availability/version, ACP adapter presence/version/smoke readiness, Rust runtime readiness when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] Missing ACP adapter produces a specific readiness result with stable code/status and a useful message.
- [ ] Stale Hub state produces a specific readiness result and does not masquerade as a generic Hub failure.
- [ ] Stale worker state produces a specific readiness result using the repository's existing heartbeat/age conventions.
- [ ] Provider rate-limit/backoff state is surfaced with a stable readiness result and no secret leakage.
- [ ] Rust unavailable is reported when the Rust runtime is enabled, and Rust checks are skipped or non-failing when the Rust runtime is disabled according to existing configuration semantics.
- [ ] Human-readable output preserves existing behavior while adding the new readiness information.
- [ ] Redaction applies to human output, JSON output, thrown errors included in reports, and tests; no provider keys, tokens, credentials, Authorization headers, or secret-bearing URLs appear unredacted.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust unavailable, and at least one `--json` output path.
- [ ] Relevant lint/typecheck/test commands pass, or any unavoidable verification gap is documented with the exact reason in `deliverable-062.md`.
- [ ] `deliverable-062.md` lists changed files, simplifications/scope controls, test evidence, and remaining risks.
