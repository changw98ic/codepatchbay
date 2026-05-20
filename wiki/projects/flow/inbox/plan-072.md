## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-072 / P0.6 stable promotion-readiness errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.6 error-stability slice.
- Introduce or extend one canonical server-side error contract for the listed stable codes, with a stable machine code, human-readable message, HTTP/CLI/event presentation data, and redacted details.
- Preserve existing behavior by mapping current failure sites onto the stable error contract instead of changing control flow or broadening unrelated validation, cleanup, or refactors.
- Ensure CLI output, API responses, Web UI rendering, and emitted/job events consume the same stable error shape so the code and message are consistent across surfaces.
- Provider or adapter details may be included only through an explicit redaction/sanitization helper; raw tokens, auth headers, secrets, filesystem credentials, and provider payload internals must not reach CLI/API/Web UI/events.

### Rejected
- Rejected implementing other promotion-readiness P0/P1 items because this handoff is scoped only to P0.6.
- Rejected string-only ad hoc messages at each call site because they would drift across CLI/API/Web UI/events.
- Rejected changing fake/mock responders or broad test doubles just to make tests pass; production behavior should be covered directly, with fake assets changed only when they are the unit under test.
- Rejected adding new dependencies for error formatting or redaction; use existing project utilities and plain JavaScript/TypeScript patterns.

### Scope

**Goal**: Add stable, shared error classes and human-readable messages for the P0.6 error codes, wire them through CLI/API/Web UI/events, and add focused tests for common failures plus provider-detail redaction while preserving existing behavior.

**Source-of-truth file**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; confirm P0.6 wording and do not implement unrelated readiness items.

**Likely implementation files to inspect and modify only if they are the current mainline owners**:
- `/Users/chengwen/dev/flow/server/services/event-store.js` — event log corrupt/error event normalization if this remains the event-store owner.
- `/Users/chengwen/dev/flow/server/services/supervisor.js` — job reconciliation, lease, project lock, worktree/source-path/verdict failure emission if this remains the job supervisor owner.
- `/Users/chengwen/dev/flow/server/routes/channels.js` — API response mapping for channel/job failures if this remains an API route owner.
- `/Users/chengwen/dev/flow/server/services/observability.js` — event/diagnostic error code counters if this remains the observability owner.
- `/Users/chengwen/dev/flow/server/services/diagnostics-bundle.js` — redacted diagnostics and provider detail handling if this remains the diagnostics owner.
- `/Users/chengwen/dev/flow/web/src/components/PipelineStatus.jsx` — Web UI message rendering for stable pipeline/job error codes if this remains the UI owner.
- Existing CLI entrypoint(s) under `/Users/chengwen/dev/flow/` discovered from the source tree — CLI error presentation only; do not create a second CLI surface.
- Existing tests adjacent to the changed files — add focused tests near existing server/CLI/web tests; do not create broad unrelated test suites.

**Stable error codes required**:
- `adapter_missing`
- `adapter_auth_failed`
- `provider_rate_limited`
- `permission_denied`
- `secret_blocked`
- `delete_blocked`
- `worktree_dirty`
- `source_path_mismatch`
- `lease_stale`
- `event_log_corrupt`
- `job_reconciled`
- `project_lock_busy`
- `version_mismatch`
- `verdict_failed`

**Implementation steps**:
1. Read the promotion readiness plan and current error-handling code paths. Confirm the current owners for CLI, API, Web UI, and event/job emission before editing; keep the final changed-file list limited to those owners.
2. Add or extend a canonical error module in the existing server/shared location. It should expose stable error classes or constructors for each required code, a single message catalog, a serializer for API/event payloads, and a redaction helper for provider details.
3. Define the stable serialized shape once. Recommended fields: `code`, `message`, optional `retryable`, optional `status`, optional `details` containing only redacted/safe values, and optional `causeCode` when preserving an internal cause is useful. Keep the public `code` values exactly as listed.
4. Map adapter/provider failures to the canonical errors: missing adapter -> `adapter_missing`, auth failure -> `adapter_auth_failed`, rate limit -> `provider_rate_limited`. Ensure provider names may appear when safe, but tokens, request bodies, auth headers, API keys, and raw provider error dumps are redacted.
5. Map local policy/state failures to canonical errors: `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`. Preserve the existing status codes, exit behavior, and retry behavior unless the readiness plan explicitly says otherwise.
6. Wire API responses to return the canonical serialized shape for these failures while leaving existing success payloads unchanged. If existing API clients expect an `error` field, keep it and place the stable object there rather than breaking the envelope.
7. Wire CLI output to display the human-readable message and stable code in the existing CLI style. Keep stack traces/internal causes behind the existing verbose/debug mode if one exists.
8. Wire events/job logs to emit the stable code and human-readable message. Any internal detail included in events must pass through the same redaction helper used by API and diagnostics.
9. Wire Web UI rendering so these stable codes show the catalog message, using the existing component/state flow. Avoid duplicating the message catalog in the UI unless the existing architecture already has a client-side stable-code map; if a client map exists, update it from the same message text and add drift-focused tests.
10. Add focused tests for representative common failures: missing adapter, adapter auth failure with provider detail redaction, provider rate limit, permission/delete/secret blocking, dirty worktree or source path mismatch, stale lease/project lock busy, event log corrupt, version mismatch, verdict failed, and job reconciled event behavior.
11. Add at least one redaction regression test that injects provider detail containing an API key/token/authorization header/path-sensitive secret and proves CLI/API/event/diagnostic serialization does not expose the raw value.
12. Run the smallest relevant test commands first, then the repo's standard verification for changed areas. Record exact commands and results in `deliverable-072.md`.

**Notes and guardrails**:
- Do not implement other items from the promotion readiness plan.
- Do not rename the required stable codes or alter their casing.
- Do not broaden cleanup, restructure unrelated modules, or introduce a new dependency.
- Do not modify snapshots, fixtures, fake LLM responders, or test doubles merely to force passing tests after production changes.
- If the current mainline file paths differ from the likely paths above, modify the discovered current owners and list them in the deliverable; do not edit stale worktree copies.
- If an existing surface already has a partially matching error code, prefer compatibility mapping over deletion.

## Next-Action
Implement the P0.6 stable error contract and cross-surface wiring exactly as scoped above, run targeted and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-072.md` with changed files, test evidence, redaction evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation is scoped to P0.6 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; no unrelated readiness work or cleanup is included.
- [ ] All required stable codes exist exactly as: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a human-readable message in one canonical catalog or explicitly synchronized shared mapping.
- [ ] CLI, API responses, Web UI rendering, and emitted/job events expose the stable code and human-readable message for the relevant failures.
- [ ] Provider/auth/rate-limit details are redacted before reaching CLI, API responses, Web UI payloads, diagnostics, or events.
- [ ] Existing success behavior and existing non-P0.6 failure behavior are preserved.
- [ ] Tests cover common failures and include a regression proving raw provider secret detail is not exposed.
- [ ] Targeted tests for changed areas pass.
- [ ] Standard repo verification for changed areas passes, or any unavailable verification is documented with the exact blocker.
- [ ] `deliverable-072.md` lists changed files, simplifications made, verification evidence, and remaining risks.
