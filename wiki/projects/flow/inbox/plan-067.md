## Handoff: codex -> claude - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-067
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for P0.1. If this handoff and that document differ, the document wins and the deliverable must call out the difference.
- Implement only P0.1: readiness expansion for `cpb doctor` and `cpb report`. Do not implement other promotion-readiness items from the plan.
- Preserve existing human-readable command behavior by default. Add `--json` as an opt-in machine-readable output mode.
- Use the existing CLI command structure, test runner, fixtures, and helper patterns. Do not rewrite the CLI, introduce a new command framework, or add dependencies unless the source-of-truth plan explicitly requires it.
- Centralize readiness checks behind the existing doctor/report collection layer if one exists. If no shared layer exists, add the smallest shared helper that both commands can call.
- Return structured check results with stable fields suitable for JSON output: check id, title/label, status, severity, message, evidence/details, remediation when useful, duration when already measured, and an overall readiness status.
- Make readiness checks best-effort and bounded. External probes must have short timeouts, clear failure messages, and no destructive side effects.
- Apply redaction before any human or JSON output leaves the command boundary. Redaction must cover tokens, API keys, credentials in URLs, authorization headers, provider secrets, adapter args/env, and Hub connection strings.
- Add or adjust tests for the required P0.1 scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust is enabled.

### Rejected
- Broad cleanup/refactor across unrelated CLI, Hub, provider, or registry code - outside P0.1.
- Making JSON output the default - this would risk breaking existing users and scripts.
- Replacing existing readiness/test infrastructure - too broad and not required for promotion readiness.
- Treating disabled optional subsystems as failures - disabled Rust/runtime checks should report `skip` unless the source-of-truth plan says otherwise.
- Updating fake LLM responders, unrelated snapshots, or broad fixtures just to make tests pass - only update tests that directly model readiness behavior.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth for P0.1.
- Existing `cpb doctor` CLI registration/handler file - add `--json`, call expanded readiness collector, preserve human output.
- Existing `cpb report` CLI registration/handler file - add `--json`, include readiness checks in report output as required by P0.1, preserve current report behavior.
- Existing doctor/report readiness helper files - add shared result schema, check collection, status aggregation, timeouts, and redaction.
- Existing ACP adapter resolution/probe helper files - expose presence, version, and smoke-readiness checks without changing adapter runtime semantics.
- Existing Hub client/state helper files - expose liveness, writability, stale Hub, worker, job, and lease checks without mutating production state beyond safe temporary probes.
- Existing registry helper files - add consistency checks using current registry storage/schema.
- Existing provider state/backoff helper files - expose provider backoff/rate-limit readiness signals.
- Existing test files for CLI doctor/report/readiness - add focused coverage for JSON output, redaction, missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable.

Planner note: this planning phase was explicitly forbidden from executing terminal commands, so exact owner paths were not inspected here. Before editing, locate the existing files matching the ownership above and keep the diff limited to those current modules and their direct tests.

### Evidence
- Planning-only handoff created under the allowed path.
- No terminal commands were run in this planning phase, per instruction.
- Source-of-truth path and P0.1 requirements were supplied by the task prompt.

### Risks
- Exact command/helper/test file paths must be confirmed by the implementer before edits because this planner was not allowed to inspect the repository.
- ACP adapter smoke readiness may already have a protocol-specific probe. Prefer the existing protocol probe over inventing a synthetic handshake.
- Hub writability probes can accidentally create state if implemented naively. Use existing safe temp/probe APIs when available, and clean up any probe artifact.
- Stale thresholds for jobs/workers/leases and disk-space warning limits must come from the source-of-truth plan or existing config/constants. Do not hardcode conflicting values.
- JSON output shape should be stable but should not expose secrets. Redaction tests must exercise both human and JSON paths.

### Scope

**Goal**: Expand `cpb doctor` and `cpb report` readiness checks for P0.1 promotion readiness, with opt-in JSON output, comprehensive environment/runtime/Hub/provider/registry checks, redacted output, and focused tests.

