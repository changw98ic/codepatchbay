## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-020-P0.6-promotion-readiness-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.
#
# Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth; before editing, read its P0.6 section and follow any naming, file, or behavioral constraints found there.
- Implement only P0.6 stable errors: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Use one canonical error catalog or equivalent existing central error module as the source for stable machine codes, stable class/type identifiers, default human-readable messages, redaction policy, and serialization fields.
- Preserve existing behavior and public flow semantics; convert only the surfaced error shape/message stability required by P0.6.
- Provider/raw diagnostic details must be redacted before reaching CLI output, API responses, Web UI views, and emitted events.

### Rejected
- Broad error-system redesign | P0.6 requires stable classes/messages for a fixed set of failures, not a new exception architecture.
- Unrelated cleanup or renaming | The readiness task explicitly requires scoped changes and behavior preservation.
- Per-surface hardcoded message copies | Duplicated strings make CLI/API/Web UI/events drift; prefer one catalog consumed by all surfaces or a thin adapter over an existing central helper.
- Snapshot or fixture churn solely to force tests green | Only adjust tests that assert the intended stable P0.6 behavior.

### Scope

**目标**: Implement the P0.6 promotion-readiness error contract so the listed failure codes have stable error classes and clear human-readable messages across CLI, API, Web UI, and event payloads, with tests covering common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 details before implementation.
- Existing central error/domain modules, if present — add or extend stable error class/catalog definitions for the fourteen required codes.
- Existing CLI error formatting files — route known P0.6 failures through the stable class/message formatter without changing successful command behavior.
- Existing API error serialization/handler files — expose stable machine code, class/type, message, and redacted detail fields for known failures.
- Existing Web UI error display/mapping files — display the catalog human-readable message for known failures while preserving current layout and UX behavior.
- Existing event emission/schema files — include stable error code/class/message and redacted detail in error-related events.
- Existing tests for CLI/API/Web UI/events — add or adjust focused cases for common P0.6 failures and redacted provider detail.

**实现步骤**:
1. Read the P0.6 section of the promotion readiness plan and identify the current error modules plus the four surface paths: CLI, API, Web UI, and event emission.
2. Inventory existing error handling for each required code and map each current failure source to the canonical P0.6 code: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
3. Add or extend a stable error catalog/class layer using existing project patterns. Each entry must define at minimum: stable code, stable class/type name, default human-readable message, retryability/status metadata if the project already models it, and a redaction rule for provider/raw details.
4. Wire CLI formatting to consume the stable error layer. Confirm common failures render the human-readable message and do not print provider tokens, secrets, auth headers, raw request bodies, or unredacted upstream payloads.
5. Wire API serialization to consume the same stable layer. Known failures should serialize consistently with existing API conventions while adding the stable code/class/message fields required by P0.6.
6. Wire Web UI error mapping to consume API/event stable fields or the same local catalog, depending on existing architecture. Keep the current visual behavior and only change unstable or unclear copy needed for P0.6.
7. Wire event payloads so error events include stable code/class/message and only redacted details. Preserve existing event names, ordering, and non-error payload fields unless the P0.6 source plan explicitly says otherwise.
8. Add focused tests for representative common failures across surfaces. At minimum cover `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `event_log_corrupt`, and `verdict_failed`, plus one serialization/round-trip case that proves every required P0.6 code is present in the catalog.
9. Add explicit redaction tests using provider detail containing realistic sensitive substrings such as API keys, bearer tokens, auth headers, request IDs mixed with secrets, and provider raw error bodies. Assert the stable message remains useful while secrets are absent from CLI/API/Web UI/event output.
10. Run the smallest targeted test set first, then the repository’s normal lint/typecheck/test command set expected for this area. Fix only regressions caused by the P0.6 changes.
11. Produce `deliverable-020.md` with changed files, the P0.6 source-of-truth notes used, verification commands and outputs, and any remaining risks.

**注意事项**:
- Keep the implementation narrowly scoped to P0.6; do not implement other promotion readiness items from the source plan.
- Do not introduce new dependencies.
- Prefer deletion or reuse of existing error helpers over creating parallel plumbing.
- Do not change successful CLI/API/Web UI/event behavior.
- Do not leak provider detail. Redaction must happen before details cross process, HTTP, UI, or event boundaries.
- If existing tests use fake providers or fixtures that no longer represent the real workflow, report the mismatch and add purpose-built verification instead of mutating fakes merely to pass.
- If the source plan conflicts with this handoff, follow the source plan for implementation details and document the conflict in the deliverable.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.6 as described above, run targeted and standard verification, then write `deliverable-020.md` for Codex review.

## Acceptance-Criteria
- [ ] The P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read and any implementation-specific constraints from it were followed.
- [ ] All fourteen required codes exist in one stable catalog/class layer: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Each required code has a stable error class/type identifier and a human-readable default message.
- [ ] CLI output for common failures uses the stable human-readable message and does not expose unredacted provider details.
- [ ] API error responses for common failures include stable code/class/message fields using existing response conventions and do not expose unredacted provider details.
- [ ] Web UI error display for common failures presents the stable human-readable message without exposing unredacted provider details.
- [ ] Error-related events include stable code/class/message fields and only redacted diagnostic details.
- [ ] Tests cover common failures including adapter/provider auth/rate limit, permission/secret/delete blocking, dirty worktree, corrupt event log, and failed verdict handling.
- [ ] Tests prove provider details are redacted across at least CLI/API/event surfaces, and Web UI redaction is covered if the UI has a dedicated rendering test harness.
- [ ] Existing behavior outside the P0.6 error contract is preserved.
- [ ] Targeted tests pass.
- [ ] Standard lint/typecheck/test commands for the touched areas pass, or any unavailable verification is explicitly documented in `deliverable-020.md`.
