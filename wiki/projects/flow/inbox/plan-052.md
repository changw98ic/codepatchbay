## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-052
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan Title
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand `cpb doctor/report` readiness checks with JSON output, runtime/tool checks, Hub/registry/job readiness, provider backoff, disk-space warnings, redaction, and focused tests.

### Decided
- Treat P0.1 as the only implementation scope. Do not start any P0.2+ work from the promotion readiness plan.
- Preserve existing human-readable `cpb doctor` and `cpb report` behavior by default; add machine-readable `--json` output without replacing current text output.
- Implement readiness as structured check results first, then render those results into text and JSON. This keeps `doctor` and `report` consistent without duplicating readiness logic.
- JSON output must be deterministic, redacted, and stable enough for automation. Include an overall status plus individual checks with `id`, `status`, `severity`, `message`, and optional sanitized `details`.
- Severity/status semantics should be explicit:
  - `pass`: readiness requirement satisfied.
  - `warn`: degraded or risky but not blocking local operation.
  - `fail`: required readiness dependency missing, stale, unavailable, inconsistent, or unwritable.
  - `skip`: check intentionally not run because the related feature/runtime is disabled.
- Runtime/tool checks must cover Node, npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when the Rust path is enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- Redaction must apply to both text and JSON outputs before content is printed or serialized.
- Tests must include at minimum: missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust enabled but unavailable.

### Rejected
- Broad cleanup of the CLI/reporting architecture is rejected because the task requires only the P0.1 promotion-readiness slice.
- Adding new runtime dependencies is rejected unless an already-present package is required by the existing CLI/test stack.
- Replacing current text output with JSON-only output is rejected because existing behavior must be preserved.
- Editing fixtures, fakes, or mocks only to hide failures is rejected; adjust tests to describe the intended real readiness behavior.
- Implementing speculative promotion-readiness checks not named in P0.1 is rejected to keep the change scoped and reviewable.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm the P0.1 wording before editing code.
- Existing `cpb doctor` command module — add/route `--json`, consume shared readiness results, preserve default text output.
- Existing `cpb report` command/report module — include the same readiness results in report output and support JSON where the command currently accepts output-format options or where P0.1 requires it.
- Existing readiness/diagnostics/service modules used by the CLI — add the concrete checks listed in P0.1 using existing Hub, registry, provider, adapter, filesystem, and runtime utilities.
- Existing redaction utility module, or the nearest current sanitizer used by reports/logs — extend/reuse it so all readiness output is sanitized.
- Existing test files for doctor/report/diagnostics/readiness — add focused coverage for JSON shape and the required P0.1 failure/warning scenarios.
- If the exact file names differ, edit only the current modules that own these responsibilities; do not introduce parallel command paths.

### Scope

**目标**: Implement P0.1 from the promotion readiness plan by expanding `cpb doctor/report` readiness diagnostics while preserving current behavior and keeping all changes limited to readiness/reporting and their tests.

**涉及文件**:
- Current `cpb doctor` CLI owner — parse `--json`, call shared readiness collector, render existing text output from structured results.
- Current `cpb report` owner — surface readiness results in reports and expose JSON output in the command path required by P0.1.
- Current Hub client/status module — verify Hub liveness and that required Hub storage/state is writable.
- Current registry module — validate registry consistency and report orphaned/missing/mismatched entries without mutating registry state.
- Current job/worker/lease state module — detect stale jobs, stale workers, and stale leases using existing TTL/staleness rules or constants.
- Current provider/backoff module — report active provider backoff/rate-limit readiness as a warning or failure according to existing semantics.
- Current ACP adapter resolution module — verify adapter presence, version discoverability, and a smoke-readiness path that does not perform destructive work.
- Current runtime/tool detection module — check Node, npm, Git, disk space, and Rust availability when Rust runtime support is enabled.
- Current redaction/sanitization module — ensure paths, tokens, credentials, provider keys, headers, env values, Hub URLs with credentials, and command output are redacted before display.
- Current doctor/report test modules — cover both text preservation and JSON readiness output with the P0.1 scenarios.

**实现步骤**:
1. Re-read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and copy only the P0.1 readiness requirements into the implementation checklist. Do not implement unrelated promotion-readiness tasks.
2. Locate the existing `cpb doctor` and `cpb report` command owners and their tests. Identify the current output contract before editing so existing human-readable behavior remains intact.
3. Introduce or extend a shared readiness result model in the existing diagnostics/readiness area. Use a compact structure with `id`, `label`, `status`, `severity`, `message`, `details`, and optional `remediation`. Keep it serializable without custom JSON hacks.
4. Add a shared readiness collector that runs independent checks and returns a complete result set even when some checks fail. Individual check failures should become readiness results, not uncaught command crashes, unless the current command already treats that condition as fatal.
5. Implement tool/runtime checks:
   - Node presence and version.
   - npm presence and version.
   - Git presence and version.
   - Disk-space warning for the project/Hub state location using the existing threshold style if one exists; otherwise choose a conservative warning threshold and document it in the check message.
   - Rust runtime check only when the relevant Rust feature/config/runtime path is enabled; return `skip` when disabled and `fail` or `warn` when enabled but unavailable according to the existing runtime expectations.
