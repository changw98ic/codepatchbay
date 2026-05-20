## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-074
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling source for P0.1 and avoid implementing any other promotion-readiness items.
- Keep the change scoped to `cpb doctor` and `cpb report` readiness reporting plus direct supporting utilities/tests required by those commands.
- Preserve existing human-readable output and add `--json` as an additional machine-readable output mode rather than changing default CLI behavior.
- Model readiness as structured checks with stable IDs, severity, status, summary, remediation, evidence, and redacted metadata so both doctor and report can share the same facts.
- Redact secrets and sensitive paths/tokens at the readiness data boundary before rendering either text or JSON output.
- Add focused regression tests for the required P0.1 cases: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad cleanup of doctor/report internals beyond what is necessary for P0.1 | violates the instruction to keep this to the P0 slice.
- Changing existing default text output into JSON by default | would break existing user workflows and tests.
- Adding new third-party dependencies for readiness probing or JSON rendering | not required for this scoped change and increases promotion risk.
- Hiding failing checks behind best-effort logging only | promotion readiness must be visible and testable from CLI output.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for P0.1 only, with shared structured readiness data, `--json` output, redaction, required environment/runtime checks, Hub/registry/job/worker/lease health, provider backoff visibility, disk-space warnings, and targeted tests while preserving current behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read only; use as source of truth for P0.1 boundaries and wording.
- CLI entrypoint file(s) that define `cpb doctor` and `cpb report` — Add `--json` option handling and wire both commands to shared readiness collection/rendering without changing existing default behavior.
- Existing doctor/report readiness module(s), or a new narrow internal helper near them if no shared module exists — Implement the P0.1 readiness checks and result schema.
- Existing config/runtime detection module(s) — Reuse current mechanisms for detecting Node/npm, Git, ACP adapter, Rust enablement, Hub path/config, registry files, workers/jobs/leases, providers, and disk paths.
- Existing redaction/sanitization helper(s), or a new local helper only if none exists — Ensure readiness evidence and JSON output do not leak secrets.
- Existing doctor/report test files — Add or adjust tests for `--json`, missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.
- Existing test fixtures/factories for Hub state, registry, providers, workers, jobs, leases, and runtime executables — Extend only as needed to model the P0.1 scenarios.

**实现步骤**:
1. Read the promotion readiness plan and identify only the P0.1 doctor/report requirements. Record any exact expected terminology, severity, or command names from that document in implementation notes before editing.
2. Locate the existing `cpb doctor` and `cpb report` command implementations and their current tests. Confirm current text output snapshots/assertions so the default output can be preserved.
3. Define a shared readiness result shape if one does not already exist:
   - `id`: stable check ID such as `node`, `npm`, `git`, `acp.adapter`, `hub.liveness`, `registry.consistency`, `workers.stale`, `provider.backoff`, `disk.space`, `rust.runtime`.
   - `status`: `pass`, `warn`, `fail`, or `skip`.
   - `severity`: promotion-impact level compatible with existing doctor/report conventions.
   - `summary`: short human-readable result.
   - `remediation`: concrete next action when status is `warn` or `fail`.
   - `evidence`: redacted structured metadata used by JSON and optional text details.
4. Implement environment checks for Node/npm and Git:
   - Detect command presence.
   - Capture version when available.
   - Fail or warn consistently with current doctor conventions when missing or unusable.
   - Keep probes mockable so tests do not depend on the developer machine.
5. Implement ACP adapter readiness:
   - Check adapter presence at the configured or expected location.
   - Capture adapter version when available.
   - Run the existing lightest safe smoke-readiness path, such as version/help/handshake probe, without starting unrelated long-running work.
   - Report missing adapter as a failing readiness item with remediation.
6. Implement Rust runtime check only when Rust runtime is enabled by existing config/feature flag:
   - Skip with clear evidence when Rust runtime is disabled.
   - When enabled, check runtime availability/version.
   - Report unavailable Rust runtime as fail or warn according to the promotion plan and existing severity conventions.
7. Implement Hub liveness and writability checks:
   - Reuse existing Hub path/config resolution.
   - Verify the Hub appears live using current heartbeat/socket/state conventions.
   - Verify required write paths are writable with a safe temporary write/delete or existing non-mutating writability helper.
   - Detect stale Hub state separately from hard missing/unwritable state.
8. Implement registry consistency checks:
   - Validate registered projects, adapters, providers, and Hub references against existing registry schema/loader behavior.
   - Detect missing referenced paths, duplicate IDs, malformed entries, or dangling active pointers.
   - Do not invent new registry policy beyond P0.1 readiness needs.
