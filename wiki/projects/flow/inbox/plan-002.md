## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-P0.6
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; before editing code, re-read its P0.6 section and follow it over any inferred detail in this handoff.
- Implement one shared, stable error taxonomy for the P0.6 identifiers, then adapt existing CLI/API/Web UI/event surfaces to consume that taxonomy instead of duplicating strings.
- Preserve current behavior outside error class/message shape: do not change unrelated workflows, command semantics, auth behavior, lock behavior, event persistence format beyond the required stable error fields, or existing success responses.
- Provider-originated details must be redacted before they reach user-visible output, API responses, Web UI state, logs/events, or tests that snapshot those surfaces.
- Add focused regression coverage for common failures and provider-detail redaction; only adjust fake/mock tests when they verify the same real workflow and need updated expected stable error shape.

### Rejected
- Broad cleanup or refactoring outside P0.6 | The directive explicitly limits this slice and requires preserving existing behavior.
- Per-surface ad hoc messages | This would make CLI/API/Web UI/events drift and fail the stable-class requirement.
- Exposing raw provider errors as `detail` for debugging | This risks leaking tokens, credentials, URLs, headers, account IDs, or provider internals.
- Replacing existing error handling wholesale | Higher blast radius than needed; wrap/map existing failures at the boundary where they become user/API/event output.

### Scope

