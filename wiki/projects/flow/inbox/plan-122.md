## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-122
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.1 doctor/report readiness-check slice described there.
- Keep the implementation scoped to existing `cpb doctor` / `cpb report` readiness surfaces and their tests; do not add unrelated cleanup, new workflows, or broad CLI redesign.
- Add machine-readable `--json` output while preserving existing human-readable output and exit behavior unless the source plan explicitly says otherwise.
- Model readiness checks as structured results with severity/status/message/detail fields so human and JSON renderers share the same underlying facts.
- Redact secrets and sensitive paths/tokens in both human and JSON report paths before output or persisted report content.
- Prefer existing project utilities and test patterns for CLI execution, filesystem fixtures, Hub state, registry validation, provider/backoff state, and runtime detection.

### Rejected
- Rejected replacing the whole doctor/report implementation with a new framework; P0.1 asks for expanded checks, not a CLI rewrite.
- Rejected adding new runtime dependencies for environment probing or JSON rendering unless the repository already uses them; the slice should remain small and reversible.
- Rejected weakening or rewriting fake/mock tests just to make new behavior pass; tests should reflect intended real workflow, and stale/missing/rate-limit scenarios should be represented with purpose-built fixtures.
- Rejected broad promotion-readiness tasks outside P0.1, including unrelated packaging, onboarding, UI, documentation, or cleanup work.

### Scope

**目标**: Expand CPB doctor/report readiness checks for promotion readiness P0.1, with structured JSON output, comprehensive environment/runtime/Hub/registry/job/provider/disk diagnostics, redaction, and targeted regression tests.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read first and use only its P0.1 section as implementation authority.
- CLI entrypoint files that define `cpb doctor` and `cpb report` — Add or extend `--json` handling and preserve existing human output.
- Doctor/report readiness-check modules — Add structured checks for Node/npm, Git, ACP adapter, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- Existing Hub/registry/job/worker/lease/provider state modules — Reuse current state readers and validation helpers; add narrowly scoped helpers only when no existing helper fits.
- Existing redaction utility or report serialization module — Ensure all doctor/report output paths redact secrets consistently.
- Existing doctor/report test files — Add/adjust tests for JSON output and the required negative/readiness scenarios without changing unrelated test doubles.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify the current `cpb doctor` / `cpb report` implementation and tests.
2. Trace existing readiness result types, CLI option parsing, report serialization, redaction, Hub state, registry state, job/worker/lease state, provider backoff state, runtime detection, and disk-space helpers.
3. Introduce or extend a shared readiness result shape used by both `doctor` and `report`, with stable fields suitable for JSON and human rendering, including status/severity, check id, summary, details, remediation where existing style supports it, and redacted values only.
4. Add `--json` support to `cpb doctor` and the relevant `cpb report` readiness path. JSON output should be deterministic, valid JSON on stdout, free of human decoration, and should not expose unredacted secrets.
5. Implement Node/npm and Git checks using the existing command/probe style. Report missing binaries, version discovery failures, and version values when available. Preserve existing behavior for environments where probes are intentionally best-effort.
6. Implement ACP adapter readiness checks: presence, version discovery, and a minimal smoke-readiness check. Report missing adapter distinctly from adapter present but not smoke-ready. Do not require network or destructive side effects.
7. Implement Rust runtime readiness only when Rust execution is enabled by existing configuration/env/project settings. When enabled, report unavailable runtime as a readiness failure/warning according to the source plan; when disabled, report skipped/not-applicable without failing.
8. Implement Hub liveness and writability checks. Detect stale or unreachable Hub state, non-writable required directories/files, and report actionable diagnostics without mutating production state except for a safe temporary write probe if an existing project pattern supports one.
9. Implement registry consistency checks using existing registry readers. Detect missing, malformed, duplicate, dangling, or internally inconsistent registry entries required by the current project behavior.
10. Implement stale jobs/workers/leases checks using existing state timestamps and TTL/staleness rules. Preserve current lease semantics and avoid deleting or repairing stale state in doctor/report.
11. Implement provider backoff readiness reporting. Detect active rate-limit/backoff state and include provider, retry/backoff timing, and severity in redacted output.
12. Implement disk-space warnings for relevant project, Hub, cache, or runtime paths. Use existing threshold/config patterns if present; otherwise introduce conservative warning thresholds as constants near the readiness checks.
13. Ensure redaction is applied at the final output boundary and, where practical, before details enter serialized report structures. Cover tokens, API keys, authorization headers, secret-like env names, home-sensitive paths if existing redaction policy requires it, and provider payloads.
14. Add focused tests for the required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust unavailable when Rust is enabled, `--json` structure/validity, redaction, and preservation of existing human-output behavior.
15. Run the repository's relevant doctor/report test subset first, then the broader lint/typecheck/test commands normally used by this project. If any existing unrelated failures appear, document them with evidence rather than masking them.
16. Produce `deliverable-122.md` with changed files, implementation summary, exact test commands and outputs, risks, and any deviations from the P0.1 source plan.

**注意事项**:
- Keep changes scoped to P0.1. Do not implement other promotion-readiness P0/P1/P2 items from the source plan.
- Preserve existing behavior for current users: human output should remain readable and compatible; JSON output is additive unless the source plan requires otherwise.
- Do not broaden into unrelated cleanup, renames, formatting churn, dependency upgrades, or fixture rewrites.
- Do not modify fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to force green tests. Only add or adjust test fixtures when they directly model the new readiness scenarios.
- Prefer existing project patterns for CLI options, state inspection, command probing, redaction, error handling, and tests.
- Treat readiness checks as diagnostics: they should inspect and report, not auto-repair, delete stale state, acquire real leases, or perform destructive writes.
- Make JSON output stable enough for automation: deterministic key names, predictable status values, and no mixed human logging on stdout in `--json` mode.
- Be careful with exit codes. Preserve existing exit semantics unless the source plan defines stricter readiness failure behavior; document the chosen behavior in tests.

## Next-Action
Implement the scoped P0.1 doctor/report readiness expansion exactly as above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. After implementation and verification, write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-122.md` following the execute-to-review handoff protocol.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid deterministic JSON with readiness checks and no human decoration on stdout.
- [ ] The relevant `cpb report` readiness output includes the same expanded readiness facts or clearly shared check results, consistent with existing report semantics.
- [ ] Human-readable `cpb doctor` / `cpb report` output remains compatible with existing behavior while including the new readiness diagnostics.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime is reported as skipped/not-applicable when disabled and as unavailable when enabled but missing/unusable.
- [ ] Missing ACP adapter is reported distinctly from adapter version failure and adapter smoke-readiness failure.
- [ ] Stale Hub and stale worker conditions are detected without deleting or repairing state.
- [ ] Active provider rate-limit/backoff state is surfaced with redacted provider details and retry/backoff timing where available.
- [ ] All doctor/report output paths redact secrets and sensitive values in both human and JSON modes.
- [ ] Tests cover missing adapter, stale Hub, stale worker, rate limit/provider backoff, Rust unavailable when enabled, JSON validity/shape, and redaction.
- [ ] Existing behavior is preserved for normal ready-state doctor/report scenarios.
- [ ] Relevant lint, typecheck, and test commands pass, or unrelated pre-existing failures are documented with exact evidence in `deliverable-122.md`.
- [ ] No unrelated cleanup, dependency additions, fixture rewrites, or promotion-readiness work outside P0.1 is included.
