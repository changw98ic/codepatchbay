## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-093
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Source of truth is `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; implement only the P0.1 slice: expand `cpb doctor/report` readiness checks.
- Keep the implementation scoped to existing doctor/report command surfaces and existing diagnostic patterns; do not introduce unrelated cleanup, new dependencies, or changes outside readiness reporting behavior.
- Add `--json` output for machine-readable readiness results while preserving existing human-readable command behavior.
- Model every readiness check as redacted structured diagnostics with stable status, severity, message, evidence, and remediation fields where the existing code structure supports it.
- Cover required checks: Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and secret/path redaction.
- Add or adjust tests for these required scenarios: missing ACP adapter, stale Hub state, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — explicitly out of scope for this task.
- Rewriting the diagnostic framework — too risky and unnecessary; extend existing command/check abstractions.
- Adding new third-party dependencies — not requested and avoidable with standard Node/runtime APIs and existing project utilities.
- Making tests pass by editing fixtures, snapshots, fakes, or mock responders without checking intended production behavior — forbidden by workspace guidance unless the fake itself is the product bug.

### Scope

**Title**: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand `cpb doctor/report` readiness checks. Include `--json` output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

**目标**: Expand `cpb doctor` and related readiness report behavior so promotion blockers are detected consistently in both human and JSON output, without changing unrelated CLI behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use as source of truth for P0.1 requirements only.
- CLI entrypoint files for `cpb doctor` and `cpb report` — locate existing command definitions and add `--json` wiring where missing.
- Existing doctor/readiness diagnostic modules — extend checks for runtime tools, ACP adapter, Hub, registry, stale state, provider backoff, disk space, and redaction.
- Existing Hub/registry/provider state modules — reuse current APIs for liveness, writability, stale jobs/workers/leases, and backoff state instead of duplicating parsing logic.
- Existing test files for doctor/report/readiness commands — add focused coverage for required P0.1 scenarios.
- Test fixtures/fakes only when they intentionally model the new required real-world states; do not mutate fixtures merely to hide behavior changes.

**实现步骤**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and map each required readiness item to the existing `cpb doctor/report` implementation and tests.
   - Expected output: a local checklist in your working notes mapping each required item to the concrete source/test files you will touch.

2. Locate the current CLI command flow for `cpb doctor` and `cpb report`.
   - Preserve all existing default/human-readable behavior.
   - Add or complete `--json` support so structured output can be emitted without decorative text, progress spinners, ANSI formatting, or unredacted sensitive values.
   - If `report` already has structured output, align `doctor --json` with the same schema instead of creating a second incompatible shape.

3. Define or extend the readiness result shape.
   - Include enough structure for automation: check id, display name, status (`pass`, `warn`, `fail`, or existing equivalents), severity, message, remediation, and evidence/details.
   - Ensure the aggregate result exposes overall readiness and counts by status.
   - Keep field names stable and consistent across doctor/report output.

4. Implement runtime prerequisite checks.
   - Node/npm: detect availability and versions using existing process/spawn helpers or package manager utilities.
   - Git: detect availability and version.
   - ACP adapter: detect configured adapter presence, version if available, and a lightweight smoke-readiness signal that does not perform destructive operations.
   - Rust runtime: only check when Rust runtime support is enabled/configured; report unavailable Rust as a failure or warning according to existing severity conventions and the promotion plan.

5. Implement Hub and registry checks.
   - Hub liveness: verify the Hub can be reached or loaded through the existing Hub client/state path.
   - Hub writability: verify the configured Hub state/output location is writable using the least invasive existing mechanism.
   - Registry consistency: detect malformed, missing, or internally inconsistent registry entries using existing registry APIs.
   - Stale jobs/workers/leases: report stale state using current timestamp/TTL conventions; do not invent new TTL policy unless the promotion plan specifies one.

6. Implement provider and capacity checks.
   - Provider backoff/rate-limit: surface active backoff/rate-limit state as readiness warning/failure with remediation.
   - Disk-space warning: check relevant Hub/project/runtime paths and warn when below the project’s existing threshold; if no threshold exists, add a small named constant near the doctor implementation and document it in code only if not self-explanatory.

7. Apply redaction consistently.
   - Redact tokens, API keys, auth headers, credentials in URLs, home-directory-sensitive paths where existing redaction utilities require it, and provider-specific secrets before human or JSON output.
   - Reuse existing redaction utilities if present.
   - Add a test that proves JSON details/evidence are redacted, not only human output.

8. Add focused tests for the required P0.1 scenarios.
   - Missing ACP adapter: command reports the adapter check as failed and includes actionable remediation.
   - Stale Hub: stale Hub/job/lease condition is reported with the expected status and appears in JSON output.
   - Stale worker: stale worker is detected separately from stale jobs/leases if the current model distinguishes them.
   - Rate limit/provider backoff: active provider backoff is reported and redacted.
   - Rust unavailable: when Rust runtime is enabled and Rust cannot be found/smoked, the readiness output reports the expected non-pass status.
   - JSON output: validate parseable JSON, aggregate readiness fields, and absence of ANSI/decorative text.

9. Run the smallest relevant test subset first, then the normal project verification commands used for CLI readiness changes.
   - If a broader test suite fails for unrelated pre-existing reasons, capture exact evidence in the deliverable and keep the implementation scoped.

10. Self-review the diff before handoff.
   - Confirm no unrelated cleanup, dependency changes, broad refactors, or fixture churn were introduced.
   - Confirm existing human output remains compatible except for the added readiness checks.
   - Confirm all output paths containing secrets or credentials are redacted in both human and JSON modes.

**注意事项**:
- This is a P0.1-only implementation. Do not implement later promotion-readiness slices from the source plan.
- Keep checks deterministic in tests by injecting or faking clocks, filesystem state, command runners, provider state, and Hub state through existing seams.
- Prefer existing helpers over new abstractions; add a helper only if repeated readiness result construction or redaction would otherwise become error-prone.
- Avoid destructive smoke checks. Read-only or temporary-file checks are acceptable only when cleaned up and consistent with existing test/runtime patterns.
- Do not hide failures by weakening tests; update expected behavior only where the new P0.1 readiness requirement intentionally changes output.
- Use the Lore Commit Protocol if committing this work later.

## Next-Action
Implement the scoped P0.1 readiness expansion above, run relevant tests, and write the execution handoff to `wiki/projects/flow/outputs/deliverable-093.md` with changed files, evidence, risks, and any known verification gaps.

## Acceptance-Criteria
- [ ] `cpb doctor` supports `--json` output that is valid JSON, contains no ANSI/decorative text, and preserves existing human-readable behavior when `--json` is not used.
- [ ] `cpb report` readiness output is aligned with the doctor readiness schema or explicitly reuses the same readiness result model.
- [ ] Readiness checks include Node/npm availability/version, Git availability/version, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] ACP adapter missing or not smoke-ready produces a non-pass readiness result with actionable remediation.
- [ ] Rust unavailable produces the expected non-pass readiness result only when Rust runtime support is enabled.
- [ ] Stale Hub/job/worker/lease conditions are detected with deterministic tests and appear in JSON output.
- [ ] Active provider backoff/rate-limit state is detected and any provider secrets are redacted.
- [ ] Human and JSON readiness outputs redact secrets, credentials, tokens, sensitive URLs, and any sensitive evidence/details.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, JSON parseability, and redaction.
- [ ] All relevant tests pass, or any unrelated failures are documented with exact command output in `deliverable-093.md`.
- [ ] Diff remains scoped to P0.1 doctor/report readiness checks and related tests; no unrelated cleanup, broad refactors, or new dependencies are introduced.
- [ ] Code style matches the project’s existing CLI, diagnostic, and test patterns.
