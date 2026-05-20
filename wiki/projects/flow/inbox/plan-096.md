## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-096 / P0.6
- **Timestamp**: 2026-05-19

### Task: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; implement only P0.6 stable error classes/messages across CLI/API/Web UI/events

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and implement only P0.6.
- Add one shared, stable error taxonomy in the server/shared layer and route CLI, API response payloads, Web UI labels, and event materialization through it.
- Preserve current transport shapes and behavior; add stable fields only where existing payloads already carry failure/error metadata.
- Every required code must have a stable class name and a human-readable default message: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Redact provider details before they reach API responses, event payloads, CLI output, or the Web UI; keep raw provider cause only in an existing secure internal log path if one already exists.

### Rejected
- Broad cleanup or refactor outside P0.6; this slice is error contract and presentation only.
- Replacing existing job/event/API schemas wholesale; use compatibility additions and existing field names where possible.
- Updating fake/mock responders, fixtures, or snapshots merely to make tests pass after production behavior changes.
- Emitting raw provider auth errors, tokens, API keys, prompts, headers, or full command output in user-facing error details.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm P0.6 wording before editing.
- `/Users/chengwen/dev/flow/server/services/error-taxonomy.js` — create if absent; define stable error codes, classes, metadata, message helpers, classifier, and provider-detail redaction.
- `/Users/chengwen/dev/flow/server/routes/tasks.js` — attach stable error class/message/meta to task failure API payloads and redact provider details.
- `/Users/chengwen/dev/flow/server/services/event-store.js` — persist/materialize stable error class/message/meta for job events without changing existing event semantics.
- `/Users/chengwen/dev/flow/server/services/readiness-checks.js` — use stable human-readable messages in CLI/readiness human and JSON formatting where these failure codes are surfaced.
- `/Users/chengwen/dev/flow/web/src/components/PipelineStatus.jsx` — display human-readable error labels/messages for the stable codes, preferring API-provided message/meta with a local fallback.
- Add or update the nearest existing tests for the above modules; if no adjacent test file exists, add focused tests beside the relevant module using the repo's current test layout.

### Evidence
- Planning-only pass; no terminal commands were executed.
- Symbol lookup indicates the root implementation surfaces include `server/routes/tasks.js`, `server/services/event-store.js`, `server/services/readiness-checks.js`, and `web/src/components/PipelineStatus.jsx`.
- A prior worktree contains a likely reference shape with `server/services/error-taxonomy.js`, `errorClass`/`errorMeta` event fields, `providerDetails` redaction, and `ERROR_LABELS` in `PipelineStatus.jsx`; inspect the root files first and use that only as directional context, not as an unreviewed copy source.

### Risks
- `job_reconciled` may be an informational reconciliation state rather than a fatal error. Preserve its existing semantics while still exposing stable class/message metadata when the code appears.
- Some errors may currently be inferred from command output. Keep inference conservative and add tests around the exact common failure strings the code already handles.
- Provider-detail redaction can break diagnostics if it removes all context. Retain safe fields such as provider name, status code, retry-after/backoff, and sanitized reason.

### Scope

**目标**: Implement P0.6 only: stable error classes and human-readable messages across CLI/API/Web UI/events for the required codes, plus tests for common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — source-of-truth read, no edits.
- `server/services/error-taxonomy.js` — shared taxonomy and redaction implementation.
- `server/routes/tasks.js` — API failure payload integration.
- `server/services/event-store.js` — event/job materialization integration.
- `server/services/readiness-checks.js` — CLI/readiness output integration.
- `web/src/components/PipelineStatus.jsx` — Web UI message fallback/integration.
- Adjacent test files for taxonomy, task route/event materialization, readiness/CLI formatting, and Web UI label fallback.

**实现步骤**:
1. Read the promotion readiness plan and confirm P0.6 is exactly the requested scope. Do not implement other P0 items.
2. Inspect the current root error/failure flow in `server/routes/tasks.js`, `server/services/event-store.js`, `server/services/readiness-checks.js`, and `web/src/components/PipelineStatus.jsx`. Identify the smallest hook points where codes/messages are already created, serialized, or displayed.
3. Create `server/services/error-taxonomy.js` if it does not exist. Export:
   - stable `ERROR_CODES` or equivalent constants for all 14 codes;
   - one base error class plus stable per-code classes;
   - `getErrorMeta(code)`, `classifyError(input)`, and `redactProviderDetails(details)` helpers;
   - a serializable shape containing `code`, `className`, `message`, `severity`, `category`, and safe optional remediation/retry metadata.
