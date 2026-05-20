## Handoff: codex -> claude

### Plan Title
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-027
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authority for P0.6 and do not implement adjacent P0/P1 items.
- Add one stable internal error contract for the exact P0.6 codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each error must expose a stable machine-readable code, a stable class/type, a human-readable message, and a serialization shape that can be reused by CLI, API, Web UI, and event emission.
- Provider or adapter details returned to users, API clients, UI state, logs intended for users, and emitted events must be redacted when they may contain secrets, tokens, credentials, raw provider responses, paths beyond existing safe display conventions, or authorization material.
- Tests must lock the shared error contract first, then cover representative user-facing surfaces rather than duplicating every code across every surface.
- Preserve existing behavior outside the stable code/class/message additions and targeted redaction fixes.

### Rejected
- Broad cleanup of unrelated error handling, command plumbing, UI architecture, event schemas, or provider abstractions — outside P0.6 scope.
- Renaming existing public commands, API routes, event names, or UI workflows just to make the new error contract cleaner — unnecessary behavioral risk.
- Implementing separate hardcoded message tables independently in CLI, API, Web UI, and event code — risks drift; prefer a shared contract or the nearest existing shared equivalent.
- Adding a new dependency for error typing, schema validation, or redaction — not required for this scoped P0.6 slice unless the promotion readiness source plan explicitly already requires it.
- Editing fake/mock tests, fixtures, snapshots, or provider responders merely to force tests through after production behavior changes; only update test doubles when they must model the new stable contract or redaction requirement.

### Scope

**目标**: Implement P0.6 only: stable error classes/codes/messages and safe redacted error detail propagation across CLI, API, Web UI, and events for the exact listed error codes.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first as the source of truth; do not modify.
- Existing shared error/domain module in `/Users/chengwen/dev/flow` — add or extend the canonical stable error definitions here, using the repository's current ownership pattern.
- Existing CLI error rendering path in `/Users/chengwen/dev/flow` — route thrown/returned P0.6 errors through stable codes and human-readable messages.
- Existing API error serialization path in `/Users/chengwen/dev/flow` — expose stable codes/messages and redacted details without leaking provider internals.
- Existing Web UI error display path in `/Users/chengwen/dev/flow` — display the human-readable messages for the stable codes while preserving current UI behavior.
- Existing event emission/logging path in `/Users/chengwen/dev/flow` — include stable codes/messages for relevant failures and ensure provider detail is redacted.
- Existing tests near shared errors, CLI failures, API failures, Web UI error handling, and event emission — add or adjust focused tests for common failures and redacted provider detail.

**实现步骤**:
1. Read the promotion readiness plan and extract only the P0.6 requirements. Record in the deliverable if it contains any nuance beyond the codes listed in this handoff.
2. Discover the existing owners for error classes, CLI error rendering, API error serialization, Web UI error display, event emission, and tests. Keep the implementation in those existing ownership boundaries.
3. Add or extend the canonical stable error model:
   - Define stable classes or class-like constructors for all 14 required codes.
   - Ensure each definition has a stable code and human-readable default message.
   - Support optional structured details, but pass all external/provider detail through the existing redaction utility or a small local redaction helper in the shared error layer.
   - Keep messages specific enough for users to act on, but do not expose secrets or raw provider payloads.
4. Wire the shared stable error model into the CLI:
   - Convert common P0.6 failures to the canonical errors at the boundary where they are currently detected.
   - Render the human-readable message and stable code consistently with the current CLI style.
   - Preserve exit code behavior unless the source plan explicitly requires a change.
5. Wire the shared stable error model into the API:
   - Serialize canonical errors with stable code and message.
   - Include only redacted safe details.
   - Preserve existing HTTP status mapping unless the source plan explicitly defines a different mapping.
6. Wire the shared stable error model into Web UI handling:
   - Map API or local stable error codes to the canonical human-readable messages.
   - Preserve current interaction flow and component layout.
   - Avoid adding new UI copy outside the required error messages.
7. Wire the shared stable error model into event emission/logging:
   - Include stable error code and human-readable message where failure events are emitted.
   - Redact provider detail before event payloads are persisted, streamed, or exposed.
   - Do not change event names or ordering except where needed to represent the stable error contract.
8. Add focused tests:
   - Shared contract test that all 14 required codes exist, have stable classes/class-like constructors, and have non-empty human-readable messages.
   - CLI test for at least one common local failure, such as `adapter_missing`, `worktree_dirty`, or `permission_denied`, asserting stable code and message.
   - API serialization test for at least one common failure, asserting code/message/status and redacted details.
   - Web UI test for a representative stable error, asserting the user sees the human-readable message rather than raw provider detail.
   - Event emission test for a representative failure, asserting code/message are present and provider detail is redacted.
   - Redaction regression test using provider detail containing token-like, key-like, credential-like, and raw response fields.
9. Run the repository's relevant test commands for the touched packages first, then the broader standard verification command set if practical. If any standard verification cannot run, explain the reason and include the narrower evidence that did run.
10. Write `deliverable-027.md` for Codex review with changed files, decisions, rejected alternatives, test output, known risks, and explicit confirmation that no non-P0.6 cleanup was included.

**注意事项**:
- Do not implement other promotion readiness items.
- Do not broaden into unrelated cleanup or error architecture rewrites.
- Do not add dependencies unless the source plan already mandates one.
- Do not expose raw provider responses, adapter auth material, secrets, tokens, or credential-like values in CLI/API/Web UI/events/tests.
- Do not change public behavior unrelated to error class/code/message stability and redacted detail handling.
- If the codebase already has stable error helpers, extend them instead of creating a competing parallel system.
- If the same failure can surface through multiple layers, convert to the canonical error once at the lowest appropriate boundary and preserve it upward.
- If an existing fake/test double no longer models the intended real workflow, report the mismatch and add a purpose-built verification path instead of editing the fake only to satisfy assertions.

## Next-Action
Implement only the P0.6 stable error contract described above, using the promotion readiness plan as the source of truth. Keep changes scoped to existing error, surface-rendering, event, and test ownership boundaries. Run focused and standard verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-027.md` with implementation evidence for Codex review.

## Acceptance-Criteria
- [ ] The promotion readiness source plan was read and P0.6 was implemented without adjacent P0/P1 work.
- [ ] All 14 required codes exist as stable error classes or class-like definitions: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required error has a stable machine-readable code and a non-empty human-readable message.
- [ ] CLI output for representative common failures includes the stable code/message and preserves existing exit behavior unless the source plan says otherwise.
- [ ] API error responses for representative common failures include stable code/message/status and omit or redact unsafe provider detail.
- [ ] Web UI error handling displays human-readable messages for representative stable errors and does not expose raw provider detail.
- [ ] Event payloads for representative failures include stable code/message and do not persist, stream, or expose unsafe provider detail.
- [ ] Tests cover the shared error contract, common failure surfaces, and redacted provider detail.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup, dependency addition, route/command rename, or broad refactor is included.
- [ ] Relevant tests pass, and the deliverable includes exact verification commands and outputs.
