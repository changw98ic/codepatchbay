# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-088-P0.6-stable-error-classes-and-messages
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for P0.6 and do not implement any adjacent readiness items.
- Add or extend a single canonical error taxonomy for the required stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Each stable error must expose a machine-stable code, an appropriate error class/type, a human-readable message, and redacted provider/detail metadata suitable for CLI, API, Web UI, and event surfaces.
- Preserve existing behavior and public response shapes where possible; add stable fields/messages without changing successful flows or broadening unrelated cleanup.
- Tests should cover common failure mappings and explicitly verify provider detail redaction so secrets, tokens, raw credentials, and sensitive provider payloads do not leak.

### Rejected
- Implementing other P0/P1 readiness items from the promotion plan: outside this task's scope.
- Renaming unrelated errors or rewriting broad error plumbing: unnecessary blast radius for P0.6.
- Updating fake/mock responders merely to force tests to pass after production behavior changes: prohibited unless the fake itself is the subject of the test.
- Adding new dependencies for error formatting/redaction: avoid unless an existing project dependency already provides the needed behavior.

### Scope

**目标**: Implement P0.6 only: stable error classes and human-readable messages across CLI/API/Web UI/events for the listed error codes, with scoped tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read-only source of truth for P0.6 requirements and boundaries.
- Error taxonomy/module files discovered in the repo, likely under source paths for core/server/shared error handling — Add or extend canonical stable error classes, codes, message registry, and redaction helpers.
- CLI error rendering files discovered in the repo — Map canonical stable errors to human-readable CLI output without changing successful command behavior.
- API route/middleware/error response files discovered in the repo — Ensure API responses include stable codes and safe human-readable messages.
- Web UI error display/state files discovered in the repo — Ensure surfaced failures use the canonical human-readable message and stable code where the UI already displays errors.
- Event logging/emission files discovered in the repo — Ensure emitted failure/reconciliation events carry stable codes and redacted details.
- Existing tests near the touched modules — Add or adjust focused tests for common failures, cross-surface mappings, and provider detail redaction.

**实现步骤**:
1. Read the promotion readiness plan and isolate the exact P0.6 acceptance language. Record any P0.6-specific constraints in the deliverable evidence; do not act on unrelated plan items.
2. Locate existing error classes, code enums, message formatters, API error serializers, CLI renderers, Web UI error display paths, event emitters, and redaction utilities. Prefer existing patterns over new abstractions.
3. Introduce or complete the canonical stable error taxonomy for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, define a deterministic human-readable default message. Keep messages actionable but generic enough to avoid leaking provider internals. Preserve existing specific context only after passing it through the project redaction path.
5. Connect canonical errors to CLI rendering so common failures display the stable human-readable message and, where the CLI already shows structured error data, the stable code. Avoid changing command success output.
6. Connect canonical errors to API serialization so failing responses expose the stable code and safe message consistently. Preserve status codes and response fields unless P0.6 explicitly requires adding stable fields.
7. Connect canonical errors to Web UI error rendering/state so existing UI error surfaces can display the stable message for the listed codes. Keep UI changes minimal and avoid unrelated styling or flow changes.
8. Connect canonical errors to event logging/emission so failure/reconciliation events include stable codes and redacted details. Include `job_reconciled` as a stable reconciliation event/error classification without converting successful reconciliation behavior into a failure.
9. Add or adjust focused tests for common failure cases across the existing test layers. At minimum cover representative CLI/API/event mapping, Web UI mapping if a test harness already exists, and redaction of provider details for `adapter_auth_failed` and `provider_rate_limited`.
10. Run the project's relevant verification commands for the touched areas, such as targeted unit tests first, then broader lint/typecheck/test commands if available and reasonably scoped. Capture exact commands and outcomes in `deliverable-088.md`.

**注意事项**:
- Keep changes scoped to P0.6. Do not perform unrelated cleanup, formatting sweeps, dependency upgrades, or architectural rewrites.
- Do not remove existing error details that callers may rely on; add stable code/message fields or normalize through existing serializers.
- Redaction must happen before provider details reach CLI output, API JSON, Web UI state, or event payloads.
- Human-readable messages should be stable enough for tests and documentation; avoid embedding volatile provider text directly in default messages.
- Preserve existing status-code semantics: authorization failures, permission denials, rate limits, conflict/lock/version mismatches, corrupt logs, and blocked destructive actions should keep their current HTTP/CLI behavior unless the promotion plan says otherwise.
- If an existing fake/mock test conflicts with real intended behavior, report the mismatch and validate via a real or purpose-built path instead of weakening production behavior.

## Next-Action
Implement the scoped P0.6 changes above, run focused and relevant broader verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-088.md` with changed files, evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The promotion readiness plan is read and P0.6 is treated as the sole implementation scope.
- [ ] All required stable codes exist in the canonical taxonomy: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable error class/type and deterministic human-readable message.
- [ ] CLI common failure output uses the stable human-readable message and preserves existing success output.
- [ ] API failure responses expose stable codes and safe messages while preserving existing status-code semantics.
- [ ] Web UI error surfaces display or consume the stable messages for the listed codes without unrelated UI redesign.
- [ ] Event payloads/logging for the listed failures include stable codes and redacted detail.
- [ ] Provider detail is redacted before reaching CLI/API/Web UI/events, with tests proving sensitive provider data is not exposed.
- [ ] Tests cover common failures, including representative adapter, permission/blocked action, worktree/source mismatch, lock/version, event log corruption, reconciliation, and verdict failure paths.
- [ ] Relevant lint/typecheck/test verification passes, or any failures are documented as pre-existing/unrelated with evidence.
- [ ] Changed files remain scoped to P0.6 and preserve existing behavior outside the required stable error additions.
