## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-068
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; implement only P0.6 and do not start other readiness items.
- Add one canonical error catalog for these stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Add stable named error classes/factories around that catalog, with each public error carrying `code`, human-readable `message`, an appropriate status/severity, and redacted public `details`.
- Keep compatibility by preserving existing API/event fields where callers may already depend on them; add structured `error.code` and `error.message` rather than replacing legacy strings unless the local code already has a structured error contract.
- `job_reconciled` should be represented in the same catalog for event/UI consistency even if it is informational rather than a thrown failure.
- Provider-supplied raw text, headers, tokens, API keys, stack traces, and command output must be redacted before reaching API JSON, CLI output, Web UI state, persisted events, logs intended for users, or tests.

### Rejected
- Broad cleanup of unrelated readiness, dispatch, review, or Web UI code; this P0 slice is only stable errors/messages.
- Replacing existing route/event shapes wholesale; too risky for a promotion-readiness must-have and unnecessary for stable codes.
- Updating mocks, snapshots, fixtures, or fake responders merely to make tests pass; only adjust tests that exercise the real intended error contract.
- Adding dependencies for redaction or formatting; implement with local helpers and existing test tools.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — mandatory first read; use P0.6 as the source-of-truth boundary.
- `/Users/chengwen/dev/flow/server/services/readiness-checks.js` — likely adapter readiness failures and CLI readiness formatting (`runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`).
- `/Users/chengwen/dev/flow/server/services/runtime-cli.js` — likely CLI event/error formatting surface.
- `/Users/chengwen/dev/flow/server/services/event-store.js` — event serialization, malformed/corrupt event handling, and persisted error payloads.
- `/Users/chengwen/dev/flow/server/services/runtime-events.js` — runtime event read/write wrappers.
- `/Users/chengwen/dev/flow/server/services/reconcile.js` — event-log corruption and `job_reconciled` semantics.
- `/Users/chengwen/dev/flow/server/services/secret-policy.js` — `secret_blocked` event/error source.
- `/Users/chengwen/dev/flow/server/services/lease-manager.js` — `lease_stale` and lock contention sources.
- `/Users/chengwen/dev/flow/server/services/worker-dispatch.js` — `source_path_mismatch` guard source.
- `/Users/chengwen/dev/flow/server/services/hub-registry.js` — project source-path/version/lock paths as applicable.
- `/Users/chengwen/dev/flow/server/services/merge-steward.js` — `worktree_dirty` / delete safety paths as applicable.
- `/Users/chengwen/dev/flow/server/services/review-session.js` and `/Users/chengwen/dev/flow/server/routes/review.js` — `verdict_failed` source and route serialization.
- `/Users/chengwen/dev/flow/server/routes/*.js` and `/Users/chengwen/dev/flow/server/index.js` — API error serialization and status preservation.
- `/Users/chengwen/dev/flow/web/src/App.jsx`, `/Users/chengwen/dev/flow/web/src/hooks/useWebSocket.test.jsx`, and the Web API/event display modules discovered during implementation — Web UI display of structured error messages.
- New shared/server error catalog and tests in the existing local style, for example a small shared catalog plus server-side `FlowError` classes, if no equivalent module already exists.

### Evidence
- Planning-only phase honored: no terminal commands were executed.
- Non-shell code-index lookup identified relevant live files/symbols, including `server/services/readiness-checks.js`, `server/services/event-store.js`, `server/services/runtime-cli.js`, `server/services/reconcile.js`, `server/services/secret-policy.js`, `server/services/lease-manager.js`, `server/services/worker-dispatch.js`, `server/services/hub-registry.js`, `server/services/review-session.js`, `server/routes/review.js`, and `web/src/App.jsx`.
- No implementation or verification commands were run in this planning phase.

### Risks
- Some listed codes may currently be plain strings, thrown generic `Error`s, HTTP responses, or event-only reasons; wire each existing source to the shared catalog without changing unrelated control flow.
- Web UI may not be able to import server CommonJS modules directly. If so, keep the message catalog in a browser-safe shared JSON/module and wrap it separately in server classes.
- Redaction must happen before serialization and persistence, not only during display, or event logs/API fixtures may still leak provider details.
- Existing tests may assert legacy message text. Preserve legacy fields where possible and update only tests whose intended behavior is the new stable public error contract.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: a stable, human-readable, redacted error contract for the listed codes across CLI, API, Web UI, and persisted/runtime events, with focused tests for common failures and provider-detail redaction.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first to confirm exact P0.6 wording and boundaries.
- `server/services/readiness-checks.js` — map adapter missing/auth/rate-limit failures into stable codes and CLI/JSON readiness messages.
- `server/services/runtime-cli.js` — print stable CLI messages and codes for known failures.
- `server/services/event-store.js`, `server/services/runtime-events.js`, `server/services/reconcile.js` — serialize stable error/event codes and handle corrupt event logs/reconciled jobs.
- `server/services/secret-policy.js`, `server/services/lease-manager.js`, `server/services/worker-dispatch.js`, `server/services/hub-registry.js`, `server/services/merge-steward.js`, `server/services/review-session.js` — replace or wrap common generic failures with the new classes where these codes originate.
- `server/routes/*.js`, `server/index.js` — expose structured API errors while preserving existing HTTP behavior.
- `web/src/**` — display structured API/event error messages using the shared catalog/fallback helper.
- `server/**/*.test.js`, `web/src/**/*.test.*`, or the repository's existing test locations — add focused coverage in the established style.

