# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-042-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Introduce or consolidate one stable error catalog that maps each required code to a stable class/category, default human-readable message, redaction policy, and transport-safe serialized shape.
- Preserve existing behavior and existing error control flow; wrap, normalize, or serialize errors at boundaries instead of broadening into unrelated cleanup.
- Required stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- CLI/API/Web UI/events must use the same stable code and human-readable message source, with provider details redacted before display, API response serialization, UI rendering, and event emission.
- Tests should cover representative common failures across boundary surfaces plus redacted provider detail, not every possible internal throw site.

### Rejected
- Broad refactors of error handling outside the listed P0.6 codes | violates the scoped P0 slice.
- Snapshot-only verification | does not prove stable codes, messages, and redaction behavior across transports.
- Duplicating message strings separately in CLI, API, UI, and events | risks drift and unstable user-facing behavior.
- Exposing raw provider errors in logs/events/API payloads to aid debugging | conflicts with the explicit redacted provider detail requirement.

### Scope

**目标**: Implement P0.6 stable error classes and human-readable messages for the listed error codes across CLI, API, Web UI, and event payloads, with focused tests for common failures and provider-detail redaction.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the P0.6 requirement.
- Existing shared error/domain module, or a new narrowly scoped shared module if none exists — define stable error classes/catalog, message lookup, serialization, and redaction behavior.
- Existing CLI error handling/output files — normalize known failures to stable codes and catalog messages without changing command semantics.
- Existing API route/handler error serialization files — return stable error shape and redacted messages/details for known failures.
- Existing Web UI error display files — render stable human-readable messages from API/event error payloads.
- Existing event/log emission files — include stable codes and redacted detail for known failures.
- Existing tests near the touched CLI/API/UI/event modules — add or adjust focused regression coverage for common failures and provider-detail redaction.

**实现步骤**:
1. Read the P0.6 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify current error handling surfaces with the smallest relevant search scope: shared errors, CLI boundaries, API response serialization, Web UI error rendering, and event emission.
2. Locate the existing error type, result, or serialization pattern. Reuse it if present. If no shared pattern exists, add a small shared error catalog with:
   - stable `code`
   - stable `class` or equivalent category/type
   - default human-readable `message`
   - optional `status`/severity mapping where existing transports already need it
   - `toPublicError`/serializer helper that redacts provider details by default
3. Add explicit definitions for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. Wire common internal failures to the stable catalog at boundary points:
   - adapter discovery/auth/rate-limit failures -> `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`
   - access/secret/delete/worktree/source checks -> `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`
   - lease/event/reconciliation/lock/version/verdict failures -> corresponding stable codes
5. Update CLI output to display the catalog human-readable message and stable code where the CLI already reports structured errors. Do not change success output, exit-code semantics, command names, or argument parsing unless tests prove the current boundary cannot expose the stable error otherwise.
6. Update API error payloads to include the stable code and message while preserving existing response status semantics. Ensure raw provider messages, tokens, URLs with credentials, request IDs, headers, and stack traces are not returned in public payloads.
7. Update Web UI error rendering to consume the stable API/event error shape and show the catalog message. Keep existing layout and interaction behavior unchanged.
8. Update event emission for failed/reconciled/blocked states to include the stable error code and public message. Keep any private diagnostic detail out of persisted or client-visible event payloads unless an existing private diagnostics channel already exists and is explicitly redacted.
9. Add focused regression tests:
   - shared catalog/serializer returns expected code/message for all required codes
   - provider auth/rate-limit detail is redacted in public serialization
   - at least one CLI common failure emits the stable code/message
   - at least one API common failure returns the stable code/message and redacts provider detail
   - at least one Web UI rendering path displays the stable message from a structured error
   - at least one event emission path includes the stable code/message for a blocked or reconciled failure
10. Run the smallest relevant test set first, then the project’s normal test/lint/typecheck commands required by local practice. If any unrelated failures appear, record them in the deliverable with evidence and do not mask them by editing mocks/fixtures outside the P0.6 scope.
11. Produce `wiki/projects/flow/outputs/deliverable-042.md` with changed files, evidence, remaining risks, and any verification gaps.

**注意事项**:
- Keep changes scoped to P0.6. Do not implement other promotion-readiness plan items.
- Do not rename existing public APIs, routes, commands, event names, or UI concepts unless absolutely required for stable error serialization.
- Do not edit fake/mock tests, snapshots, fixtures, or test doubles merely to force tests to pass after production changes. Update fake/test-double assets only if they directly model the P0.6 stable error contract.
- Prefer a single source of truth for codes/messages. Avoid per-surface message copies.
- Redaction must happen before data crosses CLI/API/UI/event public boundaries.
- Provider detail may be summarized generically, but raw provider response bodies, secrets, tokens, credentialed URLs, headers, stack traces, and untrusted diagnostic blobs must not appear in public output.
- Preserve existing behavior for unknown errors by mapping them through the existing fallback path, or to an existing generic error if one already exists. Do not invent broad new fallback behavior unless the current boundary requires it.

## Next-Action
Implement only the P0.6 stable error classes/messages slice described above, using the promotion readiness plan as the source of truth. Keep the diff scoped, add focused regression tests, run relevant verification, then write `wiki/projects/flow/outputs/deliverable-042.md`.

## Acceptance-Criteria
- [ ] The implementation defines stable public error entries for all required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a human-readable message from a shared source of truth.
- [ ] CLI common failure output uses the stable code/message without changing unrelated command behavior.
- [ ] API common failure responses include the stable code/message and preserve existing status semantics where applicable.
- [ ] Web UI error rendering displays the stable human-readable message from structured API/event errors.
- [ ] Event payloads for relevant failures include stable code/message and do not expose raw provider details.
- [ ] Provider detail is redacted in public serialization, including raw response bodies, secrets/tokens, credentialed URLs, headers, stack traces, and untrusted diagnostic blobs.
- [ ] Focused tests cover the shared catalog/serializer, common CLI/API/UI/event failures, and redacted provider detail.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup or promotion-readiness items are included.
- [ ] Relevant lint/typecheck/test commands pass, or any pre-existing/unrelated failures are documented with evidence in `deliverable-042.md`.
