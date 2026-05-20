## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-091
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Title
Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice: P0.6 stable error classes and human-readable messages across CLI/API/Web UI/events for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`, with tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth before touching code.
- Implement only P0.6. Do not start adjacent promotion-readiness items, broad cleanup, unrelated refactors, or behavior changes outside stable error classes/messages.
- Use one central error catalog or the existing central error module if the project already has one, so CLI/API/Web UI/events share the same stable codes, classes, safe user messages, and redaction rules.
- Preserve existing machine-readable error identifiers exactly where they already exist unless they conflict with the required P0.6 codes.
- Provider details shown in user-facing messages, API responses, events, and UI surfaces must be safe/redacted; raw provider errors may only remain in internal logs if the existing logging policy allows it.
- Tests should cover both direct error normalization and representative common failure surfaces rather than duplicating every UI/API/CLI path for every code.

### Rejected
- Rejected implementing additional P0/P1 items from the readiness plan because the task explicitly restricts scope to P0.6.
- Rejected scattering string literals per surface because it would make the stable messages drift between CLI, API, Web UI, and events.
- Rejected exposing raw provider errors in messages/events because the task explicitly requires redacted provider detail.
- Rejected broad error-handling cleanup because it risks behavior changes outside the requested slice.

### Scope

**目标**: Add stable, reusable error classes and human-readable safe messages for the required P0.6 error codes, wire them into existing CLI/API/Web UI/event error presentation paths, and add/adjust tests for common failures plus provider-detail redaction while preserving current behavior outside the requested error normalization.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm P0.6 wording and any project-specific constraints before editing.
- Existing error-definition module(s) located by searching for current error code handling such as `adapter_missing`, `permission_denied`, `worktree_dirty`, `version_mismatch`, `verdict_failed`, `ErrorCode`, `AppError`, or equivalent — add or extend the central stable error class/catalog here.
- Existing CLI error-rendering module(s) located by current command failure handling — render the shared human-readable message and stable code without leaking provider detail.
- Existing API error serialization module(s) located by current HTTP/JSON error handling — serialize stable code/class/message and preserve existing status semantics.
- Existing Web UI error display module(s) located by current error banner/toast/page rendering — display the safe shared human-readable message for these codes.
- Existing event emission/logging module(s) located by current job/project/event error payloads — emit stable code/class/message with redacted details for external events.
- Existing tests nearest the modified modules — add focused coverage for common failures and redaction; add new test files only when no local test target exists.

**实现步骤**:
1. Read the readiness plan and identify the exact P0.6 acceptance language. Record any extra constraints in the deliverable evidence.
2. Map the current error flow from throw/return sites to CLI, API response serialization, Web UI display, and event emission. Keep this mapping limited to the 14 required P0.6 codes.
3. Add or extend a shared stable error definition with:
   - Stable code values for all 14 required codes.
   - A stable class/category for each error, suitable for API/event consumers.
   - Human-readable safe messages for each code.
   - A normalization helper that converts known internal/provider failures into the shared error shape.
   - A redaction helper or equivalent path that strips secrets, tokens, credentials, provider raw payloads, stack traces, request headers, and raw auth/rate-limit details from external messages and events.
4. Wire the shared error shape into CLI rendering so common failures print the stable code and safe message while retaining current exit behavior.
5. Wire the shared error shape into API serialization so existing HTTP statuses are preserved and response bodies include stable code/class/message fields without unsafe detail.
6. Wire the shared error shape into Web UI error presentation so user-visible messages come from the shared catalog for the P0.6 codes.
7. Wire the shared error shape into event payloads so emitted external events include stable code/class/message and omit raw provider detail.
8. Update throw/return sites for common failures to use the stable errors where the mapping is unambiguous:
   - adapter/provider setup/auth/rate-limit failures map to `adapter_missing`, `adapter_auth_failed`, and `provider_rate_limited`.
   - authorization and safety gates map to `permission_denied`, `secret_blocked`, and `delete_blocked`.
   - workspace/source consistency failures map to `worktree_dirty` and `source_path_mismatch`.
   - coordination/state failures map to `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, and `version_mismatch`.
   - verification failure maps to `verdict_failed`.
9. Add focused tests for the shared error catalog/normalizer covering all 14 codes and their safe messages.
10. Add integration or surface-level tests for representative common failures across CLI/API/events, and add Web UI tests if an existing UI test harness already covers error rendering.
11. Add explicit redaction tests using a provider-like detail payload containing token-looking strings, auth headers, request IDs, stack traces, and raw provider message text. Assert external CLI/API/UI/event outputs do not contain unsafe substrings while still showing the stable code and safe message.
12. Run the repository’s relevant test commands already documented for the project. If full test runs are too slow or blocked, run the narrowest affected suites plus the documented broader verification that is feasible, then report gaps honestly.

**注意事项**:
- Keep edits scoped to P0.6 and nearest existing files. Do not rename unrelated types, reorganize modules, or change unrelated error behavior.
- Do not add new dependencies.
- Do not edit fake/mock responders, snapshots, fixtures, or test doubles merely to force tests to pass. Only update them if P0.6 requires a real expected external contract change and explain why in the deliverable.
- Preserve existing API status codes, CLI exit codes, event schemas, and UI flows unless P0.6 explicitly requires the stable code/class/message fields.
- Prefer exhaustive typing or equivalent compile-time checks so missing codes fail loudly.
- Ensure provider detail is redacted in every external surface, not just API responses.

## Next-Action
Implement the P0.6 slice exactly as scoped above. After implementation, run the relevant tests, verify redaction behavior across external surfaces, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-091.md` with changed files, evidence, risks, and any verification gaps.

## Acceptance-Criteria
- [ ] The readiness plan was read and P0.6 was used as the implementation source of truth.
- [ ] All 14 required stable codes exist exactly as specified: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable error class/category and a human-readable safe message from a shared source or equivalent single point of truth.
- [ ] CLI, API serialization, Web UI presentation, and event payloads use the stable code/class/message for the covered failures.
- [ ] External outputs redact provider detail, including secrets, tokens, auth headers, stack traces, and raw provider payload text.
- [ ] Existing status/exit/event behavior is preserved except for adding the required stable error fields/messages.
- [ ] Tests cover the full required code catalog and at least representative common failures for adapter auth/rate limit, permission/safety block, worktree/source mismatch, state/lease/version conflict, and verdict failure.
- [ ] Tests include explicit redacted-provider-detail assertions for external CLI/API/UI/event outputs where those surfaces are present.
- [ ] No unrelated cleanup, dependency additions, or non-P0.6 readiness work is included.
- [ ] All relevant tests pass, or any blocked/unrun tests are documented with concrete reasons in `deliverable-091.md`.
