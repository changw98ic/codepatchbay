# Plan 029 — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-029-P0.6
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Use `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.6 slice.
- Introduce or extend a single stable error taxonomy for the required error codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Each error must expose a stable machine-readable code and a human-readable message that can be reused consistently by CLI output, API responses, Web UI rendering, and event payloads.
- Provider-originated details must be redacted before they reach CLI/API/Web UI/events, while preserving enough safe context for users to understand the failure class.
- Preserve existing behavior and public contracts except where the P0.6 readiness plan explicitly requires stable error classes/messages.
- Keep implementation scoped to existing error handling, serialization, CLI rendering, API response, Web UI presentation, and event emission paths touched by these failures.

### Rejected
- Broad cleanup or error-handling refactors outside the listed P0.6 error codes, because the task explicitly says not to broaden into unrelated cleanup.
- Changing unrelated fake/mock responders, snapshots, fixtures, or test doubles solely to make tests pass, because existing project guidance forbids this unless the fake/test double itself is the product bug.
- Introducing a new dependency for error taxonomy, redaction, or formatting, because existing local patterns should be reused and the task does not request new dependencies.
- Rewriting user-facing copy across the product outside these failures, because the P0 slice is limited to the named error cases.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan by adding stable error classes and human-readable messages for the required failure codes across CLI/API/Web UI/events, with focused tests for common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements.
- Existing shared error/taxonomy module — add or extend stable error classes, code constants, default messages, serialization helpers, and redaction boundaries.
- Existing adapter/provider error handling modules — map adapter/provider failures into the stable error taxonomy without leaking raw provider secrets or sensitive detail.
- Existing permission, secret, delete, worktree, lease, event-log, reconciliation, project-lock, version, and verdict failure paths — convert common thrown/returned failures to the stable classes where currently ad hoc.
- Existing CLI error rendering tests and implementation — ensure stable codes and human-readable messages appear in CLI output for representative failures.
- Existing API error response tests and implementation — ensure response bodies expose stable error codes/messages and redact provider detail.
- Existing Web UI error display tests and implementation — ensure UI receives/renders the stable message/code shape without raw provider detail.
- Existing event emission/logging tests and implementation — ensure event payloads use stable codes/messages and redact provider detail.

**实现步骤**:
1. Read the P0.6 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify any wording or acceptance requirements not already captured here.
2. Locate the current shared error handling and serialization paths used by CLI, API, Web UI, and events. Reuse existing project patterns instead of creating a parallel framework.
3. Define the stable error catalog for all required codes with deterministic names/classes, stable `code` values, default human-readable `message` values, and a safe serialization shape.
4. Add a redaction helper or extend the existing one so provider details are sanitized before serialization. Cover provider API keys, tokens, credentials, authorization headers, raw provider response bodies, and secret-like substrings.
5. Map adapter and provider failures into the catalog:
   - `adapter_missing`
   - `adapter_auth_failed`
   - `provider_rate_limited`
6. Map authorization and guarded-operation failures into the catalog:
   - `permission_denied`
   - `secret_blocked`
   - `delete_blocked`
7. Map repository/worktree/source-state failures into the catalog:
   - `worktree_dirty`
   - `source_path_mismatch`
8. Map coordination, event-log, reconciliation, lock, version, and verdict failures into the catalog:
   - `lease_stale`
   - `event_log_corrupt`
   - `job_reconciled`
   - `project_lock_busy`
   - `version_mismatch`
   - `verdict_failed`
9. Update CLI rendering so common failures show a human-readable message plus the stable code, using existing formatting conventions.
10. Update API response serialization so common failures return the stable code/message shape and any provider/internal detail is redacted.
11. Update Web UI error consumption/rendering so it displays the stable human-readable message and does not depend on brittle raw exception text.
12. Update event emission so failure events include the stable code/message shape and redacted detail only.
13. Add focused tests for common failures across CLI/API/Web UI/events. Prioritize representative paths that prove the shared taxonomy is used rather than duplicating every code in every surface.
14. Add explicit tests proving raw provider detail is redacted in API responses, CLI output, Web UI-visible payloads, and event payloads.
15. Run the relevant targeted tests first, then the project’s normal lint/typecheck/test commands appropriate for this change. Do not modify unrelated test fixtures or mocks merely to force green results.
16. Write `deliverable-029.md` with changed files, test evidence, implementation notes, and any remaining risks.

**注意事项**:
- Keep changes narrowly scoped to P0.6. Do not implement other P0/P1 promotion readiness items.
- Preserve existing behavior where no listed stable error code applies.
- Prefer adapting current error classes/utilities over adding a new abstraction layer.
- Do not expose raw provider response bodies, credentials, tokens, authorization headers, file contents, or secret values in messages, API bodies, Web UI payloads, event payloads, logs, or test snapshots.
- Human-readable messages should be actionable but generic enough to stay stable. Put volatile details in redacted/safe metadata only if existing contracts support metadata.
- Stable codes must not vary by provider, locale, stack trace, or transport surface.
- If an existing test fake does not represent the real failure path, report the mismatch in the deliverable instead of rewriting the fake as a shortcut.

## Next-Action
Implement the P0.6 slice exactly as scoped above, run focused and standard verification, then write `deliverable-029.md` for Codex review with changed files, evidence, and remaining risks.

## Acceptance-Criteria
- [ ] All required error codes are represented by stable error classes or equivalent stable taxonomy entries: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Each required error has a deterministic machine-readable code and a human-readable default message.
- [ ] CLI output for representative common failures includes the stable code and human-readable message.
- [ ] API error responses for representative common failures include the stable code and human-readable message.
- [ ] Web UI-visible error payloads/rendering for representative common failures use the stable code/message shape instead of raw exception text.
- [ ] Event failure payloads for representative common failures include the stable code/message shape.
- [ ] Provider-originated sensitive detail is redacted across CLI/API/Web UI/events, with tests proving raw provider detail does not leak.
- [ ] Existing behavior is preserved for unrelated success paths and unrelated error paths.
- [ ] Tests are added or adjusted only where they directly cover P0.6 behavior.
- [ ] Relevant targeted tests pass.
- [ ] The project’s normal lint/typecheck/test verification appropriate for this change passes, or any unavailable verification is explicitly documented in `deliverable-029.md`.
- [ ] Code style matches existing project patterns and no new dependency is introduced unless the deliverable explicitly documents a blocker that made it unavoidable.
