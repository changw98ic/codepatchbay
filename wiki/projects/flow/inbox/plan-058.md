# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: P0.6-promotion-readiness-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` is the source of truth; implement only P0.6 from that plan.
- The stable machine-readable error code set for this slice is exactly: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Add or extend a single canonical error taxonomy/registry used by CLI, API, Web UI, and events so every listed code has a stable class/type and a human-readable message.
- Preserve existing behavior outside user-facing class/message normalization: do not change unrelated control flow, authorization policy, provider selection, event retention, reconciliation semantics, or delete/worktree behavior.
- Provider details shown to users or events must be redacted. Raw provider messages, tokens, paths containing secrets, credentials, headers, and account identifiers must not appear in CLI output, API responses, Web UI copy, persisted event payloads, or test snapshots.
- Tests must cover common failure surfaces and redacted provider detail rather than only the registry in isolation.

### Rejected
- Surface-specific ad hoc message strings are rejected because they will drift and break stable promotion-readiness behavior.
- Adding a new dependency for error formatting or redaction is rejected unless the source plan explicitly requires it; this slice should reuse existing utilities and patterns.
- Broad cleanup, rename-only refactors, unrelated test rewrites, and snapshot churn are rejected because the task explicitly limits scope to P0.6.
- Making raw provider failures user-visible is rejected because the task requires redacted provider detail.

### Files
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; source-of-truth requirement for P0.6.
- Existing error/domain modules under `/Users/chengwen/dev/flow` — locate the current central error type, error-code enum, result type, or equivalent before adding anything new.
- Existing CLI command/error boundary modules under `/Users/chengwen/dev/flow` — update the shared CLI formatter/boundary to emit canonical messages for listed errors.
- Existing API error serialization modules and route boundaries under `/Users/chengwen/dev/flow` — update JSON error responses to include stable code/class and safe message without leaking raw provider detail.
- Existing Web UI error display/hooks/components under `/Users/chengwen/dev/flow` — route listed error codes through the canonical user-facing messages.
- Existing event/job/reconciliation logging modules under `/Users/chengwen/dev/flow` — ensure emitted/persisted event errors use the stable code/class/message shape and redacted detail.
- Existing tests for CLI, API, Web UI, events, adapters/providers, delete guards, worktree/project locks, version checks, verdict handling, and event log corruption under `/Users/chengwen/dev/flow` — add focused coverage in the closest existing test files; create new colocated test files only when no suitable owner exists.

### Evidence
- Planning-only phase. No repository commands were run and no implementation files were modified by Codex.

### Risks
- The exact implementation file owners must be discovered by Claude because this planning phase was constrained to writing only this inbox handoff and not running shell inspection.
- Some listed failures may already exist with legacy names or messages; map them without changing behavior unless the source plan explicitly requires a behavior change.
- Web UI and event tests may require different runners; run the smallest relevant test sets first, then broader verification if available.
- Redaction must be tested against realistic provider failure detail because registry-only tests can pass while boundary serialization still leaks sensitive text.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan only: stable error classes and human-readable messages across CLI, API, Web UI, and events for the exact listed codes, with tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source-of-truth check before implementation.
- Current canonical error/taxonomy file(s) — add the listed stable error classes/codes/messages in the existing pattern.
- Current CLI error boundary/formatter file(s) — use canonical error shape for terminal output and exit behavior.
- Current API serialization/error middleware file(s) — use canonical error shape for responses.
- Current Web UI error rendering/mapping file(s) — use canonical human-readable messages.
- Current event emission/persistence file(s) — use canonical error code/class/message and redacted detail.
- Current focused test file(s) nearest those owners — add or adjust tests for the common failures and redaction requirement.

**实现步骤**:
1. Read the source-of-truth promotion readiness plan and confirm P0.6 wording. Do not implement any other P0/P1/P2 item.
2. Locate existing error infrastructure by searching for current error codes, provider/adapters errors, API error serialization, CLI exception handling, Web UI error rendering, and event logging. Reuse the existing owner modules rather than introducing parallel taxonomy.
3. Define the canonical P0.6 error registry/classes in the existing error infrastructure. For each listed code, include:
   - stable `code` equal to the required snake_case value;
   - stable class/type name matching existing conventions;
   - human-readable message suitable for CLI/API/Web UI/events;
   - safe optional detail field that is redacted by default at user/event boundaries.
4. Wire CLI error handling through the canonical shape. Preserve current exit codes and command behavior unless the existing behavior has no representation for the P0.6 error. Add coverage for representative CLI failures such as `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, and `worktree_dirty`.
5. Wire API error serialization through the canonical shape. Responses for listed failures must include stable code/class and human-readable message while excluding raw provider detail. Add coverage for representative API failures such as `secret_blocked`, `delete_blocked`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
6. Wire Web UI error mapping/rendering through the canonical messages. The UI should display the human-readable message for listed codes and keep existing fallback behavior for unknown errors. Add focused component/hook tests if the project already has Web UI test coverage.
7. Wire event emission/persistence/reconciliation through the canonical shape for listed event-facing failures, especially `lease_stale`, `event_log_corrupt`, `job_reconciled`, `source_path_mismatch`, and provider failures. Persist redacted detail only.
8. Add a redaction-focused test using a provider failure detail string that contains a fake token, credential-like header, account/user identifier, and verbose upstream message. Verify CLI/API/Web UI/events expose only safe redacted detail and the canonical code/message.
9. Run the smallest relevant tests for changed areas first, then the broader lint/typecheck/test suite normally required by this repository. Do not edit fake/mock responders, snapshots, fixtures, or test doubles merely to force tests to pass; update them only when the test double itself is the intended coverage target.
10. Produce `deliverable-058.md` with changed files, verification commands and outputs, and any remaining risks.

**注意事项**:
- Keep the diff narrow and reversible; do not reformat unrelated files.
- Do not introduce new dependencies.
- Do not broaden into cleanup, naming migrations outside the stable error mapping, or unrelated promotion-readiness items.
- Preserve existing behavior for unknown/unlisted errors.
- Centralize user-facing messages so CLI/API/Web UI/events cannot drift.
- Redaction is part of the acceptance criteria, not a nice-to-have.

## Next-Action
Implement P0.6 exactly as scoped above, run relevant tests, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-058.md` using the project handoff protocol with changed files, evidence, risks, and next validation action for Codex.

## Acceptance-Criteria
- [ ] The source plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read and only P0.6 was implemented.
- [ ] Every required code has a stable canonical error class/type and human-readable message: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI output for representative listed failures uses the canonical code/message and preserves existing exit/control behavior.
- [ ] API responses for representative listed failures include the stable code/class and safe human-readable message without leaking raw provider detail.
- [ ] Web UI error rendering uses the canonical human-readable messages for listed codes and preserves the existing unknown-error fallback.
- [ ] Event emission/persistence uses the stable code/class/message shape for listed failures and stores only redacted provider detail.
- [ ] Tests cover common failures across CLI/API/Web UI/events where existing test infrastructure supports those surfaces.
- [ ] At least one redaction test proves fake provider secrets/details are not exposed in user-visible output or persisted event payloads.
- [ ] No unrelated cleanup, broad refactor, dependency addition, or non-P0.6 promotion-readiness work is included.
- [ ] Lint, typecheck, and relevant tests pass, or any unavailable command is documented with a concrete reason in `deliverable-058.md`.
- [ ] Code style remains consistent with existing project patterns.
