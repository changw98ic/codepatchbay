# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-085-P0.6-stable-error-classes
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth, but implement only P0.6.
- Add or extend one central error catalog/class layer so every listed error has a stable machine-readable `code`, exported class, and default human-readable `message`.
- Wire CLI, API, Web UI, and event serialization through the same public error representation instead of duplicating copy per surface.
- Preserve existing behavior: keep current HTTP statuses, CLI exit behavior, job state transitions, and event semantics unless the P0.6 plan explicitly requires a field/message addition.
- Redact provider details before they leave the trusted internal boundary. Raw provider causes may remain attached for internal debugging only if existing patterns already support that safely.
- Add focused tests around the shared catalog, common failure paths, cross-surface serialization, and redacted provider detail.

### Rejected
- Rejected broad error-system redesign: P0.6 requires stable classes/messages, not unrelated cleanup.
- Rejected per-surface hardcoded strings: that would drift and fail the "stable across CLI/API/Web UI/events" requirement.
- Rejected adding a new redaction dependency: use or extend existing local redaction/sanitization utilities.
- Rejected changing fake/mock responders, snapshots, fixtures, or test doubles merely to make tests pass after production changes.
- Rejected exposing raw provider response bodies, headers, tokens, stack traces, or request payloads in public API, CLI, UI, or events.

### Scope

**Goal**: Implement the P0.6 promotion-readiness slice by introducing stable error classes and human-readable messages for:

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

**Implementation-owned areas**:

- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source for this slice.
- Existing shared/core error module - extend if present; create the smallest central module in the existing shared/core package only if no stable error catalog already exists.
- Existing CLI error formatter and command failure paths - display stable code plus human-readable message without leaking provider detail.
- Existing API error middleware/serializers/routes - return stable code/message in the current response shape and preserve current status mapping.
- Existing Web UI error presentation state/components - show the stable human-readable message and keep current UX behavior.
- Existing event/job log serializers and reconciliation paths - emit stable code/message and redacted public detail.
- Tests adjacent to each changed module, plus any existing cross-surface error serialization tests.

**Canonical class/message targets**:

Use these class names and default public messages unless the existing codebase already has stricter naming/copy conventions. Keep the `code` values exact.

| Code | Class | Default public message |
| --- | --- | --- |
| `adapter_missing` | `AdapterMissingError` | `Required adapter is not configured or installed.` |
| `adapter_auth_failed` | `AdapterAuthFailedError` | `Adapter authentication failed. Check credentials and permissions.` |
| `provider_rate_limited` | `ProviderRateLimitedError` | `Provider rate limit reached. Try again later.` |
| `permission_denied` | `PermissionDeniedError` | `Permission denied for this operation.` |
| `secret_blocked` | `SecretBlockedError` | `Request blocked because it contains a secret.` |
| `delete_blocked` | `DeleteBlockedError` | `Delete blocked by safety checks.` |
| `worktree_dirty` | `WorktreeDirtyError` | `Worktree has uncommitted changes.` |
| `source_path_mismatch` | `SourcePathMismatchError` | `Source path does not match the registered project path.` |
| `lease_stale` | `LeaseStaleError` | `Lease is stale. Refresh or retry the operation.` |
| `event_log_corrupt` | `EventLogCorruptError` | `Event log is corrupt and could not be read safely.` |
| `job_reconciled` | `JobReconciledError` | `Job state was reconciled after an inconsistency.` |
| `project_lock_busy` | `ProjectLockBusyError` | `Project is busy because another operation holds the lock.` |
| `version_mismatch` | `VersionMismatchError` | `Version mismatch. Refresh and retry with the current version.` |
| `verdict_failed` | `VerdictFailedError` | `Verification verdict failed.` |

**Implementation steps**:

