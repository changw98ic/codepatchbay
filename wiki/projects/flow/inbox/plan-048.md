## Handoff: codex -> claude

# Plan 048 — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-048-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for P0.6 and do not implement other readiness-plan items.
- Add one shared typed error contract for the required stable codes, then have CLI/API/Web UI/event emitters render from that contract instead of each surface inventing its own text.
- Preserve existing behavior: keep current exit codes, HTTP status behavior, retry behavior, reconciliation behavior, and UI flow unless the existing behavior exposes unstable/raw errors for this P0.6 slice.
- `job_reconciled` should remain non-fatal if it is currently a successful reconciliation notice; represent it with the same stable public error/event shape without turning it into a command/API failure.
- Public serialization must include a stable `code` and human-readable `message`; provider/internal details must be redacted before reaching CLI output, API responses, Web UI text, or event payloads.
- Redacted provider detail may retain safe operational fields such as provider name, HTTP status, retry-after value, request id, and sanitized reason. It must not expose tokens, authorization headers, secrets, raw provider prompts, raw provider responses, stack traces, cookies, API keys, file contents, or environment values.

### Rejected
- Broad cleanup/refactor outside P0.6 — explicitly out of scope and risks changing unrelated promotion-readiness behavior.
- Per-surface string tables — rejected because CLI/API/Web UI/events would drift and lose stable error-code guarantees.
- Snapshot/test-double-only fixes — rejected unless the fake/test double is itself the mismatch; behavior must be covered by real unit/integration paths or purpose-built assertions.
- Returning raw provider errors behind a debug flag by default — rejected because P0.6 requires redacted provider detail across public surfaces.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm P0.6 wording before editing.
- Existing shared/core error module, or create the narrowest shared module if none exists — define stable codes, concrete error classes, default messages, public serialization, and provider-detail redaction.
- Existing CLI error rendering/catch boundary files — render the shared public error shape for the P0.6 failures without changing unrelated command behavior.
- Existing API error middleware/route handlers — map shared errors to stable response bodies and current status semantics.
- Existing Web UI error display/store/client files — render human-readable shared messages and avoid raw provider/internal detail.
- Existing event emitter/event-log schema files — emit stable code/message/redacted details for failure and reconciliation events.
- Existing adapter/provider integration files — translate adapter/provider failures into `adapter_missing`, `adapter_auth_failed`, and `provider_rate_limited` with redacted details.
- Existing permission, secret, delete, worktree, source-path, lease, lock, version, event-log, and verdict failure paths — replace ad hoc public errors only for the required codes.
- Existing test files next to the affected modules, or narrowly scoped new test files following repository convention — cover common failures, surface serialization, and provider-detail redaction.

### Scope

