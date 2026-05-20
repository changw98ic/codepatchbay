## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-100
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative scope document; implement only P0.6 and do not pull in adjacent P0/P1 work.
- Introduce or consolidate a stable application error taxonomy for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each error must expose a stable machine-readable class/code and a human-readable message suitable for CLI output, API responses, Web UI display, and event payloads.
- Provider-specific diagnostic detail may be preserved only when redacted; secrets, tokens, credentials, auth headers, and raw provider payloads that may contain sensitive data must not be surfaced in user-facing messages or event/API detail.
- Preserve existing behavior apart from the error class/message normalization and tests needed to prove it.

### Rejected
- Broad cleanup of existing error handling beyond P0.6 | The task explicitly requires a scoped P0 slice and preserving existing behavior.
- Adding a new dependency for error formatting or redaction | Scope and working agreements require no new dependencies unless explicitly requested.
- Encoding messages independently in CLI, API, Web UI, and events | That risks drift; prefer a shared taxonomy/formatter with surface-specific adapters.
- Snapshot-only validation | Stable codes and redaction need direct assertions so regressions are obvious.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan by adding stable error classes/codes and clear user-facing messages across CLI/API/Web UI/events, with targeted tests for common failure paths and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first to confirm exact P0.6 expectations and any naming/acceptance details.
- Error taxonomy module(s) discovered in source, likely under `src/`, `packages/`, or existing CLI/API shared utilities — define or extend stable error classes/codes/messages in one shared place.
- CLI error rendering entry point(s) — map taxonomy errors to human-readable stderr/stdout messages while preserving existing exit behavior.
- API error serialization/middleware/handlers — include stable code/class and redacted human-readable message in responses without leaking provider detail.
- Web UI error display utilities/components — render the same human-readable messages from API/event error payloads without inventing alternate wording.
- Event logging/emission code — include stable error code/class and redacted message/detail in event payloads for the listed failure types.
- Existing provider adapter/auth/rate-limit/permission/secret/delete/worktree/lease/event-log/job/project-lock/version/verdict failure tests — extend where they already cover these flows.
- New focused tests only where no existing coverage exists — assert common failures, stable code/message shape, and redaction of provider detail.

**实现步骤**:
1. Read the promotion readiness plan and identify the P0.6 subsection, acceptance notes, and any existing terminology that must be preserved.
2. Locate current error definitions, thrown errors, API serializers, CLI renderers, Web UI error consumers, and event emitters for the fourteen required codes.
3. Create or extend a shared error taxonomy with one canonical entry per required code, including stable class/code, default human-readable message, safe metadata fields, and redaction behavior for provider detail.
4. Replace only the relevant throw/return/serialization call sites so the common failure paths use the shared taxonomy while retaining existing control flow, exit codes, HTTP statuses, event names, and UI state transitions unless P0.6 explicitly requires otherwise.
5. Wire CLI, API, Web UI, and event surfaces to consume the canonical error shape rather than duplicating message strings.
6. Add or adjust focused tests for representative common failures: missing adapter, adapter auth failure with provider detail, provider rate limit, permission denied, blocked secret, blocked delete, dirty worktree, source path mismatch, stale lease, corrupt event log, reconciled job, busy project lock, version mismatch, and failed verdict.
7. Add explicit redaction assertions showing provider detail is useful but safe: provider names/status/request ids may remain when already non-secret, while tokens, API keys, bearer headers, cookies, passwords, and raw secret-like values are removed or replaced.
8. Run the project’s relevant unit/integration test commands for the touched packages, then the standard lint/typecheck/test suite expected by the repo if feasible.
9. Produce `deliverable-100.md` with changed files, evidence, and any narrow residual risks.

**注意事项**:
- Do not implement any task outside P0.6 from the promotion readiness plan.
- Do not rename public error codes after tests are written; the listed code strings are part of the acceptance surface.
- Keep messages concise and human-readable; avoid stack traces, internal module paths, and raw provider responses in user-facing surfaces.
- Do not weaken existing security behavior for `secret_blocked`, `delete_blocked`, or permission failures.
- Preserve event schema compatibility where possible by adding normalized error fields rather than removing existing fields unless the source plan explicitly directs removal.
- If existing tests use fakes or snapshots, do not edit fake provider payloads just to pass; adjust production redaction/serialization and add direct assertions instead.
- If a listed failure type is not currently reachable in one surface, add the narrowest adapter/mapper coverage and document the gap in the deliverable rather than inventing unrelated behavior.

## Next-Action
Implement the P0.6 slice exactly as scoped above, starting by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`. Keep changes limited to stable error classes/messages, surface mappings, and targeted tests. Run the relevant verification commands, then write `deliverable-100.md` using the established execute-to-review handoff format.

## Acceptance-Criteria
- [ ] The promotion readiness plan’s P0.6 section has been read and the implementation matches it without adding unrelated cleanup or adjacent P0/P1 work.
- [ ] All required stable codes exist exactly as listed: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable error class or canonical taxonomy entry and a clear human-readable default message.
- [ ] CLI output for representative failures includes the stable code or class and the safe human-readable message while preserving existing exit behavior.
- [ ] API error responses for representative failures include the stable code/class and safe message, with no leaked secrets or raw provider credentials.
- [ ] Web UI error handling can display the safe canonical message for normalized errors without duplicating divergent message text.
- [ ] Event payloads for representative failures include normalized error code/class/message fields and do not expose unredacted provider secrets.
- [ ] Tests cover common failures for the listed error codes at the appropriate unit/integration level.
- [ ] Tests explicitly prove provider detail is redacted for auth/rate-limit style errors while preserving safe diagnostic context where available.
- [ ] Existing behavior outside P0.6 is preserved; any intentionally changed observable behavior is limited to normalized error class/message surfaces and is documented in `deliverable-100.md`.
- [ ] Relevant lint, typecheck, and test commands pass, or any inability to run them is documented with the exact blocker in `deliverable-100.md`.
