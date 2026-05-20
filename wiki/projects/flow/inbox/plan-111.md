## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-P0.6-promotion-readiness-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Task Heading

Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup.

Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided

- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling source of truth; before editing, re-open it and confirm the exact P0.6 wording.
- Implement one central stable error contract instead of scattered string literals: each listed failure gets a stable code, a human-readable message, a typed/classified error representation, and safe details suitable for API, CLI, Web UI, and event payloads.
- Preserve existing behavior outside error normalization: keep existing success paths, existing operational flow, and current status/exit semantics unless the P0.6 source plan explicitly requires otherwise.
- Redact provider/internal details at the boundary where errors become user-facing or event-facing. Keep raw provider detail only in internal diagnostic paths that are already protected by existing logging rules.
- Tests must cover common user-visible failure paths plus one or more explicit redaction assertions proving sensitive provider detail is not exposed.

### Rejected

- Broad cleanup of existing error handling | P0.6 is a promotion-readiness must-have slice, not a general refactor.
- Adding a new dependency for error typing or redaction | stable classes/messages can be implemented with existing language/runtime facilities and existing project helpers.
- Updating fake providers, snapshots, or mocks merely to force tests green | production behavior should drive test expectations; only adjust fakes when they model the real P0.6 behavior being tested.
- Returning provider-native messages directly to CLI/API/Web UI/events | this conflicts with stable messages and redacted-provider-detail requirements.

### Files

- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` -- read-only source of truth for P0.6.
- Error contract module already used by the project, or the narrowest existing core/shared module that all CLI/API/Web UI/events can import -- add the stable error classes/registry here.
- Existing adapter/provider failure mapping code -- map adapter_missing, adapter_auth_failed, and provider_rate_limited to the stable contract.
- Existing permission/secret/delete/worktree/source-path/version/verdict/lease/project-lock/event-log/job reconciliation call sites -- replace ad hoc user-facing errors with the stable contract only at the boundary needed for P0.6.
- Existing CLI error rendering code -- render stable code plus human-readable message while preserving exit behavior.
- Existing API error response code -- serialize stable code/message/redacted details while preserving current HTTP status behavior where possible.
- Existing Web UI error display code -- consume stable code/message and stop surfacing raw provider/internal detail.
- Existing event emission/log serialization code -- include stable error code/message and redact sensitive provider detail in emitted event payloads.
- Existing test suites nearest those surfaces -- add/adjust focused tests for the P0.6 codes and provider detail redaction.

### Scope

**Goal**: Implement P0.6 only: stable error classes and human-readable messages for these exact codes across CLI/API/Web UI/events:

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

**Implementation Steps**:

1. Re-open the promotion readiness source plan and record the exact P0.6 requirements in your working notes. If it names existing target files or conventions, follow those over any generic guidance here.
2. Locate the current error handling boundaries for CLI rendering, API response serialization, Web UI display, event emission, adapter/provider failures, and operational guards for permission, secret, delete, worktree, source-path, lease, event-log, reconciliation, project-lock, version, and verdict failures.
3. Add the narrowest shared stable error contract. It should define the listed codes, typed/classes or classifiable instances, default human-readable messages, safe details, and a serializer/helper for user-facing surfaces. Keep the contract small and avoid unrelated taxonomy work.
4. Map existing failure sites to the stable contract. Keep current control flow and status behavior intact, but ensure user-facing/API/event outputs use the stable code and human-readable message instead of raw provider/internal text.
5. Implement redaction at serialization/presentation boundaries. Provider detail such as tokens, Authorization headers, API keys, secret values, raw provider responses containing secrets, file-system internals beyond existing public context, and stack traces must not reach CLI/API/Web UI/events.
6. Update CLI/API/Web UI/events to consume the stable error contract consistently. Avoid duplicating message text in each surface; prefer importing or calling the shared formatter/serializer.
7. Add or adjust focused tests near the existing suites. Cover representative common failures across surfaces and include explicit assertions for redacted provider detail. Add table-driven coverage for all fourteen codes if the project test style supports it.
8. Run the relevant test, lint, and typecheck commands available for this repository. If a full suite is too expensive, run the nearest targeted tests plus the standard static checks and document any gap in the deliverable.

**Notes**:

- Keep changes scoped to P0.6; do not rename broad modules, rework unrelated error architecture, or polish unrelated UI copy.
- Preserve existing behavior for successful operations and unrelated errors.
- Do not introduce new dependencies.
- Prefer existing project utilities for serialization, redaction, event payload shape, API error responses, and CLI output.
- If there is already a canonical error class, extend it rather than creating a competing parallel system.
- If there are existing snapshots, update only snapshots directly tied to the intended stable error message/code change.
- The deliverable must list actual changed files and fresh verification evidence.

## Next-Action

Implement the P0.6 stable error classes/messages slice exactly as described above, run focused verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-111.md` using the execute-to-review handoff format.

## Acceptance-Criteria

- [ ] The implementation confirms `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was used as the source of truth for P0.6.
- [ ] A stable shared error contract exists for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each listed code has a deterministic typed/classified representation and a human-readable message suitable for user-facing surfaces.
- [ ] CLI output uses the stable code/message for common failures and preserves existing exit behavior unless the source plan requires a specific change.
- [ ] API error responses serialize stable code/message and redacted safe details while preserving existing HTTP status behavior where possible.
- [ ] Web UI error display consumes stable code/message and does not expose raw provider/internal detail.
- [ ] Event payloads for these failures include stable code/message and do not expose sensitive provider detail.
- [ ] Provider/auth/rate-limit failures are redacted so secrets, tokens, Authorization headers, API keys, and raw sensitive provider bodies are not visible in CLI/API/Web UI/event outputs.
- [ ] Tests cover common failure paths and include explicit redaction assertions for provider detail.
- [ ] Tests or table-driven coverage verify all fourteen P0.6 codes are registered and have human-readable messages.
- [ ] No new dependencies are added.
- [ ] No unrelated cleanup, unrelated behavior changes, broad rewrites, or test-double-only fixes are included.
- [ ] Relevant targeted tests pass; lint/typecheck or the repository-standard static checks pass, or any unable-to-run verification is clearly documented in the deliverable.