**目标**: Implement P0.6 only: provide stable typed errors and human-readable public messages for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed` across CLI/API/Web UI/events, with tests for common failures and redacted provider detail.

**涉及文件**:
- Source-of-truth plan file above — read only.
- Shared/core error contract file — add or extend stable classes and serialization.
- CLI/API/Web UI/events boundary files — consume shared public error shape.
- Domain/provider failure sites for the listed codes — throw or translate to stable errors.
- Test files for shared errors, surface rendering/serialization, and provider redaction — add/adjust only where needed.

**实现步骤**:
1. Read the source-of-truth plan section for P0.6, then inventory only existing code paths that already produce the required failures or expose public errors on CLI/API/Web UI/events.
2. Locate the existing project pattern for typed errors, result errors, API error middleware, CLI rendering, UI error state, and event payloads. Reuse those patterns; create a new shared error contract only if no suitable shared surface already exists.
3. Define the stable public error catalog with these exact codes and default messages:
   - `adapter_missing`: `Adapter is not configured. Choose a provider adapter before retrying.`
   - `adapter_auth_failed`: `Adapter authentication failed. Check provider credentials and retry.`
   - `provider_rate_limited`: `Provider rate limit reached. Wait before retrying.`
   - `permission_denied`: `Permission denied for this action.`
   - `secret_blocked`: `Secret material was blocked and was not written or displayed.`
   - `delete_blocked`: `Delete is blocked because the target is protected or still in use.`
   - `worktree_dirty`: `Worktree has uncommitted changes. Commit, stash, or clean it before retrying.`
   - `source_path_mismatch`: `Source path does not match the registered project path.`
   - `lease_stale`: `Lease is stale. Refresh the job or project state before retrying.`
   - `event_log_corrupt`: `Event log is corrupt or unreadable. Repair or restore it before continuing.`
   - `job_reconciled`: `Job state was reconciled after detecting an inconsistent runtime state.`
   - `project_lock_busy`: `Project is locked by another operation. Try again after it finishes.`
   - `version_mismatch`: `Version mismatch detected. Refresh and retry with the current version.`
   - `verdict_failed`: `Verdict failed. Review the reported failures and retry after fixing them.`
4. Implement concrete error classes or the repository-equivalent typed constructors for every listed code. Each public shape must expose at least `code` and `message`; include status/severity/retryability only if the existing project contract already supports those fields.
5. Add one redaction helper for provider/internal details and use it before serialization. It should recursively remove or mask keys matching secret-bearing names such as token, key, secret, password, authorization, cookie, credential, prompt, response, body, stack, env, and file content while preserving safe fields needed for support.
6. Wire adapter/provider failures to stable errors:
   - missing configured adapter -> `adapter_missing`
   - failed authentication/invalid credentials -> `adapter_auth_failed`
   - provider throttle/rate-limit responses -> `provider_rate_limited` with safe retry metadata only
7. Wire domain failures to stable errors for permission checks, secret blocking, delete blocking, dirty worktrees, source path mismatch, stale leases, corrupt event logs, busy project locks, optimistic/version conflicts, and failed verdicts. Keep any current internal error causes for logs only, not public output.
8. Update CLI/API/Web UI/events at the boundary layer so they render or serialize the shared public shape. Avoid duplicating messages at each surface; tests should fail if a surface falls back to raw `Error.message` for these codes.
9. Add tests that lock the contract:
   - every required code has a concrete class/constructor and non-empty human-readable default message
   - serialization produces stable `code` and `message`
   - adapter missing/auth/rate-limit common failures render stable messages
   - permission/secret/delete/worktree/source-path/lease/lock/version/verdict common failures render stable messages
   - event-log corruption and job reconciliation event payloads contain stable code/message
   - provider detail redaction removes secrets/raw provider payloads while preserving safe metadata
   - CLI/API/Web UI/event public surfaces do not expose raw stack traces, authorization headers, tokens, API keys, prompt/body/response contents, or environment values
10. Run the repository's relevant unit/integration test commands for the changed areas, then run the standard lint/typecheck/test suite if available. If a full suite is too slow or unavailable, record the exact narrower commands and the reason in the deliverable.
11. Produce `deliverable-048.md` with changed files, test evidence, simplifications made, and remaining risks.

**注意事项**:
- Keep changes scoped to P0.6 and the listed codes. Do not implement other P0/P1 readiness items.
- Do not rename public codes, change spelling, or introduce aliases unless existing compatibility requires an alias. The stable codes above are the public contract.
- Do not change fake/mock tests, fixtures, snapshots, or test doubles merely to make tests pass after production changes. If a fake no longer reflects the real workflow, report the mismatch and add purpose-built verification instead.
- Do not expose provider/raw internal detail in CLI/API/Web UI/events. Logs may keep internal causes only if the existing logging path is non-public and already redacts secrets.
- Preserve existing behavior and status semantics. The implementation should standardize error identity and public text, not change control flow outside the necessary failure translations.
- Avoid new dependencies. Use existing utilities and patterns for errors, redaction, schema validation, and UI rendering.

## Next-Action
Read the source-of-truth promotion readiness plan, implement only P0.6 using the steps above, run targeted and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-048.md` with changed files, evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] The implementation is limited to P0.6 and does not include unrelated cleanup or other promotion-readiness slices.
- [ ] All 14 required codes exist exactly as stable public codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a concrete stable error class/constructor or repository-equivalent typed error factory and a non-empty human-readable default message.
- [ ] CLI output for common listed failures uses the stable human-readable message and does not expose raw provider/internal detail.
- [ ] API responses for common listed failures include stable `code` and `message`, preserve existing status semantics, and do not expose raw provider/internal detail.
- [ ] Web UI error presentation for common listed failures uses stable human-readable messages and does not show raw stack/provider text.
- [ ] Event payloads/log entries for listed failures and `job_reconciled` include stable `code` and `message` plus only redacted/safe detail.
- [ ] Provider/auth/rate-limit failures preserve safe metadata such as provider, status, retry-after, or request id when available, while redacting secrets, authorization/cookie headers, raw provider bodies, prompts, responses, stack traces, file contents, and environment values.
- [ ] Tests cover the shared error contract, common CLI/API/Web UI/event failure serialization paths, and redacted provider detail.
- [ ] Existing behavior is preserved outside standardized error identity/message/serialization for the P0.6 codes.
- [ ] Relevant targeted tests pass, and the deliverable records any broader lint/typecheck/test command that could not be run with a concrete reason.
