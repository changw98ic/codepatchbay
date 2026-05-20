## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-124 P0.6 stable error classes and human-readable messages from promotion readiness must-haves
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Introduce or consolidate a single stable error contract used by CLI, API responses, Web UI display state, and event payloads.
- Each P0.6 failure must expose a stable machine-readable code and class plus a human-readable message.
- Provider-originated details must be redacted before they reach CLI output, API bodies, Web UI copy, event logs, or test snapshots.
- Preserve existing behavior except where current errors are unstable, unclear, or leak provider detail.

### Rejected
- Broad error-system cleanup outside P0.6 | The directive explicitly says not to broaden into unrelated cleanup.
- Changing unrelated command, job, adapter, worktree, locking, verdict, or event-log behavior | P0.6 is an error contract and messaging slice, not a behavior rewrite.
- Adding new dependencies for error modeling or redaction | Existing project patterns should be enough and the scope must remain small.
- Testing every possible call path exhaustively | Add focused coverage for common failures and representative surface propagation instead.

### Scope

**目标**: Implement the P0.6 promotion-readiness slice by adding stable error classes/codes and human-readable messages for the listed failures, then verify they propagate consistently through CLI, API, Web UI, and events without leaking provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Source-of-truth reference only; do not edit.
- Existing shared error module or the closest current equivalent — Add the stable error class hierarchy, error-code registry, message map, redaction helper, and serialization helpers.
- Existing adapter/provider error handling files — Map adapter missing/auth/rate-limit/provider-detail failures into the stable error contract.
- Existing permission, secret, delete, worktree, source-path, lease, event-log, reconciliation, project-lock, version, and verdict failure sites — Replace ad hoc errors at P0.6 call sites with stable error instances or stable serialization.
- Existing CLI error rendering tests and CLI command tests — Assert stable codes/classes, human-readable messages, and redacted provider detail for common failures.
- Existing API route/controller tests — Assert response status, stable error payload shape, messages, and redaction for representative failures.
- Existing Web UI error-display tests — Assert user-facing messages and stable error identifiers are shown or available without provider secrets.
- Existing event/event-log tests — Assert emitted event payloads contain stable codes/classes and redacted details for representative failures.

**实现步骤**:
1. Read the P0.6 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and locate the current error-handling patterns for CLI, API, Web UI, and event payloads.
   - Expected output: a short implementation note in the deliverable identifying the existing modules touched and confirming no non-P0.6 scope was added.
2. Add a stable error registry covering exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
   - Expected output: one canonical location defines each code, stable class/category, default HTTP/CLI severity if the project already models that, and default human-readable message.
3. Implement or extend a shared error class/serialization helper so every listed failure can be represented with:
   - stable `code`
   - stable class/category
   - human-readable `message`
   - optional safe details
   - redacted provider details
   - cause/internal diagnostics retained only where existing internal logging patterns already allow it
4. Map existing P0.6 failure sites onto the stable error contract without changing successful paths.
   - Adapter failures: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`.
   - Safety failures: `permission_denied`, `secret_blocked`, `delete_blocked`.
   - Workspace/source failures: `worktree_dirty`, `source_path_mismatch`.
   - Coordination/state failures: `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`.
   - Verdict failure: `verdict_failed`.
5. Update CLI rendering to prefer the stable human-readable message and expose the stable code/class in the same style existing CLI errors use.
   - Keep exit-code behavior unchanged unless the existing project already derives exit codes from error classes.
6. Update API serialization to return the stable error payload shape for P0.6 failures.
   - Preserve existing status codes where they already match behavior.
   - If a P0.6 error currently has no stable status, choose the narrowest existing convention and document it in the deliverable.
7. Update Web UI error consumption to display the human-readable message while preserving existing visual states and user flows.
   - Do not redesign UI, rename unrelated labels, or introduce new UI components unless the current error display cannot render the stable message.
8. Update event emission/event-log serialization so P0.6 failure events carry stable `code` and class/category, with safe detail only.
   - Ensure corrupt event-log handling reports `event_log_corrupt` without throwing an unrelated parse or filesystem error through user-facing surfaces.
9. Add/adjust focused tests before or alongside implementation for common failures:
   - Missing adapter maps to `adapter_missing`.
   - Adapter/provider authentication maps to `adapter_auth_failed`.
   - Provider rate limit maps to `provider_rate_limited`.
   - Permission failure maps to `permission_denied`.
   - Secret-blocked path maps to `secret_blocked`.
   - Dirty worktree maps to `worktree_dirty`.
   - Project lock contention maps to `project_lock_busy`.
   - Version mismatch maps to `version_mismatch`.
   - Verdict failure maps to `verdict_failed`.
   - At least one API, CLI, Web UI, and event test verifies stable message/code propagation.
10. Add explicit redaction tests for provider detail.
   - Include representative sensitive values such as tokens, API keys, authorization headers, provider request IDs if classified sensitive by existing policy, and raw provider error bodies.
   - Assert sensitive raw values do not appear in CLI output, API JSON, Web UI rendered text, event payloads, logs under test, or snapshots.
11. Run the existing project verification commands appropriate for this slice.
   - Expected minimum: targeted unit/integration tests for changed areas plus lint/typecheck if the project exposes standard commands.
   - Do not update fake/mock responders, fixtures, snapshots, or test doubles merely to hide production behavior changes; only adjust them when they model the new stable error contract intentionally.
12. Write `deliverable-124.md` after implementation with changed files, tests run, command output summaries, remaining risks, and confirmation that no unrelated cleanup was included.

**注意事项**:
- Keep the code diff small and reversible.
- Prefer existing project helpers, serializers, UI components, and test utilities.
- Do not introduce new dependencies.
- Do not rename public fields unless compatibility requires a wrapper or alias.
- Do not remove existing diagnostic logging unless it leaks secrets to user-facing surfaces or event payloads.
- If a provider exposes useful non-sensitive diagnostics, keep them only in an explicitly safe detail field.
- If an existing test double no longer represents the intended real workflow, report the mismatch in the deliverable rather than editing fakes just to make tests pass.

## Next-Action
Implement only P0.6 from the promotion readiness plan. Add the stable error contract, map the listed failure cases across CLI/API/Web UI/events, add focused tests including redacted provider-detail assertions, run verification, and write `deliverable-124.md` for Codex review.

## Acceptance-Criteria
- [ ] The implementation covers exactly these stable error codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each listed error has a stable class/category and a human-readable message from a canonical source.
- [ ] CLI output for representative P0.6 failures includes the stable code/class in the existing CLI style and a human-readable message.
- [ ] API responses for representative P0.6 failures include the stable error payload shape, message, and safe details only.
- [ ] Web UI displays human-readable messages for representative P0.6 failures without changing unrelated UI behavior.
- [ ] Event payloads/log entries for representative P0.6 failures include stable code/class and no raw provider-sensitive detail.
- [ ] Provider/auth/rate-limit failure tests prove raw provider details are redacted across at least CLI, API, and event serialization; include Web UI redaction if that surface renders provider errors directly.
- [ ] Existing successful-path behavior is preserved.
- [ ] No unrelated cleanup, dependency changes, or broad refactors are included.
- [ ] Targeted tests for changed areas pass.
- [ ] Lint/typecheck/static analysis pass when available in the project.