**Implementation steps**:
1. Read the P0.1 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify the exact current `cpb doctor`, `cpb report`, readiness helper, Hub, registry, ACP adapter, provider, and test owner files. Record the actual paths in `deliverable-067.md`.
2. Map current behavior before editing: note the existing human output, exit-code behavior, and report format. Preserve these defaults unless the source-of-truth plan explicitly requires a change.
3. Add or extend a shared readiness result model used by both `doctor` and `report`. Use stable statuses such as `pass`, `warn`, `fail`, and `skip`; include enough detail for JSON consumers while keeping messages concise for human output.
4. Add `--json` parsing for `cpb doctor` and `cpb report`. JSON mode must emit valid JSON only, with no ANSI styling, no progress chatter, and no unredacted values. Human mode must remain the default.
5. Implement Node/npm and Git checks using existing process/runtime helpers where available. Node can come from the running process; npm and Git should be probed with bounded commands or existing tool-detection helpers. Missing required tools should produce readiness failures or warnings according to the source-of-truth plan.
6. Implement ACP adapter readiness checks: configured adapter presence, adapter version when available, and smoke readiness with the existing ACP adapter/protocol mechanism. Missing adapter must be covered by a test and must produce a clear failing readiness item.
7. Implement Rust runtime readiness only when Rust support is enabled by existing config/env/feature detection. When disabled, report `skip`. When enabled and unavailable, report the required warning/failure state and cover it with a Rust-unavailable test.
8. Implement Hub readiness checks: liveness, writability, stale Hub state, stale jobs, stale workers, and stale leases. Use existing Hub APIs/storage abstractions. Writability must use a safe probe and cleanup path. Add stale Hub and stale worker tests.
9. Implement registry consistency checks using existing registry storage/schema. Detect mismatches that matter for promotion readiness, such as missing referenced adapters/providers, duplicate or invalid registry entries, records pointing to stale Hub entities, and schema/version inconsistencies already recognized by the codebase.
10. Implement provider backoff/rate-limit readiness checks using existing provider state/backoff metadata. Report active backoff/rate-limit windows with retry timing when safely available. Add a rate-limit/backoff test.
11. Implement disk-space warnings for the workspace, Hub state, registry, and temp/cache locations used by readiness checks. Prefer existing free-space helpers; otherwise use the smallest platform-compatible implementation available in the current runtime. Use thresholds from the source-of-truth plan or existing config.
12. Add a central redaction pass around readiness output. Apply it before rendering human text and before serializing JSON. Add tests that prove secrets in env/config/provider/Hub/adapter details are masked.
13. Add or adjust focused tests only for this P0.1 slice. Required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, JSON output validity, and redaction. Keep tests deterministic by using existing fixtures/fakes for Hub/provider/registry state instead of changing unrelated fake LLM responders.
14. Run the repository's relevant verification commands after implementation: focused readiness/doctor/report tests first, then the standard lint/typecheck/test commands required by the project. Capture exact commands and results in `deliverable-067.md`.
15. Review the diff for scope creep before handoff. Remove unrelated cleanup, formatting churn, dependency changes, and behavior changes outside `cpb doctor`/`cpb report` readiness.

**Implementation constraints**:
- Use the promotion readiness plan file as the authority.
- Keep changes scoped to P0.1 readiness checks and directly required tests.
- Preserve existing behavior and output unless `--json` is explicitly requested or the source-of-truth plan requires a change.
- Do not broaden into unrelated cleanup or promotion-readiness items.
- Do not add dependencies without an explicit source-of-truth requirement.
- Do not edit fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to force passing tests after production behavior changes.

## Next-Action
Implement P0.1 exactly as scoped above. Locate the existing owner files, make the smallest production/test changes needed, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-067.md` with changed files, evidence, remaining risks, and any source-of-truth discrepancies.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid redacted JSON only, with stable readiness fields and no ANSI/progress text.
- [ ] `cpb report --json` emits valid redacted JSON only and includes the P0.1 readiness information required by the source-of-truth plan.
- [ ] Existing default human output and exit-code behavior for `cpb doctor` and `cpb report` are preserved unless the source-of-truth plan explicitly requires a change.
- [ ] Readiness coverage includes Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is detected with a clear failing readiness item and covered by a focused test.
- [ ] Stale Hub state is detected and covered by a focused test.
- [ ] Stale worker state is detected and covered by a focused test.
- [ ] Provider rate-limit/backoff state is detected and covered by a focused test.
- [ ] Rust unavailable while Rust support is enabled is detected and covered by a focused test; Rust disabled reports `skip` rather than failure.
- [ ] Redaction masks secrets in both human and JSON output, including tokens, API keys, credentials in URLs, provider secrets, adapter args/env, and Hub connection strings.
- [ ] Disk-space checks warn at the configured/source-of-truth threshold without crashing on unsupported platforms.
- [ ] Registry consistency checks report actionable failures/warnings without mutating registry data.
- [ ] Hub writability probing is safe, bounded, and cleans up any probe artifact.
- [ ] Focused readiness tests and the repository's standard lint/typecheck/test verification pass, with exact commands and outputs summarized in the deliverable.
- [ ] Diff is scoped to P0.1 production owner files and direct tests; unrelated cleanup, dependency changes, and broad refactors are absent.
