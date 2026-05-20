## Handoff: codex -> claude — P0.6 stable error classes and human-readable messages from promotion readiness plan

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-117 / P0.6 promotion readiness must-haves
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Use `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for this slice.
- Implement only P0.6: stable error classes and human-readable messages for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Keep the error taxonomy centralized: one stable code registry, one message mapping, and typed error constructors/classes that all surfaces can consume.
- Preserve existing behavior outside formatting and classification of the listed failure cases.
- Redact provider/internal detail by default in CLI/API/Web UI/events while retaining safe high-level messages and stable codes for diagnosis.

### Rejected
- Rejected broad cleanup of error handling outside the listed P0.6 codes because the task explicitly forbids unrelated cleanup.
- Rejected changing fake/mock responders or fixtures merely to make existing tests pass; only adjust tests when they assert the intended stable error contract.
- Rejected adding dependencies for error serialization or redaction because this should be implemented with existing project utilities and standard language features.

### Scope

**Goal**: Implement P0.6 from the promotion readiness plan by adding stable error classes/codes and human-readable, redacted messages across CLI, API, Web UI, and emitted events for the fourteen required failure codes.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and use only its P0.6 requirements for this implementation.

**Expected implementation touch points**:
- Existing shared error module or the nearest shared runtime/domain module — add the stable error registry/classes and serialization helpers here.
- Existing CLI error rendering path — map thrown/domain errors to stable code plus human-readable message.
- Existing API error response path — return stable code and redacted message without leaking provider detail.
- Existing Web UI error consumption/display path — show the human-readable message derived from the stable code.
- Existing event/log emission path — include stable code and redacted safe message for the listed failures.
- Existing tests near each touched surface — add focused coverage for common failures and provider-detail redaction.

**Implementation steps**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and note any exact wording or acceptance constraints before editing code.
2. Locate the current error construction, API error serialization, CLI error rendering, Web UI error display, and event emission code. Keep the file list narrow to the modules already responsible for those surfaces.
3. Add or extend a shared stable error contract with these exact codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, define a deterministic human-readable message that is safe for end users and operators. Messages must not include raw provider responses, tokens, secrets, filesystem secrets, stack traces, request headers, or adapter internals.
5. Implement stable error classes or typed constructors that carry at least `code`, safe `message`, and optional structured safe context. Keep raw/internal cause data out of serialized output unless an existing private logging path already protects it.
6. Wire CLI, API, Web UI, and event serialization through the shared contract. Existing failures that correspond to the listed cases should emit the stable code and message; unrelated errors should continue using existing behavior.
7. Add or adjust tests for common failures: missing adapter, adapter authentication failure with provider detail present, provider rate limit, permission denied, blocked secret operation, blocked delete, dirty worktree, stale lease, corrupt event log, project lock busy, version mismatch, and failed verdict.
8. Add explicit redaction tests proving provider details do not appear in CLI text, API JSON, Web UI-facing payloads, or event payloads for `adapter_auth_failed` and `provider_rate_limited`.
9. Run the smallest relevant test set first, then the repo’s standard lint/type/test verification required by the promotion readiness plan. If a wider command is too slow or unavailable, report the exact limitation in the deliverable.
10. Write `deliverable-117.md` after implementation with changed files, test evidence, any skipped verification, and remaining risks.

**Message guidance**:
- `adapter_missing`: "Required adapter is not configured."
- `adapter_auth_failed`: "Adapter authentication failed. Check the configured credentials."
- `provider_rate_limited`: "Provider rate limit reached. Try again later."
- `permission_denied`: "Permission denied for this operation."
- `secret_blocked`: "Operation blocked because it would expose a protected secret."
- `delete_blocked`: "Delete blocked because the target is protected."
- `worktree_dirty`: "Worktree has uncommitted changes that must be resolved first."
- `source_path_mismatch`: "Source path does not match the expected project path."
- `lease_stale`: "The active lease is stale. Refresh state and retry."
- `event_log_corrupt`: "Event log is corrupt and cannot be replayed safely."
- `job_reconciled`: "Job state was reconciled after detecting an inconsistency."
- `project_lock_busy`: "Project is locked by another operation. Try again later."
- `version_mismatch`: "Version mismatch detected. Refresh and retry."
- `verdict_failed`: "Verification verdict failed."

**Notes**:
- Preserve existing status codes, exit codes, retries, and recovery behavior unless the P0.6 source plan explicitly requires a change.
- Do not broaden into unrelated cleanup, renaming, dependency changes, formatting churn, or new framework abstractions.
- Do not expose provider raw messages such as credential strings, response bodies, headers, stack traces, API keys, bearer tokens, request IDs if treated as sensitive, or filesystem paths containing secrets.
- If current architecture already has an error type, extend it rather than introducing a parallel hierarchy.
- If Web UI receives API payloads directly, prefer fixing the shared API contract over duplicating message logic in UI code.
- If events are persisted, keep event schemas backward-compatible by adding stable fields rather than removing existing fields.

## Next-Action
Implement the scoped P0.6 changes above, using the promotion readiness plan as the source of truth. Add focused tests for the listed common failures and redacted provider detail. Run relevant verification, then generate `deliverable-117.md` with changed files, evidence, and risks.

## Acceptance-Criteria
- [ ] The implementation reads and follows only the P0.6 requirements from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] All fourteen required stable codes exist exactly as specified: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a deterministic human-readable message suitable for CLI, API, Web UI, and event payloads.
- [ ] CLI failure output for representative listed failures includes the stable code and safe message, and preserves existing exit behavior.
- [ ] API error responses for representative listed failures include the stable code and safe message, and preserve existing response behavior except for the new stable classification fields.
- [ ] Web UI-facing error data for representative listed failures displays or receives the stable safe message rather than raw provider/internal detail.
- [ ] Event payloads for representative listed failures include the stable code and redacted safe message without breaking existing event consumers.
- [ ] Tests prove provider/internal detail is redacted for at least `adapter_auth_failed` and `provider_rate_limited` across serialized surfaces that expose errors outside the process.
- [ ] Existing behavior for unrelated error cases remains unchanged.
- [ ] No unrelated cleanup, dependency additions, fixture rewrites, or broad refactors are included.
- [ ] Relevant tests pass, and the deliverable records exact commands, outcomes, skipped checks, and remaining risks.
