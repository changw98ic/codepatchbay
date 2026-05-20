# Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice: P0.6 stable errors across CLI/API/Web UI/events

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-012 / P0.6 promotion readiness stable errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- The source of truth is `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; implement only the P0.6 slice from that plan.
- Add one canonical stable-error surface in the existing error domain, then reuse it from CLI, API, Web UI, and event/log serialization instead of duplicating message strings per surface.
- Every P0.6 code must have a stable exported class, a stable machine-readable `code`, and a human-readable default `message`: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Preserve existing behavior unless P0.6 explicitly requires a stable error envelope: keep current control flow, HTTP statuses, exit codes, retry behavior, and reconciliation semantics where they already exist.
- Provider/vendor details must be redacted before reaching CLI output, API responses, Web UI state, event payloads, logs, snapshots, or test assertions. Raw provider errors may remain as internal causes only if the project already supports non-serialized causes.

### Rejected
- Broader promotion-readiness work outside P0.6, because the directive is to implement only this P0 slice.
- A string-only message map without stable classes, because P0.6 explicitly requires stable error classes.
- Separate per-surface message definitions, because they drift and do not guarantee a stable cross-surface contract.
- Passing raw provider errors through and relying on callers to redact them, because the acceptance criteria require redacted provider detail.
- Unrelated cleanup, renames, dependency additions, or test fixture churn that is not necessary for the P0.6 contract.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: stable error classes and human-readable messages across CLI, API, Web UI, and event serialization for the listed codes, plus tests for common failures and redacted provider detail.

**Source-of-truth file**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first; use only the P0.6 requirements to resolve any ambiguity.

**涉及文件**:
- Existing canonical error module, error catalog, or domain error base class — add or extend stable classes, code/message metadata, serialization helpers, and exports for the P0.6 codes.
- Existing CLI error formatting/presentation owner — translate canonical errors to user-facing stderr/JSON output without raw provider detail.
- Existing API error middleware/serializer/route boundary owner — return stable `error.code` and `error.message` while preserving current status behavior and redacting provider detail.
- Existing Web UI error type/client/store/component owner — render or expose the human-readable message and stable code without leaking raw provider detail.
- Existing event/log schema, event emitter, reconciliation, lease, lock, or job-status owner — include stable code/message in emitted failure/reconciliation events and handle corrupt event logs with `event_log_corrupt`.
- Existing tests adjacent to the touched owners — add focused unit/integration tests for common failures and provider-detail redaction.
- `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-012.md` — write the execution deliverable after implementation and verification.

**Required stable error catalog**:

| Code | Stable class name | Default human-readable message |
| --- | --- | --- |
| `adapter_missing` | `AdapterMissingError` | `Required adapter is not installed or configured.` |
| `adapter_auth_failed` | `AdapterAuthFailedError` | `Adapter authentication failed. Check credentials and permissions.` |
| `provider_rate_limited` | `ProviderRateLimitedError` | `Provider rate limit reached. Try again later.` |
| `permission_denied` | `PermissionDeniedError` | `You do not have permission to perform this action.` |
| `secret_blocked` | `SecretBlockedError` | `Secret-like content was blocked from this operation.` |
| `delete_blocked` | `DeleteBlockedError` | `Delete was blocked because required safety checks did not pass.` |
| `worktree_dirty` | `WorktreeDirtyError` | `Worktree has uncommitted changes. Commit, stash, or discard them before continuing.` |
| `source_path_mismatch` | `SourcePathMismatchError` | `Source path does not match the registered project source path.` |
| `lease_stale` | `LeaseStaleError` | `The job lease is stale and must be reacquired before continuing.` |
| `event_log_corrupt` | `EventLogCorruptError` | `The event log is corrupt or unreadable.` |
| `job_reconciled` | `JobReconciledError` | `Job state was reconciled after stale or inconsistent state was detected.` |
| `project_lock_busy` | `ProjectLockBusyError` | `Project is locked by another operation. Try again shortly.` |
| `version_mismatch` | `VersionMismatchError` | `Version mismatch detected. Refresh and retry with the current version.` |
| `verdict_failed` | `VerdictFailedError` | `Verification verdict failed. Review the verdict details before continuing.` |

If the source-of-truth plan or existing product copy already defines stricter wording, keep the class names and codes above but use the established wording from the source-of-truth plan or existing UX copy. Do not leave any message blank or machine-only.

**实现步骤**:
1. Read the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then inspect the current error, CLI, API, Web UI, event, and test owners before editing. Record the resolved file list in `deliverable-012.md`.
2. Add or extend the canonical error layer with the 14 stable classes above. Each class must expose a stable `code`, a human-readable `message`, and whatever existing metadata the project already uses, such as HTTP status, CLI exit code, severity, retryability, or event type. Reuse the existing base error pattern if one exists.
3. Add one serialization/redaction helper at the existing error boundary, or extend the existing helper if present. It must produce a safe shape with `code` and `message`, preserve non-sensitive existing metadata, and omit or sanitize provider/vendor detail before any external surface sees it.
4. Wire existing producers to throw or wrap with the new classes only at the appropriate boundaries for the P0.6 failures: missing adapter, adapter auth failure, provider rate limit, permission denial, secret blocking, guarded delete, dirty worktree, source path mismatch, stale lease, corrupt event log, reconciled job state, busy project lock, version mismatch, and failed verdict.
5. Wire all user-facing surfaces to consume the canonical serializer: CLI output, API responses, Web UI error state/presentation, and event/log payloads. Keep existing status codes, exit codes, and success/failure semantics unless the source-of-truth P0.6 plan says otherwise.
6. Add targeted tests near the touched owners. Cover at least one CLI path, one API path, one Web UI path if the project has Web UI tests, one event/log path, and the canonical catalog itself. Include common failures for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `worktree_dirty`, `event_log_corrupt`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
7. Add explicit provider-detail redaction tests. Use realistic sensitive strings such as bearer tokens, API keys, auth headers, provider request IDs with secret-looking fragments, and raw vendor error bodies. Assert those raw strings do not appear in CLI output, API JSON, Web UI state/rendered text, event payloads, logs, or snapshots touched by this change.
8. Review the diff for scope creep before verification. Remove unrelated cleanup, broad rewrites, dependency additions, fixture churn, or behavior changes not needed for P0.6.
9. Run the existing targeted tests for the changed owners, then the project-standard lint/typecheck/test commands expected by the promotion readiness plan. If any command is unavailable or too broad for the environment, document the exact limitation and the targeted evidence collected in `deliverable-012.md`.

**注意事项**:
- `job_reconciled` may represent a reconciled event rather than a hard failure in existing behavior. Preserve that behavior; the P0.6 requirement is stable code/message representation, not converting reconciliation into a fatal error.
- Redaction must happen before serialization to every external surface. Do not rely on UI/API/CLI callers to remember to redact.
- Tests should assert stable `code` values and the presence of human-readable `message` values. Avoid brittle stack-trace or raw provider-body assertions.
- Do not modify fake/mock responders, snapshots, or fixtures merely to make tests pass after production behavior changes. Update tests only when they assert the new P0.6 contract or when existing fake data must include a safe, redacted provider-detail scenario.
- Keep changes scoped to P0.6. Do not implement other P0/P1 items from the readiness plan.

## Next-Action
Implement the P0.6 stable-error slice exactly as scoped above, run the relevant verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-012.md` with the changed files, test evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` was read, and only the P0.6 requirements were implemented.
- [ ] All 14 required codes have stable exported classes, stable `code` values, and non-empty human-readable messages: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] CLI output, API responses, Web UI error handling, and event/log payloads all use the canonical code/message contract for the touched failure paths.
- [ ] Existing behavior is preserved for statuses, exit codes, retry behavior, reconciliation behavior, and successful paths unless the source-of-truth P0.6 plan explicitly requires a change.
- [ ] Tests cover the canonical error catalog/classes and common failures for adapter missing/auth, provider rate limiting, permission denial, dirty worktree, corrupt event log, busy project lock, version mismatch, and verdict failure.
- [ ] Tests prove raw provider details are redacted from every touched external surface, including CLI/API/Web UI/events/logs where applicable.
- [ ] No unrelated cleanup, dependency addition, broad refactor, or non-P0.6 readiness work is included.
- [ ] Project-standard targeted tests plus lint/typecheck/test verification were run, or any unavailable verification was documented with the exact blocker and substitute evidence.
- [ ] `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-012.md` was written after implementation with changed files, evidence, risks, and next review action.
