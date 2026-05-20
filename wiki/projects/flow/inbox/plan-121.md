# Plan 121 — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-121-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Add one canonical stable error taxonomy for these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each stable error should expose a machine-stable code/class plus a human-readable message suitable for CLI/API/Web UI/events.
- Provider or adapter details must be redacted before they cross user-visible or persisted event boundaries.
- Preserve existing behavior and public flow control; this slice should normalize presentation and classification, not redesign execution.

### Rejected
- Broad cleanup or error-handling refactors outside P0.6 | explicitly out of scope for this handoff.
- Adding new dependencies for formatting, validation, or redaction | unnecessary for a scoped stable-error slice.
- Rewriting tests around fake/mock responders just to make assertions pass | project guidance forbids weakening test doubles after production behavior changes.
- Introducing unrelated API response shape changes | risks breaking existing callers beyond the promotion-readiness requirement.

### Scope

**目标**: Implement P0.6 only: stable error classes/codes and human-readable messages for the listed failure conditions across CLI, API, Web UI, and event/log surfaces, with regression tests for common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements; do not edit.
- Existing shared error module(s), likely under `src/**`, `lib/**`, or package-local equivalents — add or extend canonical stable error definitions, constructors, serializers, and redaction helpers.
- Existing CLI command/error rendering modules — map thrown/returned stable errors to readable CLI output without changing successful behavior.
- Existing API route/controller/error middleware modules — map stable errors to API error payloads while preserving current status-code semantics unless P0.6 explicitly requires a specific mapping.
- Existing Web UI error display modules/components — render the canonical human-readable message instead of raw provider/internal detail.
- Existing event/log emission modules — emit stable codes/classes and redacted messages/details for the listed errors.
- Existing test files near the touched modules — add focused tests for common failure paths and redacted provider detail.

**实现步骤**:
1. Read the promotion readiness plan and locate the exact P0.6 wording. Record any status-code, UI copy, event schema, or redaction constraints found there before editing.
2. Inventory current error handling for CLI/API/Web UI/events using code search. Identify existing error classes, error-code conventions, serializers, status mapping, UI copy paths, and event payload fields.
3. Add or extend a canonical stable-error definition layer with the 14 required codes. For each code, define:
   - stable machine code exactly matching the required snake_case value;
   - stable class/type identity if the project already uses class-based errors;
   - default human-readable message;
   - safe public details field(s), if the project already exposes details;
   - redaction behavior for provider/adapter/raw-error detail.
4. Wire existing failure sites to produce or translate into the canonical errors without changing successful paths. Cover at least these likely sources:
   - missing adapter/provider;
   - adapter authentication failure;
   - provider rate limit;
   - permission or policy denial;
   - secret-blocked operation;
   - delete-blocked operation;
   - dirty worktree;
   - source path mismatch;
   - stale lease;
   - corrupt event log;
   - reconciled job;
   - busy project lock;
   - version mismatch;
   - failed verdict.
5. Update CLI rendering so known stable errors show readable, actionable messages and stable codes. Preserve existing non-stable/unexpected error behavior.
6. Update API serialization so stable errors include stable code/class and safe message, with redacted provider details. Keep existing HTTP status behavior unless the source plan requires a change.
7. Update Web UI error consumption/display so known stable errors show the canonical readable message and never raw provider secrets, tokens, headers, stack traces, or opaque adapter payloads.
8. Update event/log emission so stable errors are persisted/emitted with stable code/class and redacted details. Ensure corrupt-log or reconciliation paths do not expose raw provider detail.
9. Add or adjust tests in the smallest existing test scopes:
   - unit tests for canonical stable error definitions and redaction;
   - CLI tests for at least one representative common failure;
   - API serialization tests for stable code/message and redacted detail;
   - Web UI rendering tests for stable message display;
   - event/log tests for stable code and redacted provider detail.
10. Run the repo’s existing targeted tests for touched areas first, then the normal lint/typecheck/test suite if feasible. Fix only failures caused by this P0.6 change.
11. Produce `deliverable-121.md` with changed files, test evidence, simplifications made, and remaining risks.

**注意事项**:
- Keep the implementation scoped to P0.6. Do not broaden into unrelated cleanup, naming churn, dependency updates, formatting sweeps, or architecture rewrites.
- Preserve existing behavior for successful flows and unknown/unexpected errors.
- Prefer existing project error utilities, status mapping, logger/event helpers, and UI components over new abstractions.
- Redaction must happen before provider detail reaches CLI output, API payloads, Web UI props/state, or persisted events.
- Human-readable messages should be stable enough for tests, but avoid overfitting tests to full prose where the existing project convention prefers code plus partial message assertions.
- Do not modify fake/mock tests, fixtures, or test doubles merely to force compatibility unless the fixture itself represents the intended stable-error contract.
- If the source plan contains stricter names, messages, status mappings, or event fields than this handoff, follow the source plan.

## Next-Action
Implement the scoped P0.6 stable-error taxonomy and surface mappings described above, run focused and relevant full verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-121.md` with evidence.

## Acceptance-Criteria
- [ ] The implementation covers exactly these stable error codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each listed error has a stable class/type or equivalent project-native classification, a stable machine code, and a human-readable message.
- [ ] CLI output for known stable errors includes the stable code and human-readable message without exposing raw provider details.
- [ ] API error serialization for known stable errors includes stable code/class and safe human-readable message while preserving existing status-code behavior unless the source plan requires otherwise.
- [ ] Web UI error display for known stable errors uses the canonical readable message and does not expose raw provider/internal detail.
- [ ] Event/log payloads for known stable errors include stable code/class and redacted safe detail only.
- [ ] Tests cover common failure paths across at least CLI/API/Web UI/events where those surfaces exist in the repo.
- [ ] Tests prove provider detail redaction for at least authentication failure and rate-limit style failures.
- [ ] Existing successful behavior is preserved, with no unrelated cleanup or dependency additions.
- [ ] Targeted tests for touched areas pass.
- [ ] Normal repo verification passes where feasible; any skipped verification is documented in `deliverable-121.md` with the reason.