1. Read the P0.6 section of the promotion readiness plan, then inspect existing error classes, error-code constants, API serializers, CLI formatters, Web UI error presenters, event writers, and tests. Record the exact files changed in the deliverable.
2. Add the central catalog/classes in the existing shared error layer. Each class must expose the exact stable `code`, the default public `message`, and a public serialization helper compatible with existing API/CLI/event response shapes.
3. Connect current producers of the listed failure cases to the stable classes. Keep existing low-level causes where useful, but do not change successful paths or unrelated errors.
4. Connect CLI, API, Web UI, and event serialization to the shared public error representation. Avoid per-surface message rewrites; surface-specific formatting may add context only after redaction.
5. Implement or extend provider-detail redaction at the public serialization boundary. Redact authorization headers, bearer tokens, API keys, secret-like fields, provider raw response bodies, and stack traces from API responses, CLI output, Web UI state, and event payloads.
6. Add tests:
   - shared catalog test asserting all 14 codes/classes/messages are exported and serialize consistently;
   - API/CLI/event tests for common failures including `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `worktree_dirty`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`;
   - Web UI test that renders the public message for at least one API-originated stable error without raw detail;
   - redaction regression test using provider detail containing `Authorization`, `Bearer`, `x-api-key`, `api_key`, `token`, and a fake secret value, asserting none appear in public outputs.
7. Run the smallest relevant test commands first, then the repository's normal lint/typecheck/test verification commands. If any existing fake/mock test conflicts with the real workflow, report the mismatch instead of weakening production behavior.
8. Self-review the diff before handoff: confirm only P0.6 files changed, no unrelated cleanup was included, all listed codes are covered, provider detail is redacted, and existing behavior is preserved.

**Notes and guardrails**:

- Do not broaden into unrelated cleanup, naming refactors, UI redesign, new dependencies, or unrelated event-schema changes.
- Do not remove existing error fields that callers may rely on. Add stable fields/messages in a backwards-compatible way.
- If an existing code already maps to one of the required codes, preserve the existing external shape and migrate it to the shared class/catalog rather than creating a duplicate path.
- Keep class names and messages centralized so future surfaces cannot drift.
- Provider raw details belong in internal logs only when existing logging policy permits it; public outputs should carry redacted detail or omit detail entirely.
- If the promotion readiness plan contains a stricter P0.6 requirement than this handoff, follow that source and document the adjustment in the deliverable.

### Evidence
- Planning-only handoff created under the allowed inbox path.
- No terminal commands were run in this planning phase.

### Risks
- Exact implementation file paths are intentionally left for the executor to resolve from the repository because this planning phase disallows terminal inspection.
- Existing tests may assert legacy ad hoc messages; update them only when they represent the intended public contract, not to hide production regressions.
- Event payload compatibility may be sensitive for downstream consumers; add fields conservatively and preserve existing fields.

## Next-Action
Implement only P0.6 following the steps above. After implementation and verification, write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-085.md` with changed files, test evidence, any source-of-truth adjustments from the promotion readiness plan, and known residual risks.

## Acceptance-Criteria
- [ ] The promotion readiness plan file was read, and the deliverable confirms P0.6 was the only implemented slice.
- [ ] All 14 required error codes have stable exported classes, exact stable `code` values, and centralized human-readable default messages.
- [ ] CLI, API, Web UI, and events all use the shared public error representation for the relevant failures.
- [ ] Existing HTTP statuses, CLI exit behavior, job state transitions, and event meanings are preserved except for the intentional stable code/message additions.
- [ ] Public outputs redact provider detail: no authorization header, bearer token, API key, secret-like value, provider raw body, or provider stack trace appears in API responses, CLI output, Web UI state, or event payloads.
- [ ] Tests cover the shared catalog for all 14 codes and common failures across API/CLI/events, plus at least one Web UI rendering path.
- [ ] Redacted provider-detail regression tests fail before the redaction fix and pass after it.
- [ ] No new dependencies are introduced.
- [ ] No unrelated cleanup, refactor, snapshot churn, or fake/mock weakening is included.
- [ ] Repository lint/typecheck/test verification was run, with command output summarized in the deliverable.
