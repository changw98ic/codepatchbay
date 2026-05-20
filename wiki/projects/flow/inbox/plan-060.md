## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-060
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth for scope, wording, severity expectations, and any existing P0.1 constraints.
- Implement only P0.1 readiness coverage for `cpb doctor` / report generation. Do not start P0.2+, broader cleanup, unrelated CLI redesign, or migration work.
- Preserve existing human-readable output behavior and add `--json` as an additive machine-readable mode.
- Model readiness findings as structured checks with stable identifiers, status/severity, redacted detail, and remediation text so text and JSON outputs share one source of data.
- Add or adjust tests only around the readiness checks requested here, using project-local test patterns and dependency seams instead of editing fakes merely to mask production regressions.

### Rejected
- Rejected broad promotion-readiness implementation beyond P0.1 because the directive limits this handoff to the doctor/report readiness slice.
- Rejected changing existing command names or replacing existing report output because the task requires preserving current behavior.
- Rejected shelling out directly from tests without injectable command/runtime probes because missing tools, stale Hub state, and provider backoff must be testable deterministically.
- Rejected logging raw tokens, provider payloads, Hub paths containing secrets, environment dumps, or command stderr verbatim because readiness output must be redacted.

### Scope

**目标**: Expand `cpb doctor` and its readiness report path to cover the P0.1 promotion-readiness checks, including additive JSON output, redacted structured diagnostics, and regression tests for the required failure modes.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; consult before implementation and keep P0.1 boundaries exact.
- CLI command entry for `cpb doctor` — add or wire `--json` output without breaking existing text output.
- Readiness report/check module used by `cpb doctor` — centralize the requested checks and expose structured results consumed by both text and JSON renderers.
- Environment/runtime probe module(s) — add injectable probes for Node/npm, Git, ACP adapter, Rust runtime gating, Hub, registry, jobs/workers/leases, provider backoff, and disk space.
- Redaction utility or existing sanitizer — ensure all text and JSON diagnostics pass through the same redaction path.
- Existing doctor/report tests — extend coverage for success and failure cases while preserving existing assertions.
- New or adjusted tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when enabled.

**实现步骤**:
1. Read the promotion readiness plan and current `cpb doctor` / report code paths. Identify existing command parser, output renderer, probe helpers, Hub/registry storage APIs, provider backoff state, Rust runtime feature flag/config, and test harness conventions.
2. Define a narrow readiness result contract if one does not already exist: `id`, `label`, `status` (`pass`, `warn`, `fail`, `skip`), `severity`, redacted `details`, optional `remediation`, and optional structured `data`. Keep check IDs stable and specific.
3. Implement shared readiness checks:
   - Node and npm presence/version, using existing process execution helper if available.
   - Git presence/version.
   - ACP adapter presence, version detection, and smoke readiness. Missing adapter should produce a fail or warn according to the source plan, with remediation.
   - Rust runtime only when enabled by config/env/feature flag. If enabled and unavailable, report the required failure mode; if disabled, mark skipped without failing readiness.
   - Hub liveness and writability, including stale Hub detection.
   - Registry consistency between expected project/adapter/provider records and persisted registry state.
   - Stale jobs, workers, and leases using existing freshness/heartbeat semantics where available.
   - Provider backoff / rate-limit state with clear readiness warning and retry context.
   - Disk-space warning based on the project’s existing threshold conventions or the P0.1 plan threshold.
4. Add redaction at the result construction/rendering boundary. Redact secrets in env-like keys, tokens, credentials, provider auth values, user-specific sensitive fragments, and raw command/provider errors before they reach text output, JSON output, snapshots, logs, or thrown diagnostic messages.
5. Add `cpb doctor --json` output. It should emit valid JSON only, include an overall readiness status, a timestamp if the project already emits timestamps in reports, check results, and summary counts. Keep the default non-JSON output backward compatible except for additive readiness lines.
6. Wire the report path and `cpb doctor` through the same check runner so JSON, text, and any saved report do not drift. Keep existing public APIs intact; add adapters/wrappers only where needed.
7. Add focused tests using existing test style:
   - Missing ACP adapter produces the expected readiness finding and remediation.
   - Stale Hub is detected through liveness/writability or heartbeat state.
   - Stale worker is detected from heartbeat/lease age without requiring real time sleeps.
   - Provider rate limit/backoff produces the expected warn/fail readiness result and redacted retry detail.
   - Rust unavailable is reported only when Rust runtime is enabled, and skipped when disabled.
   - `--json` output is parseable, contains the requested checks, and contains no unredacted secret fixture values.
8. Run the smallest relevant tests first, then the project’s standard doctor/report test target and any lint/typecheck command required by the repo. Record exact commands and outcomes in `deliverable-060.md`.
9. Self-review the diff for scope creep: no unrelated cleanup, no fixture/fake edits solely to hide production changes, no behavior changes outside doctor/report readiness, and no raw secret exposure in test output.

**注意事项**:
- Keep the implementation scoped to P0.1. Do not implement unrelated promotion readiness must-haves, command UX changes, daemon changes, or registry migrations unless the source plan explicitly makes them prerequisites for this slice.
- Prefer existing command helpers, config readers, Hub clients, registry APIs, and test fixtures. Add seams only where the requested checks cannot be tested safely.
- Do not make tests depend on actual local Node/npm/Git/Rust/ACP installation state. Use injected probe results or existing fakes that represent the real workflow.
- Do not edit fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to force tests green after changing production behavior. If a fake no longer represents the real workflow, document the mismatch and add a purpose-built verification path.
- Ensure readiness checks degrade gracefully: unavailable optional components should be skipped when disabled, not hard-failed.
- JSON output must be suitable for automation: no prose banners, progress spinners, ANSI color codes, or mixed stderr/stdout diagnostic blobs in the JSON stream.

## Next-Action
Implement the P0.1 `cpb doctor` / report readiness expansion exactly as scoped above, run the relevant verification commands, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-060.md` with changed files, test evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] The implementation consults `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and stays limited to P0.1.
- [ ] `cpb doctor --json` emits parseable JSON with overall status, summary counts, and structured readiness check results.
- [ ] Existing default `cpb doctor` / report output remains backward compatible except for additive readiness information.
- [ ] Readiness covers Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, and disk-space warnings.
- [ ] Rust runtime unavailable is reported when Rust runtime is enabled and skipped or non-failing when disabled.
- [ ] Hub stale state, stale worker/lease/job state, missing ACP adapter, provider rate limit/backoff, and low disk space produce actionable readiness findings with correct severity per the source plan.
- [ ] All readiness details in text, JSON, logs, snapshots, and test fixtures are redacted for tokens, credentials, provider auth values, secret-like keys, and raw sensitive payloads.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, and JSON redaction/parseability.
- [ ] The changed code reuses existing project patterns and does not introduce new dependencies unless the source plan explicitly requires one.
- [ ] No unrelated cleanup, broad promotion-readiness work, fixture-only pass-through changes, or behavior changes outside the doctor/report readiness surface are included.
- [ ] Relevant lint, typecheck, and test commands pass, with exact evidence recorded in `deliverable-060.md`.