6. Implement ACP adapter readiness:
   - Check adapter presence using the current adapter resolution mechanism.
   - Report adapter version when available.
   - Add a smoke-readiness check that proves the adapter can be resolved/invoked or initialized without performing destructive work.
   - Missing adapter must produce a deterministic JSON result with a stable `id`.
7. Implement Hub readiness:
   - Check Hub liveness through the existing Hub client/status path.
   - Check Hub writability by using the safest existing non-destructive write/probe mechanism. If no probe helper exists, add a bounded temporary probe that cleans up after itself.
   - Report stale Hub state as a readiness failure/warning based on current semantics; do not mutate or repair Hub state during doctor/report.
8. Implement registry and lifecycle readiness:
   - Validate registry consistency using current registry indexes/manifests.
   - Detect stale jobs, stale workers, and stale leases with the existing TTL or heartbeat constants.
   - Include counts and sanitized identifiers in `details`, not raw sensitive payloads.
9. Implement provider readiness:
   - Surface active provider backoff/rate-limit state from the current provider/backoff store.
   - Report rate-limited providers with enough sanitized detail for diagnosis: provider name, retry-after/backoff-until when available, and severity.
10. Implement redaction as a final output gate:
   - Route both text rendering and JSON serialization through the existing sanitizer or a single shared redaction helper.
   - Add redaction tests that prove secrets are removed from readiness messages/details, including token-like strings and credential-bearing URLs.
11. Wire `cpb doctor --json`:
   - Output only JSON to stdout in JSON mode.
   - Preserve existing text output when `--json` is not passed.
   - Set exit code using the command's current convention where possible; if no convention exists, fail when any `fail` readiness result exists and succeed for `pass`/`warn`/`skip`.
12. Wire `cpb report` readiness output:
   - Include the expanded readiness section in the report.
   - If `cpb report` already has JSON or format options, include the same structured readiness data there.
   - If P0.1 expects `cpb report --json`, add it consistently with `doctor --json` while preserving existing default report output.
13. Add/adjust tests before finalizing:
   - Missing ACP adapter produces a failed readiness result and valid `--json`.
   - Stale Hub state is reported deterministically.
   - Stale worker is reported with sanitized details.
   - Provider rate limit/backoff is surfaced with the expected severity.
   - Rust enabled but unavailable is reported; Rust disabled is skipped.
   - Text output still contains the existing key sections/phrasing expected by current tests.
   - JSON output is parseable and contains no unredacted secrets.
14. Run the repository's relevant test commands after implementation, including focused doctor/report tests and the normal lint/type/test gate used by this project. Capture exact command output in `deliverable-052.md`.
15. Self-review the diff against the P0.1 checklist. Remove unrelated cleanup, formatting churn, speculative checks, or broad refactors before handoff.

**注意事项**:
- Keep changes scoped to readiness/reporting behavior and tests.
- Do not broaden into unrelated promotion readiness items.
- Do not silently repair Hub, registry, job, worker, or lease state from doctor/report; this task is diagnostic/reporting only.
- Do not leak credentials, tokens, auth headers, provider keys, raw env values, or credential-bearing URLs in either text or JSON.
- Prefer existing helpers for command execution, version detection, Hub access, registry reads, backoff reads, and redaction.
- If a check depends on optional configuration, report `skip` when disabled instead of failing.
- Keep JSON field names stable and simple; tests should assert the contract without overfitting to incidental wording.

## Next-Action
Implement the scoped P0.1 readiness expansion exactly as described above. After coding, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-052.md` with changed files, test evidence, any rejected alternatives, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits parseable JSON with overall readiness status and individual sanitized check results.
- [ ] Existing default `cpb doctor` text output remains available and does not regress existing behavior.
- [ ] `cpb report` includes the expanded readiness checks and exposes structured JSON readiness data where required by the current report command/output contract.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence, ACP adapter version, ACP adapter smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Rust runtime readiness returns `skip` when the Rust path is disabled and reports unavailable Rust only when the Rust path is enabled.
- [ ] Hub, registry, job, worker, lease, and provider checks are diagnostic only and do not mutate state except for a safe temporary writability probe that cleans up after itself.
- [ ] Text and JSON outputs redact secrets, tokens, auth headers, provider keys, sensitive env values, and credential-bearing URLs.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust enabled but unavailable.
- [ ] Tests cover JSON parseability and redaction for readiness output.
- [ ] Existing doctor/report tests either pass unchanged or are adjusted only to reflect the intended P0.1 behavior.
- [ ] Focused doctor/report tests pass.
- [ ] Project lint/type/test verification required by this repository passes, or any unavailable command is explicitly documented with the reason in `deliverable-052.md`.
- [ ] The final diff contains no unrelated cleanup, formatting churn, dependency additions, or P0.2+ implementation.
