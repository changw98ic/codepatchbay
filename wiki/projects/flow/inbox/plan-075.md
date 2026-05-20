## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-075 / P0.6 promotion readiness error taxonomy
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Before editing production code, re-read its P0.6 section and follow it over any inference in this handoff.
- Scope is exactly P0.6. Do not implement adjacent promotion-readiness items, schema migrations unrelated to these codes, broad UI redesign, logging cleanup, adapter rewrites, or generalized error framework work beyond what is required to expose the listed errors consistently.
- Prefer extending the existing error/result/response/event primitives if they exist. Create a new central error catalog only if no suitable shared location already exists.
- Each listed code must have a stable class or class-equivalent identity, a stable machine code, and a human-readable default message. If the project language/runtime supports Error subclasses, use named classes such as `AdapterMissingError`; otherwise use the existing discriminated error type pattern with a stable `class` or `kind` field.
- CLI, API, Web UI, and event emission/reading should consume the same shared error metadata instead of duplicating message strings in each surface.
- Provider-originated detail must be redacted before it reaches API responses, CLI output, Web UI text, events, logs added by this work, or tests.

### Rejected
- Broad cleanup of error handling outside the P0.6 codes | violates the promotion-readiness slice.
- Hardcoding separate message tables in CLI/API/Web UI/events | creates drift and undermines stable classes/messages.
- Exposing raw provider errors for debugging convenience | conflicts with the redacted-provider-detail requirement.
- Editing fake LLM responders, broad snapshots, or fixtures merely to make tests pass | use focused tests or purpose-built verification paths instead.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6.
- `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/plan-075.md` — this planning handoff.
- Existing production files that currently define or serialize errors, CLI command failures, API error responses, Web UI error rendering, and event log/event-bus payloads — modify only the minimal set needed for the P0.6 codes and list exact paths in `deliverable-075.md`.
- Existing tests beside those production modules — add focused coverage for the new catalog, common failure paths, cross-surface message propagation, and provider-detail redaction.

### Scope

**Goal**: implement stable, human-readable, redacted P0.6 errors across CLI/API/Web UI/events while preserving current behavior except for the newly standardized error code/class/message fields.

**Target error catalog**:
- `adapter_missing` -> `AdapterMissingError` -> `The selected adapter is not installed or configured.`
- `adapter_auth_failed` -> `AdapterAuthFailedError` -> `The provider rejected authentication. Check the configured credentials.`
- `provider_rate_limited` -> `ProviderRateLimitedError` -> `The provider rate limit was reached. Try again later.`
- `permission_denied` -> `PermissionDeniedError` -> `This action is not permitted for the current user or project.`
- `secret_blocked` -> `SecretBlockedError` -> `This action was blocked because it could expose a secret.`
- `delete_blocked` -> `DeleteBlockedError` -> `Delete was blocked by the project safety rules.`
- `worktree_dirty` -> `WorktreeDirtyError` -> `The worktree has uncommitted changes that must be resolved first.`
- `source_path_mismatch` -> `SourcePathMismatchError` -> `The requested project source path does not match the registered project path.`
- `lease_stale` -> `LeaseStaleError` -> `The job lease is stale and must be reacquired.`
- `event_log_corrupt` -> `EventLogCorruptError` -> `The event log could not be read because it is corrupt.`
- `job_reconciled` -> `JobReconciledError` -> `The job state was reconciled after a mismatch was detected.`
- `project_lock_busy` -> `ProjectLockBusyError` -> `The project lock is currently held by another operation.`
- `version_mismatch` -> `VersionMismatchError` -> `The submitted version is out of date. Refresh and retry.`
- `verdict_failed` -> `VerdictFailedError` -> `The verification verdict failed.`

If the promotion-readiness source document specifies different exact message text, use that text and note the difference in the deliverable evidence.

