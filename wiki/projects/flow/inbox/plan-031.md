## Handoff: codex -> claude — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-031 / P0.6
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Use `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before any implementation edits.
- Implement only P0.6: stable error classes/codes and human-readable messages for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Preserve existing behavior by adding a central error taxonomy/mapping around current failure paths rather than rewriting unrelated control flow.
- Every external surface that already reports these failures must emit the same stable code and a human-readable message: CLI, API, Web UI, and event/log payloads.
- Provider/auth detail must be redacted before it reaches CLI output, API responses, Web UI state, event logs, or test snapshots.
- Add or adjust tests only for this P0.6 slice, focusing on common failures and provider-detail redaction.

### Rejected
- Broad cleanup/refactor outside the error-code/message path; the task explicitly says not to broaden into unrelated cleanup.
- Adding new dependencies for error handling or redaction; the existing project patterns should be sufficient.
- Encoding provider-specific raw errors directly in user-facing messages or persisted events; this risks leaking credentials, tokens, headers, or account identifiers.
- Updating fake/mock responders merely to hide production behavior changes; only adjust tests/fakes when needed to represent the intended real P0.6 contract.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: stable error classes/codes plus human-readable, redacted messages across CLI/API/Web UI/events for the listed failures, with focused tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — required source-of-truth document; read before editing and follow its P0.6 wording if it is more specific than this handoff.
- Existing error/taxonomy module in the Flow source tree — add the stable error class/code/message definitions here if one already exists.
- Existing CLI error-rendering module in the Flow source tree — map thrown/domain errors to stable codes and human-readable messages without changing unrelated command behavior.
- Existing API error-response module in the Flow source tree — serialize the same stable codes/messages and redact provider detail.
- Existing Web UI error-display module in the Flow source tree — consume and display the stable human-readable messages without exposing raw provider detail.
- Existing event/log writer or event payload module in the Flow source tree — include stable codes/messages in emitted events and ensure persisted details are redacted.
- Existing tests covering CLI/API/Web UI/events error behavior — add or adjust focused assertions for the P0.6 cases and provider-detail redaction.

**实现步骤**:
1. Read the promotion readiness plan and extract the exact P0.6 requirements. If this handoff and the source plan differ, follow the source plan and mention the difference in the deliverable.
2. Locate the current error paths for all fourteen P0.6 codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
3. Add a central stable error definition layer using the repo's existing style. Each definition must include a stable machine code, a typed/classed error representation, and a default human-readable message.
4. Wire CLI rendering to the central definitions so common failures show the stable code and readable message while preserving existing exit codes and command semantics unless the source plan explicitly requires otherwise.
5. Wire API serialization to the central definitions so responses expose stable code/message fields and do not include raw provider exceptions, tokens, headers, stack traces, or secret-like substrings.
6. Wire Web UI error display to consume the same code/message contract from API or client-side domain errors. Keep existing layout and behavior; only change the error text/shape required for P0.6.
7. Wire event/log payloads to include the stable error code/message where these failures are recorded. Redact provider details before persistence or emission.
8. Add focused regression tests for common failures across the surfaces that already have tests. At minimum cover adapter missing/auth failure, provider rate limiting, permission/secret/delete/worktree-blocking errors, stale lease/project lock/version mismatch, event log corruption, reconciliation, source-path mismatch, verdict failure, and provider-detail redaction.
9. Run the repo's relevant lint/typecheck/test commands after changes. If the full suite is too costly, run the narrow suites for changed CLI/API/Web UI/events areas and clearly report what was not run.
10. Write `deliverable-031.md` with changed files, tests run, evidence, any source-plan deltas, and remaining risks.

**注意事项**:
- Keep changes scoped to P0.6 only.
- Do not rename public APIs, alter unrelated control flow, or perform opportunistic cleanup.
- Do not add dependencies.
- Do not leak provider raw details in user-facing output or persisted events.
- Preserve existing behavior outside stable error class/code/message reporting.
- If existing tests rely on raw provider detail appearing in output, treat that as stale coverage and update only the assertions needed for the P0.6 redaction contract.

## Next-Action
Implement the P0.6 changes exactly as scoped above, run focused verification, and write `deliverable-031.md` for Codex review.

## Acceptance-Criteria
- [ ] The implementation is grounded in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, and any P0.6-specific nuance from that file is reflected in the code or deliverable.
- [ ] Stable error classes/codes/messages exist for all required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] CLI failures for the covered cases render a human-readable message and stable code while preserving existing exit semantics unless the source plan explicitly says otherwise.
- [ ] API failures for the covered cases serialize stable code/message fields and exclude raw provider details, credentials, headers, stack traces, and secret-like substrings.
- [ ] Web UI error presentation uses the stable human-readable message contract and does not display raw provider details.
- [ ] Event/log payloads for covered failures include stable code/message data and persist only redacted provider detail.
- [ ] Tests cover common failure paths and at least one explicit redacted-provider-detail case.
- [ ] Existing behavior outside P0.6 remains unchanged.
- [ ] Relevant lint/typecheck/test commands pass, or any skipped verification is explicitly justified in `deliverable-031.md`.
- [ ] Code style remains consistent with the existing project.
