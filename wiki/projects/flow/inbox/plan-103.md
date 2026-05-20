## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-103
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Introduce or consolidate a stable, centrally defined error taxonomy for these exact codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each error must expose a stable machine-readable code/class and a human-readable message suitable for CLI, API responses, Web UI display, and event payloads.
- Provider-originated details must be redacted before they reach user-facing output, API payloads, logs/events, or tests that snapshot error detail.
- Preserve existing behavior and compatibility wherever possible: map current failure paths to the new stable errors instead of rewriting workflows.

### Rejected
- Broad promotion-readiness work outside P0.6 — explicitly out of scope for this task.
- Large refactors of command, API, Web UI, adapter, project, lease, lock, or event systems — unnecessary unless a tiny compatibility shim is required to emit the stable error.
- Introducing new dependencies — not needed for a stable taxonomy, message mapping, or redaction tests.
- Editing fake/mock responders merely to force tests to pass — only adjust test doubles if they are asserting the new public error contract or redaction behavior.

### Scope

**目标**: Implement the P0.6 promotion-readiness slice by adding stable error classes/codes and consistent human-readable messages across CLI, API, Web UI, and event output for the listed failure modes, with focused tests for common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm the P0.6 requirements before editing.
- Existing error/domain modules under the application source tree — add or extend the central stable error definitions and message mapping.
- Existing adapter/provider failure handling files — map missing adapter, auth failure, rate limit, and provider detail handling to stable errors.
- Existing permission/secret/delete/worktree/source-path/lease/event-log/job/project-lock/version/verdict failure handling files — map current failures to the new stable errors without changing successful behavior.
- Existing CLI rendering code — ensure command failures render the stable code/class and human-readable message consistently.
- Existing API error serialization code — ensure API responses include the stable error code/class and safe message while preserving existing response shape where practical.
- Existing Web UI error display/client error parsing code — ensure UI-visible failures can display the stable human-readable message and rely on the stable code.
- Existing event/log emission code — ensure event payloads carry stable, non-secret error metadata and redacted detail.
- Existing tests for CLI/API/Web UI/events and provider/adapters — add or adjust tests covering common failure paths and redaction.

**实现步骤**:
1. Read the P0.6 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify any exact wording, status expectations, or existing acceptance criteria that must be preserved.
2. Locate the current error creation, serialization, CLI rendering, API error response, UI error parsing, and event emission paths. Prefer the existing central error abstraction if present.
3. Add a stable error definition for each required code with:
   - stable code/class identifier,
   - human-readable default message,
   - safe public detail field if the project already has one,
   - no raw provider/secret detail in public fields.
4. Wire existing failure branches to the stable errors:
   - adapter/provider: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`;
   - authorization/safety: `permission_denied`, `secret_blocked`, `delete_blocked`;
   - project/workspace state: `worktree_dirty`, `source_path_mismatch`, `project_lock_busy`, `version_mismatch`;
   - runtime/recovery: `lease_stale`, `event_log_corrupt`, `job_reconciled`, `verdict_failed`.
5. Normalize CLI output through the existing formatter so common failures show the stable code/class and a useful human-readable message without leaking provider secrets or tokens.
6. Normalize API serialization through the existing response/error middleware so clients receive stable machine-readable error metadata and the safe message. Keep existing HTTP status choices unless P0.6 explicitly requires different statuses.
7. Normalize Web UI handling through the existing client-side error parser/display path so UI copy comes from the stable message contract instead of ad hoc raw exception strings.
8. Normalize event/log payloads so emitted failure events carry stable error code/class, safe message, and redacted provider detail. Preserve existing event names and schemas unless a narrowly scoped additive field is required.
9. Add focused regression tests:
   - one representative CLI failure verifies stable code/message;
   - one representative API failure verifies stable code/message and compatible response shape;
   - one Web UI/client parsing test verifies display of the stable human-readable message;
   - one event emission test verifies stable error metadata;
   - provider/auth/rate-limit tests verify raw provider detail is redacted.
10. Run the project’s relevant lint/typecheck/test commands, then the broader test command normally used for this repository if feasible. Record exact commands and results in `deliverable-103.md`.
11. Self-review the diff for scope creep. Remove unrelated cleanup, formatting churn, or opportunistic refactors before handoff.

**注意事项**:
- Keep the change scoped to the P0.6 error contract. Do not implement other P0 items from the promotion readiness plan.
- Preserve current successful behavior and existing public shapes where possible; prefer additive stable fields or compatibility mapping over breaking changes.
- Do not expose provider raw messages that may include tokens, keys, URLs with credentials, request bodies, headers, stack traces, or account identifiers.
- Do not snapshot raw secrets in tests. Use purpose-built fake provider detail containing obvious secret-like values and assert the redacted output does not contain them.
- Keep messages human-readable and actionable, but avoid embedding volatile provider text.
- If an existing failure path already has a stable error code, reuse it only if it exactly matches the required P0.6 code; otherwise add an explicit mapping.
- If multiple surfaces share serialization helpers, test the shared helper plus at least one end-to-end surface to avoid duplicate brittle tests.
- If any required code cannot be reached by an existing test harness, document the gap in the deliverable and add the closest unit-level coverage instead of broadening the implementation.

## Next-Action
Implement the scoped P0.6 stable error taxonomy and surface wiring exactly as described above, run focused and relevant project tests, then write `deliverable-103.md` with changed files, verification output, remaining risks, and any source-of-truth details from the promotion readiness plan that affected implementation.

## Acceptance-Criteria
- [ ] The implementation reads and follows the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] Stable error definitions exist for exactly these required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI failures for representative common cases render the stable code/class and a human-readable message.
- [ ] API failures for representative common cases serialize the stable code/class and safe human-readable message while preserving existing compatible response behavior.
- [ ] Web UI/client error handling can display the stable human-readable message for representative failures.
- [ ] Event/log payloads include stable error metadata and do not leak raw provider detail.
- [ ] Tests cover common failure paths across CLI/API/Web UI/events at the appropriate level for the existing project architecture.
- [ ] Tests prove provider-originated auth/rate-limit/detail strings are redacted and that secret-like values do not appear in public output.
- [ ] Existing successful behavior remains unchanged except for the intended stable error metadata/message additions.
- [ ] No unrelated cleanup, new dependency, or broader promotion-readiness work is included.
- [ ] Relevant lint, typecheck, and tests pass, or any infeasible command is documented with the exact reason in `deliverable-103.md`.