**Implementation steps**:
1. Read the P0.6 section of the promotion-readiness plan and map the existing error flow with targeted searches for the 14 codes, current Error subclasses, CLI error formatting, API error serialization, Web UI error display, and event payload construction/parsing. Record the exact files changed in `deliverable-075.md`.
2. Add or extend one shared error catalog/module with the 14 codes, class/class-equivalent names, default messages, safe public fields, and a small formatter/normalizer that converts thrown errors or result errors into the existing project error shape.
3. Wire each domain failure at its origin to the shared error identity:
   - adapter resolution/auth/rate-limit failures -> `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`
   - filesystem/authz/guard failures -> `permission_denied`, `secret_blocked`, `delete_blocked`
   - project/worktree validation -> `worktree_dirty`, `source_path_mismatch`
   - lease/event/job reconciliation -> `lease_stale`, `event_log_corrupt`, `job_reconciled`
   - locking/concurrency/verdict paths -> `project_lock_busy`, `version_mismatch`, `verdict_failed`
4. Update CLI/API/Web UI/events to display or serialize the shared `code`, stable class/class-equivalent, and human-readable `message`. Preserve existing exit codes, HTTP status codes, event types, response envelopes, retry behavior, and UI state transitions unless the source plan explicitly requires otherwise.
5. Add redaction at the provider-detail boundary. Keep safe context such as provider name, operation name, status code, retry-after value, or adapter id when already exposed by the project, but remove tokens, API keys, Authorization/Bearer headers, cookies, raw provider bodies, stack traces, account identifiers, local secret paths, and credential fragments from public messages and event/API/CLI/UI payloads.
6. Add focused tests:
   - catalog/unit tests asserting the 14 codes exist, have unique stable class identities, and have non-empty human-readable messages
   - common failure tests for adapter missing/auth/rate-limit, permission/secret/delete blocking, worktree/source-path validation, stale lease/event-log corruption/job reconciliation, project lock busy, version mismatch, and verdict failure
   - surface tests proving CLI/API/Web UI/events receive the shared code/message for representative failures
   - redaction tests that inject provider detail containing a fake API key, Bearer token, Authorization header, cookie, stack trace, raw response body, and account-like identifier, then assert none of those raw values appear in public output or emitted events
7. Run the narrow relevant test commands first, then the repository's standard verification for this slice if available. Fix implementation issues rather than weakening tests.
8. Write `deliverable-075.md` with exact changed files, evidence, test output, behavior preserved, and any source-document-specific deviations from this plan.

**Notes**:
- Do not add dependencies.
- Do not update broad snapshots as the primary testing strategy. If a snapshot is the correct local assertion style, keep the update minimal and explain it in the deliverable.
- `job_reconciled` may be a non-fatal event/status in existing behavior. If so, keep it non-fatal while still giving it the stable class/class-equivalent and human-readable message required by P0.6.
- `event_log_corrupt` handling must not crash the process before the standardized error can be surfaced.
- Redaction should be enforced before data crosses into public/result/event serialization, not only in one UI layer.

## Next-Action
Implement the P0.6 slice exactly as scoped above, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-075.md` using the handshake protocol with phase `execute`.

## Acceptance-Criteria
- [ ] The P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read before implementation, and the deliverable cites it as the controlling source.
- [ ] The exact 14 codes are represented in one shared catalog/module with stable class or class-equivalent identities and human-readable default messages.
- [ ] CLI, API, Web UI, and event handling all use the shared error metadata for representative P0.6 failures instead of separate ad hoc strings.
- [ ] Existing exit codes, HTTP status codes, event types, response envelopes, retry behavior, and UI state transitions are preserved unless the source plan explicitly required a P0.6 change.
- [ ] Provider-originated sensitive detail is redacted from CLI output, API responses, Web UI messages, events, and any new logs introduced by this work.
- [ ] Focused tests cover catalog completeness, common failure paths, cross-surface code/message propagation, and redacted provider detail.
- [ ] No fake LLM responders, broad fixtures, or snapshots were changed merely to force production behavior tests to pass.
- [ ] Relevant focused tests and the repository's standard verification for this slice pass, with command output included in `deliverable-075.md`.
- [ ] `deliverable-075.md` lists exact files changed, simplifications made, rejected alternatives if any, remaining risks, and verification evidence.
