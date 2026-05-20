## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-033-P0.6-stable-error-classes
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth and re-read its P0.6 section before making code edits.
- Implement only P0.6: stable error classes, stable machine-readable codes, human-readable messages, and propagation across CLI, API, Web UI, and event payloads.
- Preserve existing behavior by adapting current failure paths to the new error shape instead of broadening behavior, changing workflows, or refactoring unrelated modules.
- Use one shared error catalog or equivalent existing central error module so every surface emits the same codes and message text for: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Redact provider details consistently before they reach CLI output, API responses, Web UI text, logs/events, snapshots, or test assertions.

### Rejected
- Broad cleanup/refactor outside P0.6 | The directive explicitly limits scope to the P0 slice and requires preserving existing behavior.
- Ad hoc per-surface message strings | This risks CLI/API/Web UI/events drifting and makes stable error classes harder to test.
- Exposing raw provider errors for debugging | The task requires tests for redacted provider detail; raw provider details must not leak through user-facing or event surfaces.
- Updating fake/mock responders merely to make tests pass | Project guidance forbids changing fake/mock assets after production behavior changes unless the fake itself is the product bug.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: stable error classes and human-readable messages across CLI/API/Web UI/events for the listed failure codes, with focused tests for common failures and provider-detail redaction.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm exact P0.6 requirements before implementation.
- Error domain/catalog module currently responsible for application errors — add or extend stable classes/codes/messages there, reusing existing patterns.
- CLI error rendering module/command boundary — map stable errors to human-readable messages and stable exit/output behavior without changing successful flows.
- API error serialization/middleware/route boundary — return stable error codes and redacted human-readable messages while preserving current HTTP semantics unless P0.6 specifies otherwise.
- Web UI error display/state handling — display the shared human-readable messages for these codes without exposing raw provider details.
- Event/log emission code for job/project/provider failures — include stable error code/class/message fields and redact provider details.
- Existing unit/integration test files covering errors, CLI/API behavior, Web UI failure states, and event payloads — add focused cases for common failures and redacted provider detail.

**实现步骤**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and record any exact wording, status-code, event-field, or compatibility requirements before editing.
2. Locate the existing error type, error serialization, CLI renderer, API middleware, Web UI error display, and event emission paths. Prefer current project patterns and avoid introducing a new dependency.
3. Add or extend a central stable error catalog with one canonical entry per required code: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each catalog entry, define the stable code/class and a human-readable message that is specific enough for users but does not expose secrets, raw provider payloads, access tokens, file contents, headers, stack traces, or unredacted upstream error details.
5. Update existing failure constructors/call sites to throw or return the stable error class/code for the listed cases. Keep legacy behavior intact where callers already depend on status, exit code, retry behavior, reconciliation semantics, or event ordering.
6. Update CLI rendering so these errors print the canonical human-readable message and stable code in the project’s existing CLI style. Confirm provider-auth and provider-rate-limit paths redact provider detail.
7. Update API serialization so responses include stable error code/class and redacted message. Preserve existing HTTP status choices unless P0.6 explicitly requires a change.
8. Update Web UI error handling to consume the stable code/message shape and render the human-readable message for the listed cases. Avoid adding explanatory UI copy outside existing error surfaces.
9. Update event/log emission so events for these failures include stable code/class/message and any existing contextual identifiers, but not raw provider detail or secrets.
10. Add or adjust tests for common failures across surfaces, prioritizing representative cases: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
11. Add explicit redaction tests showing provider details are removed or sanitized in CLI output, API response bodies, Web UI-rendered text or state, and emitted events.
12. Run the smallest relevant test targets first, then the project’s standard lint/typecheck/test/static-analysis commands required by repository guidance. If a broad suite is too slow or unavailable, document the exact commands run and the remaining gap in the deliverable.
13. Write `deliverable-033.md` after implementation with changed files, simplifications made, verification evidence, remaining risks, and any known P0.6 items intentionally left untouched because they were outside scope.

**注意事项**:
- Do not broaden into unrelated cleanup, formatting churn, dependency changes, routing changes, persistence changes, UI redesign, or behavior changes outside P0.6.
- Do not mutate snapshots, fixtures, fake LLM responders, test doubles, or mock provider responses merely to align with a new implementation unless the test double itself is the issue.
- Keep compatibility with existing event consumers by adding stable error fields in the existing payload shape where possible instead of removing or renaming existing fields.
- If two existing modules already define overlapping error concepts, prefer the established boundary used by current CLI/API/event code instead of creating parallel abstractions.
- Treat redaction as part of the acceptance surface: provider names can remain if already public and useful, but raw upstream messages, tokens, request IDs that can expose account detail, headers, secrets, stack traces, and provider payload bodies must not be user-facing unless the source-of-truth plan explicitly allows them.

## Next-Action
Implement the scoped P0.6 changes above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Run focused and standard verification, then generate `deliverable-033.md` for Codex review.

## Acceptance-Criteria
- [ ] The P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read and followed; no unrelated promotion-readiness work was implemented.
- [ ] Stable error class/code/message coverage exists for every required code: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI output for representative failures uses stable human-readable messages and does not expose raw provider detail.
- [ ] API error responses include stable code/class/message fields for representative failures and preserve existing HTTP behavior unless the source plan requires otherwise.
- [ ] Web UI error display consumes and shows the stable human-readable messages without leaking provider detail.
- [ ] Event/log payloads for representative failures include stable error code/class/message while redacting provider detail and secrets.
- [ ] Tests cover common failures and include explicit redaction assertions for provider detail across at least CLI, API, and event surfaces; include Web UI coverage if a Web UI test harness already exists.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup, dependency additions, or fixture/mock churn is included.
- [ ] Lint, typecheck, tests, and relevant static analysis pass, or the deliverable records exact commands attempted and any environmental blockers.
- [ ] `deliverable-033.md` lists changed files, verification evidence, simplifications made, and remaining risks.