4. Use this stable mapping unless the source plan specifies stricter text:
   - `adapter_missing` -> `AdapterMissingError`: "The requested adapter is not installed or configured."
   - `adapter_auth_failed` -> `AdapterAuthFailedError`: "The adapter could not authenticate with the provider."
   - `provider_rate_limited` -> `ProviderRateLimitedError`: "The provider is rate limiting requests; retry after the backoff period."
   - `permission_denied` -> `PermissionDeniedError`: "The operation was denied by project or file permissions."
   - `secret_blocked` -> `SecretBlockedError`: "The request was blocked because it included protected secret material."
   - `delete_blocked` -> `DeleteBlockedError`: "Deletion was blocked because the target is protected or unsafe to remove."
   - `worktree_dirty` -> `WorktreeDirtyError`: "The worktree has uncommitted changes that must be handled before continuing."
   - `source_path_mismatch` -> `SourcePathMismatchError`: "The requested source path does not match the registered project path."
   - `lease_stale` -> `LeaseStaleError`: "The job lease is stale and must be refreshed or reconciled."
   - `event_log_corrupt` -> `EventLogCorruptError`: "The event log contains corrupt entries and needs repair before it can be read safely."
   - `job_reconciled` -> `JobReconciledError`: "The job state was reconciled from persisted events."
   - `project_lock_busy` -> `ProjectLockBusyError`: "The project is locked by another operation; retry when the lock is released."
   - `version_mismatch` -> `VersionMismatchError`: "The request version does not match the current project version."
   - `verdict_failed` -> `VerdictFailedError`: "The verification verdict failed; inspect the verdict details before continuing."
5. Wire API failures in `server/routes/tasks.js` to call the taxonomy/classifier, return stable `errorClass`/`errorMeta`/human message fields where failure metadata is already returned, and sanitize provider details before serialization.
6. Wire event materialization in `server/services/event-store.js` so job events and materialized job state retain existing fields while adding stable error class/message/meta when a known failure code exists.
7. Wire CLI/readiness formatting in `server/services/readiness-checks.js` so human output and JSON output use the same taxonomy messages for known codes while preserving current status, category, and remediation behavior.
8. Wire Web UI display in `web/src/components/PipelineStatus.jsx` so the UI shows the API-provided human message/meta when present and falls back to local labels for all 14 codes when older payloads only contain a code.
9. Add focused tests:
   - taxonomy test: all 14 codes have stable class name, default message, metadata, and serializable output;
   - classifier tests: common failures map to `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`;
   - redaction test: provider details containing token/key/secret/password/authorization/header/body/raw output/prompt fields are redacted, while safe provider/status/retry fields remain;
   - API/event tests: task failure payloads and materialized events include stable class/message/meta and do not include raw provider details;
   - Web UI test: a status payload with only a known code renders a human-readable fallback, and a payload with API-provided message uses that message.
10. Run the repo's relevant test, lint, and typecheck commands. If the exact commands are not obvious, inspect package scripts and run the smallest relevant test set first, then the standard full verification used by the project.

**注意事项**:
- Keep this slice scoped to P0.6; do not repair unrelated readiness, worktree, queue, or UI issues.
- Do not change user-facing behavior for unknown error codes; preserve existing fallback display and serialization.
- Do not leak provider raw details through events, API JSON, logs shown in the UI, or CLI output.
- Prefer adding compatibility fields over renaming existing fields.
- If a mock/fake-based test conflicts with the real workflow, report the mismatch in the deliverable and validate through a purpose-built test instead of weakening production behavior.

## Next-Action
Implement the P0.6 code changes following the steps above, run focused and standard verification, then write `deliverable-096.md` with changed files, test evidence, behavior-preservation notes, redaction evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The source plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` is read before editing, and only P0.6 is implemented.
- [ ] All 14 required codes have stable exported error classes, stable code metadata, and human-readable default messages.
- [ ] CLI/readiness output, API task failure payloads, Web UI status/error display, and event/job materialization all surface the stable class/message contract for known codes.
- [ ] Existing behavior and fallback handling for unknown errors remain intact.
- [ ] Provider details are redacted in all user-facing surfaces, with tests proving sensitive raw fields are removed and safe diagnostic fields remain.
- [ ] Common failure tests cover adapter missing/auth failed/rate limited, permission denied, secret/delete blocks, dirty worktree/source mismatch, lock/version/verdict failures, and event-log corruption or reconciliation where the current code exposes them.
- [ ] Relevant tests, lint, typecheck, and any project-standard verification pass.
- [ ] The deliverable lists changed files, simplifications made, verification commands/output, and remaining risks.
