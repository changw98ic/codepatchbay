# Plan 106: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6 stable error classes and human-readable messages

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-106-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Use `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Add one stable error catalog as the contract for server/API/CLI/event payloads and reuse it from the Web UI when the current module boundaries allow it.
- Each required code must have a stable class name, stable code string, human-readable public message, retryability metadata, and a safe HTTP/status mapping where applicable.
- Public API responses, CLI output, Web UI copy, persisted events, and websocket/event broadcasts must expose redacted public detail only.
- Raw provider errors may be used only as internal causes or log-only diagnostics after redaction; no token, bearer header, webhook URL secret, API key, or environment-secret value may reach public surfaces.
- Preserve existing behavior except for replacing unstable/raw error strings with the stable P0.6 shape.

### Rejected
- Broad cleanup outside P0.6 - the task explicitly says to keep changes scoped and avoid unrelated cleanup.
- UI-only label mapping - it would leave CLI/API/events inconsistent and would not create stable error classes.
- Raw provider detail in client/event payloads - it violates the redacted provider detail requirement.
- Changing existing fake/mock fixtures only to force tests green - repo guidance forbids that unless the fake itself is the bug.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - source-of-truth plan to read before edits.
- `/Users/chengwen/dev/flow/server/services/error-catalog.js` - add or extend the stable catalog and error classes here if no existing shared error module exists.
- `/Users/chengwen/dev/flow/server/services/error-catalog.test.js` - add contract tests for all required codes, messages, redaction, and serialization.
- `/Users/chengwen/dev/flow/server/routes/*.js` - normalize API error responses at existing route boundaries without changing route semantics.
- `/Users/chengwen/dev/flow/server/services/runtime-cli.js` - normalize CLI-facing failures with stable code/class/message and redacted detail.
- `/Users/chengwen/dev/flow/server/services/event-store.js` and event/broadcast helpers that serialize job events - persist and emit stable error fields for failed/blocked/reconciled states.
- `/Users/chengwen/dev/flow/server/services/job-store.js`, `/Users/chengwen/dev/flow/server/services/supervisor.js`, and project/worktree/lease helpers that already raise these failures - replace ad hoc throws/strings with the P0.6 errors.
- `/Users/chengwen/dev/flow/web/src/components/PipelineStatus.jsx` or the current equivalent Web UI error display component - render catalog messages for the required codes.
- `/Users/chengwen/dev/flow/web/src/components/PipelineStatus.test.jsx` or equivalent Web UI tests - assert common failure copy and unknown-code fallback.
- `/Users/chengwen/dev/flow/runtime/cpb-runtime/src/lib.rs` and `/Users/chengwen/dev/flow/runtime/cpb-runtime/tests/events_golden.rs` - touch only if the active source tree still serializes event error codes/messages in Rust.

### Evidence
- Planning-only phase. No terminal commands were executed.
- Non-terminal code-intel context showed existing error-related surfaces under server services, runtime event serialization, and Web UI pipeline status components. Treat those as orientation only; the source-of-truth implementation target is the active `/Users/chengwen/dev/flow` source tree, not stale `cpb-task/worktrees/*` copies.

### Risks
- Some listed codes may already exist as UI-only labels. Do not duplicate divergent messages; move the contract to a shared catalog or add a test that proves server and web copies stay equivalent.
- Rust runtime event serialization may mirror JavaScript event contracts. If touched, keep it to event error fields and golden tests only.
- Provider errors often include secrets in nested fields. Redaction must process message strings and structured detail recursively before any public serialization.

### Scope

**Goal**: Implement P0.6 from the promotion readiness plan: stable error classes and human-readable messages across CLI/API/Web UI/events for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`, with tests for common failures and redacted provider detail.

**Required error contract**:

| code | class | public message | HTTP/status guidance |
| --- | --- | --- | --- |
| `adapter_missing` | `AdapterMissingError` | `Adapter is not configured for this project. Configure an adapter before starting the job.` | 400 or existing equivalent |
| `adapter_auth_failed` | `AdapterAuthFailedError` | `Adapter authentication failed. Check the configured credentials and retry.` | 401 or existing equivalent |
| `provider_rate_limited` | `ProviderRateLimitedError` | `Provider rate limit reached. Wait and retry the job.` | 429 |
| `permission_denied` | `PermissionDeniedError` | `Permission denied for this operation.` | 403 |
| `secret_blocked` | `SecretBlockedError` | `Secret-like content was blocked before it could be exposed.` | 400 or 403 |
| `delete_blocked` | `DeleteBlockedError` | `Delete was blocked because the target is not safe to remove.` | 409 |
| `worktree_dirty` | `WorktreeDirtyError` | `Worktree has uncommitted changes. Resolve them before continuing.` | 409 |
| `source_path_mismatch` | `SourcePathMismatchError` | `Source path does not match the registered project path.` | 409 |
| `lease_stale` | `LeaseStaleError` | `Lease is stale. Refresh the job state and retry.` | 409 |
| `event_log_corrupt` | `EventLogCorruptError` | `Event log is corrupt and needs repair before continuing.` | 500 or existing repair-required status |
| `job_reconciled` | `JobReconciledError` | `Job state was reconciled after recovery. Refresh before retrying the operation.` | 409 or event-only warning |
| `project_lock_busy` | `ProjectLockBusyError` | `Project is busy with another operation. Retry when the lock is released.` | 423 or 409 |
| `version_mismatch` | `VersionMismatchError` | `Version mismatch detected. Refresh and retry with the latest job state.` | 409 |
| `verdict_failed` | `VerdictFailedError` | `Verdict could not be recorded. Review the verdict input and retry.` | 422 or existing equivalent |

**Implementation steps**:

1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and confirm P0.6 does not add constraints beyond the codes listed above. Do not implement other P0/P1/P2 items.
2. Find the current error-handling entry points in the active source tree: API route error responders, CLI/runtime formatting, job/event serialization, Web UI status rendering, and tests. Ignore stale `cpb-task/worktrees/*` files except as non-authoritative references.
3. Add or extend a single server-side error module, preferably `server/services/error-catalog.js` unless an existing shared error module is already present. Export:
   - a frozen catalog keyed by the 14 required code strings;
   - a base `FlowError` or existing app-error base class with `code`, `className`, `message`, `publicMessage`, `status`, `retryable`, `detail`, and `cause`;
   - the 14 named classes listed in the table;
   - `toPublicError(error)` or the existing equivalent serializer;
   - `redactProviderDetail(value)` for recursive redaction of public detail.
4. Make API route error handling call the serializer once at the route/error-boundary layer. The response body must include stable `code`, `class`, `message`, and redacted `detail` when detail exists. Preserve existing HTTP behavior unless the old status is missing or clearly wrong for the catalog.
5. Update CLI-facing formatting in `server/services/runtime-cli.js` or the active CLI module so failures show the same stable code/class/message. If CLI output already has a structured mode, include the same public fields there; plain text should remain human-readable.
6. Update job-store/supervisor/project/worktree/lease/verdict flows to throw the new named errors at the source of each common failure instead of returning raw strings. Keep existing success paths, state transitions, and event names unchanged.
7. Update event persistence and broadcast serialization so job blocked/failed/reconciled events include `error.code`, `error.class`, `error.message`, and redacted `error.detail` when an error exists. Do not rename established event types unless the source plan explicitly requires it.
8. Update the Web UI error display to render the catalog message for all 14 required codes. Prefer importing a shared pure catalog if the bundler already supports it; otherwise keep a Web UI projection with a test that proves code/message parity against the server catalog.
9. Add focused tests:
   - catalog contract test asserts exactly the 14 required codes exist with stable class names and non-empty human-readable messages;
   - serializer tests assert unknown errors still use the existing fallback behavior;
   - redaction tests assert provider detail containing API keys, bearer tokens, webhook URLs with secrets, and nested credential fields is redacted from API/event/CLI public output;
   - API tests cover `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, and `version_mismatch` through existing route boundaries;
   - event tests cover `worktree_dirty`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, and `project_lock_busy` serialization;
   - Web UI tests cover at least `adapter_missing`, `secret_blocked`, `delete_blocked`, `source_path_mismatch`, and `verdict_failed`, plus unknown-code fallback.
10. Run the smallest relevant test set first, then the standard project verification for touched areas. If full verification is too expensive or blocked, record the exact command attempted and blocker in the deliverable.
11. Self-review the diff for scope: no unrelated refactors, no new dependencies, no behavior changes beyond P0.6 error normalization, no raw provider detail on public surfaces.

**Notes for implementation**:
- Preserve existing public API field names where clients already depend on them; add the stable fields rather than removing legacy fields unless tests prove removal is safe.
- Use `message` for the human-readable safe message. Put provider text only in redacted `detail`.
- Redaction should be case-insensitive for keys like `apiKey`, `token`, `authorization`, `password`, `secret`, and should also redact common inline patterns like `Bearer ...`, `sk-...`, `xoxb-...`, and credential-bearing webhook/query URLs.
- `job_reconciled` may be an informational recovery condition in current code. Still give it a stable error-like public shape when it blocks/requires refresh, but do not turn successful reconciliation into a hard failure.
- Do not modify snapshots, fakes, or fixtures merely to hide behavior changes. Update tests only where the expected P0.6 public contract changes.

## Next-Action
Implement P0.6 exactly as scoped above, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-106.md` with changed files, tests run, output evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation reads and follows `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as source of truth for P0.6 only.
- [ ] All 14 required codes exist in a stable catalog: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Each required code has a stable named error class and a human-readable public message.
- [ ] API responses expose stable `code`, `class`, `message`, and redacted `detail` for these failures while preserving existing route behavior.
- [ ] CLI output exposes the same stable public error information in human-readable form.
- [ ] Persisted events and event/websocket broadcasts include stable error fields for failed/blocked/reconciled states without leaking raw provider detail.
- [ ] Web UI displays the catalog messages for the required codes and keeps a safe fallback for unknown codes.
- [ ] Tests cover common failures across API/events/Web UI and include redacted provider detail cases for both string and nested structured detail.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, refactor, fixture churn, or behavior broadening is included.
- [ ] Focused tests for touched areas pass, and standard project verification is run or explicitly reported with a concrete blocker.