9. Implement stale jobs, workers, and leases checks:
   - Use existing TTL/heartbeat/lease-expiry constants where present.
   - Flag stale workers separately from stale jobs and stale leases so tests can assert exact failure IDs.
   - Include redacted IDs/counts/timestamps in evidence.
10. Implement provider backoff/rate-limit readiness:
   - Detect provider state indicating active rate limit, cooldown, or exponential backoff.
   - Report as warning unless the promotion plan requires failure.
   - Include provider name/type only after redaction and avoid leaking API keys, account IDs, raw request URLs, or tokens.
11. Implement disk-space warning:
   - Check free space for relevant CPB/Hub/data/cache paths using an existing filesystem utility when available.
   - Warn below the project’s existing threshold or the threshold specified by the promotion readiness plan.
   - Keep the check mockable and deterministic in tests.
12. Add `--json` output to both `cpb doctor` and `cpb report`:
   - Output valid JSON with command name, generated timestamp if existing conventions require it, overall status, check list, and redacted evidence.
   - Preserve existing exit-code behavior unless P0.1 explicitly defines a new behavior.
   - Ensure text output remains the default and existing text tests continue passing with only intentional additions.
13. Add or update tests:
   - `cpb doctor --json` returns parseable JSON with expected top-level shape and redacted evidence.
   - Missing ACP adapter produces a deterministic failing check.
   - Stale Hub state is detected and reported.
   - Stale worker state is detected and reported independently from stale jobs/leases.
   - Provider rate limit/backoff produces the expected warning/failure and redacts sensitive provider data.
   - Rust unavailable is reported only when Rust runtime is enabled; disabled Rust runtime is skipped.
   - Existing default doctor/report behavior remains compatible.
14. Run the repository’s relevant test commands for the modified package(s), plus lint/typecheck if they are standard for this project. If the full suite is too expensive, run the focused doctor/report tests first and document any broader verification gap.
15. Prepare `deliverable-074.md` with changed files, evidence, remaining risks, and any promotion-plan details that were intentionally left out because they are not part of P0.1.

**注意事项**:
- Implement only P0.1 from the promotion readiness plan. Do not start P0.2/P1 work even if nearby code makes it tempting.
- Preserve current command names, defaults, exit-code semantics, and existing text output unless tests or the source plan prove a change is required.
- Keep probes deterministic and testable through dependency injection, fixtures, or existing mock boundaries.
- Do not edit fake/mock tests or fixtures merely to hide production behavior changes; update them only to represent the new P0.1 readiness scenarios.
- Do not introduce new dependencies.
- Redaction is mandatory for both text and JSON. Treat environment variables, tokens, API keys, auth headers, home-directory-sensitive paths, provider account identifiers, sockets, and raw URLs as sensitive unless the existing project redaction policy says otherwise.

### Evidence
- Planning-only handoff created under the requested inbox path.
- No terminal commands were run during planning per the task constraint.

### Risks
- The exact contents of the promotion readiness plan must be read before implementation; if it defines severities, thresholds, field names, or exit-code changes, those specifics override this handoff.
- Existing doctor/report architecture may already have a readiness schema; prefer extending it over adding a parallel model.
- Hub staleness and provider backoff may depend on runtime state formats that tests must fixture precisely to avoid machine-dependent behavior.

## Next-Action
Implement P0.1 exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Run the focused and standard project verification commands, then write `deliverable-074.md` with changed files, test evidence, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` preserves existing default human-readable behavior and supports `--json`.
- [ ] `cpb report` preserves existing default human-readable behavior and supports `--json`.
- [ ] JSON output is valid, stable enough for tests, includes an overall status plus individual readiness checks, and contains no unredacted secrets.
- [ ] Readiness checks include Node/npm presence/version and Git presence/version.
- [ ] Readiness checks include ACP adapter presence, version when available, and smoke-readiness status.
- [ ] Rust runtime readiness is checked when enabled and skipped when disabled.
- [ ] Hub liveness and writability are checked, including stale Hub detection.
- [ ] Registry consistency is checked for malformed, duplicate, missing, or dangling entries relevant to P0.1.
- [ ] Stale jobs, workers, and leases are detected and reported with distinct check IDs or evidence.
- [ ] Provider rate-limit/backoff state is detected and reported without leaking provider secrets.
- [ ] Disk-space warnings are emitted for relevant CPB/Hub paths below the configured threshold.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable.
- [ ] Existing behavior outside P0.1 remains unchanged.
- [ ] Relevant lint/typecheck/tests pass, or any unavailable verification is explicitly documented in `deliverable-074.md`.
