## Handoff: codex -> claude — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-055-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth; implement only P0.6.
- Add or reuse one canonical error taxonomy module so CLI, API, Web UI, and event-log surfaces derive from the same stable error classes, codes, and human-readable messages.
- Cover exactly these stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Preserve existing behavior and public result shapes except for adding stable machine-readable error codes/classes and clearer human-readable messages where the current error path is unstable or opaque.
- Redact provider details at the taxonomy boundary before errors can reach CLI output, API responses, Web UI state, or serialized events.

### Rejected
- Broad cleanup of unrelated error handling | P0.6 requires a scoped promotion-readiness slice only.
- Per-surface duplicated message maps | duplication risks drift between CLI, API, Web UI, and events.
- Snapshot or fake-only updates to force passing tests | tests must verify the intended real workflow or focused purpose-built fixtures.
- Exposing raw provider exception text, headers, tokens, keys, paths with secrets, or request/response bodies | P0.6 explicitly requires redacted provider detail.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan by introducing stable error classes and human-readable messages for the listed codes across CLI, API, Web UI, and event serialization, with focused tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements; do not edit.
- Existing shared error/result modules discovered in the repo — add the canonical error classes, code enum/union, message map, redaction helper, and serialization helpers here.
- Existing CLI command/error rendering files discovered in the repo — map thrown/domain errors into stable codes and human-readable messages without changing successful command behavior.
- Existing API route/handler/error response files discovered in the repo — return stable error codes/classes and redacted messages/details in error responses.
- Existing Web UI error display/state files discovered in the repo — render human-readable messages from stable codes and avoid raw provider detail.
- Existing event-log/job/project event serialization files discovered in the repo — serialize stable error codes/classes/messages for event records, including reconciliation and corrupt-log paths.
- Existing tests for CLI, API, Web UI, events, providers, worktrees, leases, project locks, verdicts, and secret blocking — add or adjust focused tests for the P0.6 failure paths.

**实现步骤**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and note any exact wording, constraints, and expected surfaces before editing.
2. Locate current error primitives and call sites for provider adapters, auth/rate-limit handling, permission checks, secret blocking, delete blocking, worktree dirtiness, source path validation, leases, event-log corruption, job reconciliation, project locks, version checks, and verdict failures.
3. Add the canonical taxonomy in the existing shared error/result layer:
   - stable code/type coverage for all 14 required codes;
   - a domain error class or class hierarchy with `code`, `message`, optional redacted `details`, and optional underlying `cause`;
   - a message map with concise human-readable copy for each code;
   - a sanitizer/redactor that strips provider secrets and raw provider diagnostic payloads before serialization.
4. Wire CLI error rendering to consume the taxonomy:
   - known failures should display the human-readable message and stable code;
   - unknown failures should keep existing fallback behavior;
   - provider auth and rate-limit failures must not expose raw provider text containing tokens, keys, headers, or full responses.
5. Wire API error responses to consume the taxonomy:
   - return stable `code`/class and human-readable `message`;
   - include only explicitly safe redacted detail;
   - preserve existing HTTP status semantics where they already exist.
6. Wire Web UI error handling to consume the same stable codes/messages:
   - display human-readable messages for common failures;
   - keep existing UI flow/state transitions;
   - do not introduce new visual redesign or unrelated UX changes.
7. Wire event serialization/deserialization to include stable codes/messages for relevant failure events:
   - include `event_log_corrupt`, `job_reconciled`, `lease_stale`, `project_lock_busy`, `version_mismatch`, and `verdict_failed` where those paths already emit or persist events;
   - keep backwards compatibility for existing event records that lack the new fields.
8. Add focused regression tests:
   - taxonomy coverage test asserts all 14 required codes have stable class/code/message definitions;
   - provider detail redaction test proves sensitive provider detail is absent from CLI/API/event/UI-safe payloads;
   - common failure tests cover at least adapter missing, adapter auth failed, provider rate limited, permission denied, secret blocked, delete blocked, worktree dirty, lease stale, event log corrupt, project lock busy, version mismatch, and verdict failed through the closest existing unit/integration surfaces;
   - Web UI tests should assert rendered message/code behavior only where the project already has UI test infrastructure.
9. Run the repo’s relevant lint/typecheck/test commands for the touched areas, then broaden only to the standard project verification suite if the P0.6 source plan requires it.
10. Write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-055.md` using the handshake protocol with changed files, commands run, evidence, risks, and any known verification gaps.

**注意事项**:
- Keep changes scoped to P0.6; do not refactor unrelated errors, redesign UI, rename unrelated fields, or normalize unrelated event schemas.
- Do not add dependencies unless the promotion-readiness plan explicitly requires one.
- Do not modify fake/mock tests, snapshots, fixtures, or test doubles merely to mask production behavior changes.
- Preserve existing successful behavior, HTTP statuses, CLI exit semantics, Web UI flows, and event compatibility unless the P0.6 plan explicitly says otherwise.
- Stable error codes are part of the contract; do not change spelling, casing, or separators from the required snake_case list.
- Redaction must happen before data reaches externally visible surfaces, not only in one renderer.
- If an existing module already defines equivalent domain errors, extend it instead of creating a parallel taxonomy.

## Next-Action
Implement P0.6 exactly as scoped above. Start by reading the promotion-readiness plan section for P0.6, then make the smallest production and test changes needed to provide stable error classes and human-readable messages across CLI, API, Web UI, and events. Run the relevant verification commands and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-055.md` when complete.

## Acceptance-Criteria
- [ ] `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read and P0.6 was followed as the source of truth.
- [ ] Exactly these stable codes are implemented and covered by tests: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI, API, Web UI, and event serialization all use the canonical taxonomy or a shared mapping derived from it.
- [ ] Human-readable messages exist for every required code and are asserted by tests where rendering/serialization is covered.
- [ ] Provider auth/rate-limit/error detail is redacted before reaching CLI output, API responses, Web UI display/state, or event payloads.
- [ ] Existing successful behavior and existing public semantics are preserved outside the scoped P0.6 error improvements.
- [ ] Focused tests cover common failures and redacted provider detail.
- [ ] Relevant lint, typecheck, and test commands for touched areas pass.
- [ ] Implementation does not broaden into unrelated cleanup, dependency additions, UI redesign, or unrelated event-schema changes.
