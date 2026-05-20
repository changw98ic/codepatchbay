## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-065
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Title
Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth; implement only P0.6.
- Introduce a single canonical error taxonomy with stable machine codes for: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each canonical error must expose a stable class/type, stable code, human-readable message, and safe/redacted detail fields suitable for CLI, API responses, Web UI rendering, and emitted events.
- Provider-originated detail must be redacted before leaving the canonical error boundary; tests must prove secrets/tokens/provider raw detail do not leak.
- Preserve existing behavior by mapping existing failure paths to the new canonical errors without changing control flow, retry behavior, exit behavior, lock semantics, delete protections, lease handling, reconciliation behavior, or verdict semantics except for improved error shape/message.

### Rejected
- Do not add broad cleanup, unrelated refactors, or dependency changes; the P0.6 slice is error taxonomy, message plumbing, and tests only.
- Do not use ad hoc string matching as the primary error contract; stable classes/codes must be the compatibility surface.
- Do not expose raw provider/auth/rate-limit payloads directly in CLI, API, Web UI, or event logs.
- Do not rewrite fake/mock responders merely to force passing tests; adjust production mapping and add purpose-built tests for the intended real workflow.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan by adding stable error classes and human-readable, redacted messages across the CLI, API, Web UI, and event emission surfaces for the listed failure codes, with focused tests for common failures and provider-detail redaction.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm P0.6 wording and any local file hints before editing.
- Error taxonomy/core error module, likely under `src/`, `lib/`, `packages/`, or equivalent existing shared domain layer — add the canonical classes/codes/message definitions using the project’s current module patterns.
- CLI command/error presentation files — map thrown canonical errors to human-readable CLI output and stable exit/error metadata without changing command behavior.
- API error serialization/route middleware files — serialize canonical errors with stable `code`, safe `message`, stable class/type, and redacted safe details.
- Web UI error display files — render canonical error messages/codes from API responses without relying on brittle raw error text.
- Event/log emission files — emit canonical error codes/messages and safe detail only; ensure corrupt log, reconciliation, lease, lock, version, and verdict events use stable codes.
- Existing test suites near these surfaces — add/adjust focused tests for common failures and redacted provider detail without broad fixture churn.

**实现步骤**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify the existing shared error, CLI, API, Web UI, and event/logging files already used by the project.
2. Add or extend a canonical error module using the existing project style. Define one stable class/type family and the exact codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
3. For each code, define a concise human-readable default message. Keep messages actionable but generic enough not to leak implementation detail; include safe remediation where useful, such as reauthenticate, retry later, clean worktree, refresh project version, or inspect the event log.
4. Add a redaction helper at the canonical error boundary if one does not already exist. Redact provider tokens, API keys, auth headers, secret-looking values, raw provider request/response bodies, and sensitive filesystem or source-path mismatch details before serialization or event emission.
5. Map existing adapter/provider failures to canonical errors: missing adapter to `adapter_missing`, auth failures to `adapter_auth_failed`, provider throttling to `provider_rate_limited`, and permission failures to `permission_denied`.
6. Map existing safety and workflow guards to canonical errors: secret protection to `secret_blocked`, deletion protection to `delete_blocked`, dirty worktree guard to `worktree_dirty`, source path mismatch guard to `source_path_mismatch`, stale lease to `lease_stale`, corrupt event log to `event_log_corrupt`, reconciled job state to `job_reconciled`, busy project lock to `project_lock_busy`, version conflict to `version_mismatch`, and failed verdict to `verdict_failed`.
7. Update CLI presentation to consume canonical errors and print the human-readable message plus stable code. Preserve existing exit codes unless P0.6 explicitly requires a different mapping in the source plan.
8. Update API serialization/middleware to return a stable JSON shape for canonical errors. Preserve existing HTTP status behavior where already established; only add missing status mappings if the current behavior has no stable mapping.
9. Update Web UI error handling to display canonical human-readable messages and keep stable codes available for support/debug UI. Avoid large UI redesigns.
10. Update event/log emission paths so emitted failures include the stable code and redacted message/detail. Do not alter event ordering, append semantics, reconciliation logic, or lock/lease behavior.
11. Add focused tests for representative common failures across surfaces: adapter missing, adapter auth failed with redacted provider detail, provider rate limited, permission denied, secret blocked, worktree dirty, project lock busy, version mismatch, and verdict failed.
12. Add coverage proving all fourteen required codes exist, have non-empty human-readable messages, serialize consistently, and redact provider detail before CLI/API/Web UI/events can expose it.
13. Run the smallest relevant test set first, then the project’s normal lint/typecheck/test commands required by the source plan or package scripts. Fix production code failures; do not broaden scope into unrelated cleanup.
14. Produce `deliverable-065.md` with changed files, test commands/output, behavior-preservation notes, redaction evidence, remaining risks, and any source-plan details that could not be fully verified.

**注意事项**:
- Keep all implementation changes scoped to P0.6. Do not implement other P0 items from the promotion readiness plan.
- Preserve existing behavior and public flow semantics; this slice standardizes error classes/messages and redaction, not feature behavior.
- Prefer existing project utilities and error/reporting patterns over new abstractions.
- Do not add dependencies unless the promotion readiness plan explicitly requires them.
- Do not alter snapshots, fixtures, fake providers, or mock responders just to make production changes pass. If a fake no longer matches intended behavior, document the mismatch and add a purpose-built verification path.
- Keep provider detail redaction centralized enough that CLI, API, Web UI, and events cannot accidentally diverge.
- Avoid raw provider messages in human-readable output when those messages can contain secrets or account-specific details.
- If existing errors already have codes/messages, maintain backward compatibility by aliasing or wrapping rather than replacing call sites wholesale.

## Next-Action
Implement the scoped P0.6 error taxonomy/message/redaction work according to the steps above, run focused and normal verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-065.md` with evidence.

## Acceptance-Criteria
- [ ] The implementation is grounded in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and implements only P0.6.
- [ ] Stable canonical error classes/types exist for all required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Every required code has a non-empty human-readable message suitable for CLI/API/Web UI/events.
- [ ] CLI output uses canonical codes/messages for common failures and preserves existing command behavior and exit semantics.
- [ ] API responses serialize canonical errors with stable code/message/class or type fields and redacted safe detail.
- [ ] Web UI error rendering consumes canonical API errors and displays the human-readable message without exposing raw provider detail.
- [ ] Event/log emission includes stable codes/messages for these errors and excludes unredacted provider detail.
- [ ] Tests cover representative common failures, including adapter missing, adapter auth failed, provider rate limited, permission denied, secret blocked, worktree dirty, project lock busy, version mismatch, and verdict failed.
- [ ] Tests prove provider/auth/rate-limit details are redacted before appearing in CLI/API/Web UI/event outputs.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup, broad refactor, dependency addition, or fixture-only test passing change is included.
- [ ] Project-required lint/typecheck/test commands pass, or any non-P0.6 pre-existing failures are documented with evidence in `deliverable-065.md`.
