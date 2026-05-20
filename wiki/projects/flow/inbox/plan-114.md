## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-114
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling requirements document, and implement only its P0.6 slice.
- Introduce or consolidate one canonical stable error taxonomy for the named error codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Each error must have a stable machine-facing class/code and a human-readable message that can be reused by CLI, API, Web UI, and emitted events instead of duplicating divergent strings.
- Provider/internal details must be redacted before reaching CLI output, API responses, Web UI text, or event payloads.
- Preserve current behavior and status semantics except for making error classification/messages stable and redacted.

### Rejected
- Broad cleanup outside P0.6 | The task explicitly says to keep changes scoped and not broaden into unrelated cleanup.
- Per-surface ad hoc message strings | This would not satisfy stable cross-surface classes/messages and would regress consistency.
- Leaking provider error details into tests as expected output | The P0.6 requirement explicitly calls for tests around redacted provider detail.
- Snapshot or fake responder churn solely to make tests pass | Project guidance forbids changing fake/mock assets unless the fake/test double itself is the bug.

### Scope

**目标**: Implement P0.6 from the promotion readiness must-haves plan by adding a stable, redacted error classification and human-readable message path that is consistently used by CLI, API, Web UI, and event emission for the required error codes.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; use P0.6 as source of truth and do not edit.
- Error taxonomy/module currently responsible for application/domain errors — add or extend stable classes/codes and message definitions for all P0.6 codes.
- CLI error rendering path — map thrown/returned domain errors to canonical codes/messages and redact provider details.
- API error serialization path — return canonical code/message fields without leaking provider detail; preserve existing HTTP status behavior unless P0.6 says otherwise.
- Web UI error display path — render canonical human-readable messages for these failures without exposing internal/provider detail.
- Event emission/logging path — include stable error class/code/message for emitted events and redact sensitive/provider detail.
- Existing tests for CLI/API/Web UI/events error handling — add or adjust focused coverage for common failures and provider-detail redaction.

**实现步骤**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and note any exact names, wording, status expectations, or acceptance criteria it adds beyond this handoff. Do not implement any non-P0.6 item from that document.
2. Locate the current error definitions and rendering/serialization boundaries by searching for existing occurrences of the required codes, related error classes, CLI error output, API error response shaping, Web UI error text, and event error payloads. Record the exact files touched in the deliverable.
3. Add or extend a single canonical error registry/taxonomy with all required codes:
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
4. For each canonical error entry, define the stable machine identifier and one concise human-readable message. Keep message wording action-oriented and user-safe, but avoid embedding provider raw responses, secrets, paths containing sensitive tokens, stack traces, or request/credential details.
5. Implement a normalization helper that converts existing thrown exceptions, adapter/provider failures, permission/secret/delete blockers, lease/event/job/project lock/version/verdict failures, and unknown wrapped provider errors into the canonical P0.6 error shape. Preserve original details only in internal debug/log fields that are already protected; do not surface them to user-facing outputs or events.
6. Wire CLI rendering to use the canonical error shape for these cases. Ensure CLI output includes the stable code/class and human-readable message, and that raw provider detail is absent.
7. Wire API serialization to use the same canonical error shape. Preserve current HTTP status codes unless the source plan explicitly requires a change; ensure JSON/body fields expose stable code/class and message while omitting/redacting raw provider detail.
8. Wire Web UI error presentation to display the canonical human-readable message for these failures. If the UI already consumes API error fields, prefer using the canonical API shape instead of creating duplicate UI-only mappings.
9. Wire event emission for failed/reconciled/error outcomes so event payloads contain the stable error code/class/message where applicable. Ensure emitted events do not contain raw provider response text, secrets, credentials, stack traces, or unredacted sensitive detail.
10. Add or adjust focused tests for representative common failures across the touched surfaces:
    - adapter missing
    - adapter authentication failed
    - provider rate limited
    - permission denied
    - secret blocked
    - delete blocked
    - worktree dirty
    - source path mismatch
    - project lock busy
    - version mismatch
    - verdict failed
11. Add one or more redaction-focused tests that inject realistic raw provider detail containing a token-like value, credential-like value, request id, or raw provider message, then assert CLI/API/Web UI/event user-facing outputs contain the canonical code/message and do not contain the raw sensitive/provider detail.
12. Add coverage for event-specific or lifecycle-specific codes that may not appear in the common surface tests: `lease_stale`, `event_log_corrupt`, and `job_reconciled`.
13. Run the smallest relevant test subset first, then the project’s standard lint/typecheck/test commands required by the source plan or existing package scripts. Do not update snapshots, fake responders, fixtures, or test doubles merely to hide behavior changes.
14. Review the final diff for scope: changes should be limited to P0.6 error taxonomy, surface wiring, and tests. Remove unrelated cleanup before handoff.

**注意事项**:
- Keep implementation scoped to P0.6 only.
- Do not rename existing public fields or alter existing success behavior unless the P0.6 source plan explicitly requires it.
- Do not add dependencies.
- Prefer existing project error/serialization/rendering patterns over new abstractions.
- Redaction must happen before data reaches CLI output, API responses, Web UI display text, or event payloads.
- If current code already has equivalent classes/messages, consolidate by extending the existing mechanism rather than introducing a parallel system.
- If a required code is not currently reachable in production paths, still add the stable taxonomy entry and test the normalization/serialization path where that code is intended to be emitted.
- Preserve internal diagnostics only where existing protected debug logs already support them; never place raw provider detail in user-facing outputs or event payloads.

## Next-Action
Implement the P0.6 slice exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Run focused and standard verification. When complete, write `deliverable-114.md` with changed files, test evidence, redaction evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation covers exactly these stable error codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Each required error has a stable machine-facing class/code and a human-readable message defined through the project’s canonical error mechanism.
- [ ] CLI rendering exposes the canonical code/class and human-readable message for covered failures.
- [ ] API error responses expose the canonical code/class and human-readable message for covered failures while preserving existing HTTP status behavior unless the source plan explicitly requires a different status.
- [ ] Web UI error display uses the canonical human-readable message for covered failures and does not duplicate divergent message mappings.
- [ ] Event payloads for covered failures include stable error code/class/message and omit raw provider/internal details.
- [ ] Common failure tests cover adapter missing, adapter auth failed, provider rate limited, permission denied, secret blocked, delete blocked, worktree dirty, source path mismatch, project lock busy, version mismatch, and verdict failed.
- [ ] Lifecycle/event tests cover `lease_stale`, `event_log_corrupt`, and `job_reconciled`.
- [ ] Redaction tests prove raw provider detail, token-like values, credential-like values, stack traces, and sensitive internal detail are absent from CLI/API/Web UI/event user-facing outputs.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup or broad refactor is included.
- [ ] Relevant lint, typecheck, and test commands pass, with command output summarized in `deliverable-114.md`.
- [ ] Code style matches the existing project patterns.