**实现步骤**:
1. Read `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, locate P0.6, and keep a local checklist of only the 14 requested codes and four requested surfaces: CLI, API, Web UI, events.
2. Inventory existing error sources for the 14 codes by searching current server/Web code. Do not edit unrelated cleanup targets. Record any existing public field names so the implementation can add structured fields without breaking callers.
3. Add or reuse a canonical browser-safe error catalog with one entry per code. Each entry must include a stable `code`, human-readable default `message`, and surface metadata such as HTTP status/severity only where useful. Suggested default messages:
   - `adapter_missing`: "Required adapter is not configured or unavailable."
   - `adapter_auth_failed`: "Adapter authentication failed. Check credentials and permissions."
   - `provider_rate_limited`: "Provider rate limit reached. Retry after the limit resets."
   - `permission_denied`: "Permission denied for this operation."
   - `secret_blocked`: "A secret was detected and blocked from promotion."
   - `delete_blocked`: "Delete operation blocked by project safety policy."
   - `worktree_dirty`: "Worktree has uncommitted changes. Clean or commit changes before continuing."
   - `source_path_mismatch`: "Source path does not match the registered project path."
   - `lease_stale`: "Job lease is stale and must be reacquired before continuing."
   - `event_log_corrupt`: "Event log is corrupt or contains malformed entries."
   - `job_reconciled`: "Job state was reconciled from existing event data."
   - `project_lock_busy`: "Project lock is busy. Try again when the current operation completes."
   - `version_mismatch`: "Version mismatch. Refresh state and retry."
   - `verdict_failed`: "Review verdict failed. Resolve the reported review issue and retry."
4. Add server-side stable error classes/factories around the catalog, including `FlowError` plus named exports such as `AdapterMissingError`, `AdapterAuthFailedError`, `ProviderRateLimitedError`, `PermissionDeniedError`, `SecretBlockedError`, `DeleteBlockedError`, `WorktreeDirtyError`, `SourcePathMismatchError`, `LeaseStaleError`, `EventLogCorruptError`, `JobReconciledError`, `ProjectLockBusyError`, `VersionMismatchError`, and `VerdictFailedError`.
5. Add a single public serialization helper, for example `toPublicError(error)`, that normalizes known and unknown errors to `{ code, message, details? }`, preserves existing HTTP statuses for routes, and redacts provider detail before returning or persisting anything public.
6. Wire common failure sources to throw/use the stable classes: adapter readiness/auth/rate-limit failures, permission and secret/delete guards, dirty worktree guard, source path guard, lease stale/lock busy/version mismatch paths, corrupt event log handling, reconcile events, and review verdict failures. Keep existing behavior and side effects the same except for the added stable public code/message.
7. Wire surface formatters:
   - CLI prints the human message and stable code for known errors, with no raw provider detail.
   - API responses include `error.code` and `error.message`, plus redacted `details` only when already safe.
   - Events persist structured `error` or `reason` data using catalog codes/messages and never persist raw provider detail.
   - Web UI displays API/event `message` from the structured payload, falls back by `code` through the shared catalog, and avoids rendering raw `providerDetail`/stack text.
8. Add focused tests in the existing test style:
   - Catalog/class test proves every requested code has a stable message and named class/factory.
   - Serializer/redaction test proves provider text containing API keys, bearer tokens, headers, stack traces, and raw provider bodies is not present in API/event/CLI-safe output.
   - API test for at least two common failures, including one auth/rate-limit adapter case and one policy/permission case, asserting status, code, message, and redaction.
   - Event test for `event_log_corrupt` and `job_reconciled`, asserting stable codes/messages and no leakage of raw malformed/provider detail.
   - Web UI/helper test asserting structured errors render the human message and fall back from code when only the code is present.
9. Run the relevant server and Web tests plus lint/typecheck commands used by this repository. If the repo has a narrower test target for changed files, run that first, then the standard verification suite required by the promotion plan.
10. Write `wiki/projects/flow/outputs/deliverable-068.md` with changed files, evidence, tests run, and any remaining risks.

**注意事项**:
- Do not implement P0.1-P0.5 or any non-P0.6 readiness work.
- Do not change fake/mock responders, snapshots, or fixtures solely to force tests green.
- Do not expose raw provider messages that may include tokens, request IDs, headers, stack traces, file contents, or command output.
- Do not remove existing response/event fields unless tests and local usage prove they are private implementation details.
- Prefer adapting existing helpers and route patterns over introducing a broad new framework.

## Next-Action
Read the promotion readiness plan, implement only P0.6 following the steps above, run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-068.md` with implementation evidence.

## Acceptance-Criteria
- [ ] The promotion readiness plan P0.6 is read and no unrelated P0 or cleanup work is implemented.
- [ ] All 14 requested codes have stable catalog entries and server-side stable classes/factories: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI output for known failures shows a human-readable message and stable code without raw provider detail.
- [ ] API responses for known failures include structured `error.code` and `error.message`, preserve intended HTTP status behavior, and redact unsafe details.
- [ ] Web UI error rendering uses structured API/event messages or catalog fallback by code and does not display raw provider detail.
- [ ] Persisted/runtime events for known failures and reconciliation include stable code/message data and do not persist raw provider detail.
- [ ] Tests cover common adapter auth/rate-limit or missing-adapter failure, a policy/permission failure, event corruption/reconciliation behavior, Web UI rendering/fallback, and redacted provider detail.
- [ ] Existing behavior outside public stable error shape is preserved.
- [ ] Relevant server and Web tests pass.
- [ ] Code style matches existing project patterns and no new dependency is added.
