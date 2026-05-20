## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-094
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan Title — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation authority; implement only P0.6 and stop at the listed error identifiers.
- Introduce or extend one central error taxonomy that exposes stable machine codes and human-readable messages, then have CLI/API/Web UI/event code consume that shared mapping instead of duplicating ad hoc strings.
- Preserve existing behavior and transport semantics unless the P0.6 requirement specifically requires normalizing error class/code/message output.
- Provider-originated details must be redacted before they reach CLI/API/Web UI/event logs; tests must prove secrets/tokens/raw provider payloads are not surfaced.
- Add focused tests around common failure paths and serialization/formatting boundaries rather than broad unrelated cleanup.

### Rejected
- Broad refactors of command routing, API handlers, Web UI state management, event storage, or adapter internals; they are outside the P0.6 slice.
- Renaming existing public error codes not listed in P0.6; doing so risks compatibility regressions unrelated to promotion readiness.
- Embedding user-facing message strings separately in each surface; duplicated strings would make future error stability weaker.
- Relaxing assertions to snapshot whole responses; targeted assertions on stable codes, class names, messages, and redaction are more durable.

### Scope

**目标**: Implement P0.6 from the promotion readiness must-haves plan by adding stable error classes and human-readable messages for these exact identifiers across CLI/API/Web UI/events: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`. Add focused tests for common failure paths and redacted provider detail while preserving current behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Read first to confirm the exact P0.6 wording and any local notes before editing.
- Error taxonomy module, likely under the existing shared/core/server error utilities — Add stable error classes, codes, default messages, safe detail serialization, and provider-detail redaction.
- CLI error formatting/command boundary files — Convert thrown/returned P0.6 failures into stable code + human-readable message output without exposing raw provider detail.
- API handler/error response boundary files — Ensure JSON responses include stable error code/class/message and redact unsafe detail.
- Web UI error display/state files — Render the shared human-readable messages for P0.6 failures without changing unrelated UI behavior.
- Event emission/logging/reconciliation files — Ensure emitted events carry stable error codes/messages and corrupt/reconciled/busy/version/verdict failures are represented consistently.
- Existing test files near each touched boundary — Add or adjust focused tests for common failures and provider-detail redaction.

**实现步骤**:
1. Read the promotion readiness plan and locate the existing error infrastructure by searching for current error classes, error codes, CLI/API error formatters, Web UI error rendering, and event failure payloads.
2. Identify the narrowest shared place for the P0.6 taxonomy. If an error module already exists, extend it; otherwise add a small shared module in the closest existing shared/server boundary that current CLI/API/event code can import without creating a new dependency.
3. Define stable error classes or descriptors for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, provide a concise human-readable default message. Messages should explain the action failure and recovery hint when appropriate, but must not include provider secrets, tokens, raw authorization headers, raw prompts, paths beyond current existing safe behavior, or unredacted adapter/provider payloads.
5. Add a serializer/normalizer that turns unknown thrown values and known P0.6 errors into the existing response/event shape plus stable `code` and `message`. Preserve existing status codes, exit codes, and event names unless the current shape cannot represent the P0.6 requirement.
6. Wire CLI boundaries to use the normalizer for P0.6 failures. Verify common failures display the stable code and human-readable message, and provider-auth/rate-limit failures redact provider detail.
7. Wire API boundaries to use the same normalizer for P0.6 failures. Keep response compatibility where possible; add fields rather than removing existing fields unless tests prove old fields were internal-only.
8. Wire Web UI error rendering to prefer the stable message for these codes while preserving existing fallback behavior for unknown/unmapped errors.
9. Wire event emission/logging paths so P0.6 failures carry stable code/message in event payloads, including `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
10. Add focused tests for representative common failures: adapter missing, adapter auth failed with redacted provider detail, provider rate limited, permission denied or secret blocked, worktree dirty or source path mismatch, event log corrupt, project lock busy, version mismatch, and verdict failed. Use existing test style and fixtures; do not edit fake/mock responders solely to hide a production mismatch.
11. Run the project’s relevant test commands for the touched areas, then run the normal lint/typecheck/test path expected by the promotion readiness plan. If full verification is too expensive or unavailable, report the exact commands run and the precise remaining gap in the deliverable.

**注意事项**:
- Keep the diff scoped to P0.6. Do not implement adjacent P0 items from the promotion readiness plan.
- Do not introduce new dependencies.
- Prefer extending existing error utilities and test helpers over adding a parallel framework.
- Treat stable codes as public compatibility surface. Use the exact lowercase snake_case identifiers from the task.
- Redaction is part of the feature, not just a test concern. Centralize it so CLI/API/Web UI/events cannot accidentally bypass it.
- Preserve existing behavior for unlisted errors and unknown thrown values.
- If a surface already has localized copy or existing message conventions, adapt the shared message into that convention without changing the code identifier.

## Next-Action
Implement only P0.6 using the promotion readiness plan as the source of truth. After implementation, run relevant tests and write `deliverable-094.md` with changed files, verification evidence, risks, and any known verification gaps.

## Acceptance-Criteria
- [ ] The implementation confirms and follows P0.6 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] Stable error classes or equivalent shared descriptors exist for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI output for common P0.6 failures includes the stable code and a human-readable message.
- [ ] API error responses for common P0.6 failures include the stable code and a human-readable message while preserving existing compatible response fields.
- [ ] Web UI error display uses the stable human-readable message for P0.6 failures and preserves fallback behavior for unknown errors.
- [ ] Event payloads/logging for P0.6 failures include stable code/message fields without exposing unsafe provider detail.
- [ ] Provider detail is redacted in all tested surfaces for adapter auth failures and provider rate limits; test data must prove secrets/tokens/raw provider detail are absent.
- [ ] Focused tests cover representative common failures across the touched boundaries, including at least adapter missing, adapter auth failed, provider rate limited, permission denied or secret blocked, event log corrupt, project lock busy, version mismatch, and verdict failed.
- [ ] Existing behavior for unlisted errors is preserved.
- [ ] No unrelated cleanup, dependency additions, or broad refactors are included.
- [ ] All relevant tests pass, and any skipped/unavailable verification is explicitly documented in `deliverable-094.md`.
