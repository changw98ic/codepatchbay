## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-024
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task Title
Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only P0.6.
- Add one stable error taxonomy shared by existing CLI, API, Web UI, and event/job paths instead of duplicating string literals per surface.
- Each P0.6 condition must have a stable snake_case code, a named error class, and one human-readable public message.
- Preserve existing behavior at boundaries: keep current exit codes, HTTP statuses, event shapes, and UI flows unless the P0.6 plan explicitly requires a more stable representation.
- Redact provider details before serialization. Public payloads may include safe metadata such as provider name, HTTP status, retry-after, or request id, but must not include tokens, keys, authorization headers, raw secrets, or unfiltered provider response bodies.

### Rejected
- Broad cleanup of unrelated error handling | outside the P0.6 slice.
- New dependencies for error modeling or redaction | not needed for a stable taxonomy and increases release risk.
- Replacing every internal throw site in one pass | too broad; normalize at shared boundaries and update only the common P0.6 failure paths.
- Exposing raw provider errors for debugging convenience | violates the redacted provider detail requirement.
- Updating fake responders, fixtures, snapshots, or mocks only to make tests pass | preserve behavior unless a fake itself is the tested surface.

### Files
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm P0.6 wording before editing.
- Existing shared error module, or the smallest appropriate shared/core module if no taxonomy exists — add stable definitions, base class, P0.6 classes, serializers, and redaction helper.
- Existing CLI error handling/rendering entry point — render the shared public message and stable code while preserving current process behavior.
- Existing API error middleware/route helper — serialize stable code/message/details while preserving current HTTP semantics.
- Existing Web UI error normalization/display code — display human-readable messages from the shared taxonomy and avoid raw provider detail.
- Existing event/job/reconciliation emission code — emit stable error code/message and redacted details for event payloads.
- Existing tests nearest the touched modules — add or adjust focused coverage for common failures and provider detail redaction.

### Scope

**Goal**: Implement P0.6 stable, user-facing error classes and messages for all listed codes across CLI, API, Web UI, and event/job serialization without widening into unrelated cleanup.

**Required P0.6 codes and public messages**:
- `adapter_missing`: "No adapter is configured for this provider."
- `adapter_auth_failed`: "Adapter authentication failed. Check the provider credentials and try again."
- `provider_rate_limited`: "The provider rate limit was reached. Wait before retrying."
- `permission_denied`: "You do not have permission to perform this action."
- `secret_blocked`: "The request was blocked because it may expose a secret."
- `delete_blocked`: "Delete is blocked while protected resources or running work remain."
- `worktree_dirty`: "The worktree has uncommitted changes. Commit, stash, or clean them before continuing."
- `source_path_mismatch`: "The request source path does not match the project source path."
- `lease_stale`: "The operation lease is stale. Refresh the project state and retry."
- `event_log_corrupt`: "The event log could not be read safely."
- `job_reconciled`: "The job was reconciled from stored state. Refresh to see the current status."
- `project_lock_busy`: "Another operation holds the project lock. Retry after it completes."
- `version_mismatch`: "The request version does not match the current project version. Refresh and retry."
- `verdict_failed`: "The verification verdict failed. Review the reported failures before retrying."

**Implementation steps**:
1. Read the P0.6 section in the promotion readiness plan and search the repo for existing error classes, error-code constants, CLI renderers, API serializers, UI error adapters, event emission, provider adapter failures, project locks, leases, version checks, verdict handling, and current tests. Record the exact files touched in the deliverable.
2. Add or extend the shared error taxonomy with:
   - a base stable error type carrying `code`, `message`, optional safe `details`, optional `cause`, and existing boundary metadata if already used;
   - one named class per P0.6 code, using the exact stable code strings above;
   - a single registry or definition table so messages are not duplicated;
   - a serializer/normalizer that converts unknown or legacy errors into the closest stable error only at existing boundaries;
   - a provider-detail redaction helper used before CLI/API/UI/event serialization.
3. Update common P0.6 failure paths to throw or normalize to the new classes:
   - adapter lookup and adapter authentication failures;
   - provider rate-limit responses;
   - permission, secret, delete, dirty worktree, and source-path guards;
   - stale lease, corrupt event log, reconciled job, busy project lock, version mismatch, and verdict failure paths.
4. Wire presentation surfaces through the shared taxonomy:
   - CLI output includes stable code plus human-readable message and preserves current exit behavior;
   - API responses include stable code/message and only redacted safe details;
   - Web UI uses the stable public message instead of raw provider/internal detail;
   - event payloads include stable code/message and redacted details without leaking provider secrets.
5. Add focused tests near existing suites:
   - taxonomy test that all 14 P0.6 codes have classes and non-empty human messages;
   - CLI/API serialization tests for representative common failures: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `worktree_dirty`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`;
   - event serialization test for `event_log_corrupt` and `job_reconciled`;
   - provider redaction test proving tokens, API keys, authorization headers, raw secrets, and raw provider bodies are absent from CLI/API/UI/event-visible payloads.
6. Run the narrow targeted tests first, then the project-standard lint/typecheck/test commands required by the repo. If a full suite is too expensive or blocked, run the closest affected suites and document the gap honestly in the deliverable.

**Notes**:
- Keep the diff small and P0.6-only. Do not rename unrelated errors, restructure command handlers, change project lifecycle behavior, or refresh snapshots outside touched P0.6 behavior.
- Prefer existing utilities and serialization shapes. If the project already has a public error envelope, extend it rather than creating a parallel one.
- Do not change user-visible wording outside the listed P0.6 cases unless required to route those cases through the shared taxonomy.
- If the promotion readiness plan specifies message text that differs from the text above, use the promotion readiness plan and mention the difference in the deliverable.

## Next-Action
Implement the P0.6 stable error taxonomy and surface wiring described above, keep changes scoped to the listed failure modes, run focused and project-standard verification, then write `deliverable-024.md` with changed files, evidence, and any known verification gaps.

## Acceptance-Criteria
- [ ] The promotion readiness plan at `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read first and used as the source of truth for P0.6.
- [ ] All 14 P0.6 codes exist as stable exported error classes or the repo's equivalent public error constructors: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI, API, Web UI, and event/job surfaces render or serialize the stable code and a human-readable message for common P0.6 failures.
- [ ] Provider-originated details are redacted before reaching CLI/API/Web UI/events; tests prove secrets, tokens, authorization headers, and raw provider bodies are not exposed.
- [ ] Existing behavior is preserved except for the intended stabilization of P0.6 error classes/messages.
- [ ] Focused tests cover common failures and redacted provider detail.
- [ ] Project-standard lint/typecheck/test commands pass, or any blocked verification is documented with the reason and the closest successful targeted evidence.
- [ ] Code style follows existing project patterns and introduces no new dependencies.