**目标**: Add stable, reusable error classes and human-readable messages for exactly these P0.6 identifiers across CLI, API, Web UI, and event payloads:
`adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements.
- Existing shared/core error module, or the nearest shared package if none exists — define the P0.6 error classes, stable codes, default messages, safe serialization, and redaction helper.
- Existing CLI error formatting/command boundary files — map thrown P0.6 errors to stable CLI output while preserving existing exit behavior.
- Existing API error serialization/route boundary files — return stable JSON error shape and status mapping for P0.6 failures without leaking raw provider detail.
- Existing Web UI error display/state files — display the shared human-readable message and code for P0.6 failures without exposing raw provider detail.
- Existing event writer/reader/reconciliation files — emit and consume stable P0.6 event error fields, including `event_log_corrupt` and `job_reconciled`.
- Existing tests covering CLI/API/Web UI/events plus focused new tests where coverage is missing — verify common failures and redacted provider detail.

**实现步骤**:
1. Re-read the P0.6 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; record any exact acceptance language in the deliverable and do not implement adjacent P0/P1 items.
2. Locate existing error primitives and boundary formatters for CLI, API, Web UI, and events. Prefer extending existing helpers over creating parallel systems.
3. Add a shared P0.6 taxonomy with one stable class/factory per code, a common base error type, and a serializer that exposes only safe fields:
   - stable `code`
   - human-readable `message`
   - optional safe `hint` or `retryAfter` only when already available and non-sensitive
   - redacted provider detail for diagnostics only where the existing architecture already supports safe internal diagnostics
4. Define default human-readable messages for all 14 codes in one place. Keep them action-oriented and non-provider-specific:
   - `adapter_missing`: adapter/provider is not configured or installed.
   - `adapter_auth_failed`: provider authentication failed; reconnect or update credentials.
   - `provider_rate_limited`: provider rate limit reached; retry after cooldown.
   - `permission_denied`: user or process lacks permission for the action.
   - `secret_blocked`: secret-like content was blocked.
   - `delete_blocked`: delete was blocked because the target is protected or in use.
   - `worktree_dirty`: worktree has uncommitted changes and needs cleanup before proceeding.
   - `source_path_mismatch`: provided source path does not match the registered project path.
   - `lease_stale`: lease is stale; refresh state and retry.
   - `event_log_corrupt`: event log could not be read safely.
   - `job_reconciled`: job state was reconciled after restart or recovery.
   - `project_lock_busy`: another operation holds the project lock.
   - `version_mismatch`: requested version does not match current state.
   - `verdict_failed`: verification verdict failed and should be reviewed.
5. Wire existing adapter/provider failures into the taxonomy:
   - missing adapter/provider lookup -> `adapter_missing`
   - provider auth/401/credential failures -> `adapter_auth_failed`
   - provider 429/rate-limit responses -> `provider_rate_limited`
   Ensure raw provider messages, headers, request URLs, tokens, keys, and credential values are not surfaced.
6. Wire existing local policy/state failures into the taxonomy:
   - authorization/ACL failure -> `permission_denied`
   - secret scanner/blocker -> `secret_blocked`
   - protected/in-use delete paths -> `delete_blocked`
   - dirty worktree guard -> `worktree_dirty`
   - registered source path guard -> `source_path_mismatch`
   - stale lease guard -> `lease_stale`
   - busy project lock -> `project_lock_busy`
   - optimistic concurrency/version check -> `version_mismatch`
   - failed verdict/verification gate -> `verdict_failed`
7. Wire event-specific behavior:
   - corrupt event log read/parse path should emit or return `event_log_corrupt` with a safe message and no raw parse dump in user-visible output.
   - reconciliation path should emit `job_reconciled` with a stable message and preserve existing reconciliation semantics.
   - Event payloads should carry stable machine-readable code plus human-readable message, not only free-form text.
8. Update CLI/API/Web UI presentation only at boundary layers:
   - CLI prints stable message and code in the existing style; keep existing exit code mapping unless P0.6 explicitly says otherwise.
   - API returns stable error JSON using existing response conventions and status codes; do not change successful response contracts.
   - Web UI shows stable message/code in existing error components; do not redesign UI or add unrelated copy.
   - Events include stable code/message fields while preserving existing event names and non-error fields unless the source plan requires a minimal schema addition.
9. Add or adjust tests for common failures:
   - adapter missing, adapter auth failure, provider rate limit
   - permission denied, secret blocked, delete blocked
   - dirty worktree, source path mismatch, stale lease
   - event log corrupt, job reconciled
   - project lock busy, version mismatch, verdict failed
10. Add redaction tests with representative unsafe provider detail:
    - bearer token or API key in headers
    - credential-looking JSON fields such as `token`, `secret`, `password`, `apiKey`
    - provider URL query parameters containing credentials
    - raw provider error object/message containing account-specific or credential-like values
    Assert CLI output, API JSON, Web UI-rendered text/state, and event payloads contain the stable code/message and do not contain unsafe substrings.
11. Run the repository’s normal verification for the touched surfaces: focused unit/integration tests first, then lint/typecheck/full test suite if available. Do not edit snapshots, fixtures, fake providers, or test doubles merely to hide behavior changes; update them only when the stable P0.6 error contract is the intended observed behavior.
12. Write `deliverable-002.md` after implementation with changed files, exact commands run, test output summaries, remaining risks, and confirmation that no unrelated cleanup was included.

**注意事项**:
- Keep this slice scoped to P0.6 only.
- Keep all 14 codes stable and snake_case exactly as listed.
- Prefer existing project error/serialization patterns; introduce a new shared module only if no suitable shared error surface exists.
- Preserve existing exit codes, HTTP statuses, event names, and UI layout unless the P0.6 source plan explicitly requires a minimal change.
- Redaction must happen before details cross process/user/API/event boundaries; tests should fail if raw provider detail appears in any visible surface.
- `job_reconciled` may be informational rather than exceptional in existing code. Still provide the stable class/message/event representation required by P0.6 without turning successful reconciliation into a failure.

### Evidence
- Planning-only handoff created under the requested inbox path.
- No terminal commands, package managers, git commands, or implementation commands were run in this planning phase.
- The executor must re-read the promotion readiness plan before implementation because it is the source of truth for P0.6.

### Risks
- Existing code may already have multiple independent error shapes; unifying only the P0.6 boundary behavior is required, while a deeper migration would be out of scope.
- Redaction can be incomplete if provider detail is serialized before entering shared error handling; tests must cover each visible surface, not just the shared helper.
- `job_reconciled` may not currently be modeled as an error. Implement it as the stable P0.6 event/class representation without changing reconciliation success semantics.

## Next-Action
Implement only P0.6 from the promotion readiness plan. Read the source plan first, add the shared stable error taxonomy and redaction behavior, wire CLI/API/Web UI/events through it at their existing boundaries, add focused tests for common failures and redacted provider detail, run verification, then generate `deliverable-002.md`.

## Acceptance-Criteria
- [ ] The implementation was checked against `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` before code edits.
- [ ] Exactly these 14 stable codes exist and are exposed unchanged where applicable: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each code has a stable error class or equivalent project-standard typed error representation and a centralized human-readable default message.
- [ ] CLI common failure output includes stable code/message and preserves existing command behavior and exit semantics.
- [ ] API common failure responses include stable code/message using existing response conventions and do not alter successful response contracts.
- [ ] Web UI common failure rendering displays the stable message/code using existing UI patterns without exposing raw provider detail.
- [ ] Event payloads for relevant failures/reconciliation include stable machine-readable code and human-readable message while preserving existing event behavior.
- [ ] Adapter/provider failures map to `adapter_missing`, `adapter_auth_failed`, and `provider_rate_limited` with raw provider details redacted.
- [ ] Local guard/state failures map to `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Event corruption/reconciliation paths cover `event_log_corrupt` and `job_reconciled`.
- [ ] Tests cover common failures across CLI/API/Web UI/events where those surfaces exist in the repo.
- [ ] Tests prove credential-like provider details are redacted from CLI output, API JSON, Web UI-rendered output/state, and event payloads.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup, dependency additions, formatting churn, or broad refactors are included.
- [ ] Relevant lint, typecheck, and tests pass, or any unavailable verification is explicitly documented in `deliverable-002.md`.
