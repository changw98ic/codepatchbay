## Handoff: codex -> claude

# Plan 051: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-051-P0.6-stable-errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Add one canonical error catalog for the required stable codes, with human-readable default messages and redaction rules, then route CLI/API/Web UI/event surfaces through it.
- Preserve existing behavior and response shapes where possible by adding `code`, `message`, and redacted `detail` fields rather than replacing unrelated status/state fields.
- Keep the implementation in the live source tree only; do not edit historical job copies under `cpb-task/worktrees/*`.
- Cover common failure paths and provider-detail redaction with targeted tests instead of broad snapshot churn.

### Rejected
- Broad cleanup of error handling outside P0.6, because the promotion slice explicitly says not to broaden into unrelated cleanup.
- Per-surface hardcoded messages, because that would make CLI/API/Web UI/events drift again.
- Exposing raw provider errors in API responses, event payloads, CLI output, or Web UI, because P0.6 explicitly requires redacted provider detail.

### Scope

**目标**: Implement P0.6 only: stable error classes/codes and human-readable messages across CLI/API/Web UI/events for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`, with tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm exact P0.6 wording before edits.
- `/Users/chengwen/dev/flow/shared/error-catalog.json` — add the canonical stable code/message catalog if no equivalent shared catalog already exists.
- `/Users/chengwen/dev/flow/server/services/stable-errors.js` — add `FlowError`, code-specific subclasses, serialization helpers, and provider-detail redaction if no equivalent server helper already exists.
- `/Users/chengwen/dev/flow/server/services/readiness-checks.js` — map adapter readiness failures to `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, and `permission_denied`.
- `/Users/chengwen/dev/flow/server/services/secret-policy.js` — map protected secret blocks to `secret_blocked` while preserving current blocking behavior.
- `/Users/chengwen/dev/flow/server/routes/projects.js` — map blocked deletes and source-path mismatches to `delete_blocked` and `source_path_mismatch`.
- `/Users/chengwen/dev/flow/server/services/lease-manager.js` — map stale/busy lease outcomes to `lease_stale` and `project_lock_busy`.
- `/Users/chengwen/dev/flow/server/services/event-store.js` — map corrupt event-log reads/repairs to `event_log_corrupt` and emit stable error payloads in events.
- `/Users/chengwen/dev/flow/server/services/jobs-index.js` — map unsupported persisted versions to `version_mismatch` where index/runtime versions are validated.
- `/Users/chengwen/dev/flow/server/services/reconcile.js` — emit `job_reconciled` as a stable informational event/message when job state is reconciled.
- `/Users/chengwen/dev/flow/server/routes/review.js` and `/Users/chengwen/dev/flow/server/services/review-session.js` — map verdict processing failures to `verdict_failed`.
- `/Users/chengwen/dev/flow/server/services/runtime-cli.js` — format known `FlowError` instances in CLI-facing output with stable code and human-readable message.
- `/Users/chengwen/dev/flow/server/routes/hub.js` and affected API routes that currently expose these failures — ensure JSON responses include stable `error.code`, `error.message`, and redacted `error.detail`.
- `/Users/chengwen/dev/flow/web/src/lib/errorMessages.js` — add a Web UI formatter backed by the same catalog if no equivalent helper exists.
- `/Users/chengwen/dev/flow/web/src/components/PipelineStatus.jsx` and `/Users/chengwen/dev/flow/web/src/pages/Dashboard.jsx` — render stable human-readable messages for known codes while preserving existing status UI.
- `/Users/chengwen/dev/flow/server/**/*.test.js` — add/adjust focused server tests for common failures, serialization, events, and redaction.
- `/Users/chengwen/dev/flow/web/src/**/*.test.jsx` — add/adjust focused Web UI tests for known error-code rendering and redacted detail display.

**实现步骤**:
1. Read the P0.6 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; do not implement any other P0/P1/P2 items.
2. Inspect existing error helpers before adding new files. If a canonical helper already exists, extend it; otherwise add `/Users/chengwen/dev/flow/shared/error-catalog.json` and `/Users/chengwen/dev/flow/server/services/stable-errors.js`.
3. Define the exact stable code set: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, define a stable human-readable message. Keep wording concise, actionable, and safe for CLI/API/Web UI/event display. Example shape: `{ "code": "adapter_missing", "message": "Required adapter is not installed or configured." }`.
5. Implement server-side error classes with stable `code`, `message`, optional `httpStatus`, optional `severity`, and redacted `detail`. Include a generic `FlowError` base class plus code-specific subclasses or factory exports named predictably from each code.
6. Implement a single serialization path such as `toStableError(error)` / `serializeStableError(error)` that returns `{ code, message, detail? }` and falls back to existing generic behavior for unknown errors.
7. Implement provider-detail redaction in the server helper. Redact tokens, API keys, bearer headers, cookie/session values, query-string secrets, and provider raw bodies before they reach API JSON, CLI output, events, logs intended for UI, or Web UI props.
8. Update readiness/adapter paths so missing adapters, authentication failures, rate limits, and permission failures raise or serialize known errors instead of ad hoc strings.
9. Update project/delete/source-path/secret/lease/event-log/reconcile/version/verdict paths to attach the matching stable code and message without changing the success path or unrelated state transitions.
10. Update API error responses at touched route boundaries so known failures expose stable JSON under an `error` object, while preserving current HTTP status codes unless P0.6 explicitly requires a clearer existing status mapping.
11. Update event payloads written by `event-store`, reconciliation, readiness, and job-block paths so consumers can read stable `error.code` / `error.message`; keep existing event names and terminal-state semantics unchanged.
12. Update CLI formatting in `server/services/runtime-cli.js` so known failures show the human-readable message and stable code, with provider details redacted.
13. Update Web UI formatting through a small helper in `web/src/lib/errorMessages.js`; render known error messages in `PipelineStatus.jsx` and dashboard surfaces without adding new visual states beyond what the current UI already supports.
14. Add focused server tests for serialization, all required code catalog entries, common route/service failures, corrupt event-log handling, reconciliation event shape, and provider-detail redaction.
15. Add focused Web UI tests that known codes render the canonical message and raw provider secrets are not displayed.
16. Run the project’s existing relevant test commands and include exact results in `deliverable-051.md`. If any broader suite is too slow or unavailable, run the smallest reliable server and Web UI test subsets that cover this slice and record the gap.

**注意事项**:
- Do not edit `/Users/chengwen/dev/flow/cpb-task/worktrees/*`; those are historical job/worktree copies.
- Do not add dependencies.
- Do not alter fake/mock responders, fixtures, snapshots, or test doubles merely to make tests pass. Only adjust tests that directly cover P0.6 behavior or are now asserting the intended stable error contract.
- Preserve existing HTTP statuses, event names, job state transitions, and UI layout unless a touched path currently has no stable error contract.
- Keep provider raw details out of user-visible surfaces. Tests must prove raw secrets such as bearer tokens, `api_key=...`, `sk-...`, cookies, and provider raw bodies are redacted.
- Keep this as a P0.6 implementation slice; do not refactor unrelated readiness, lease, event-log, reconcile, or Web UI code.

### Evidence
- Planning-only handoff created without executing terminal commands.
- Code-intel symbol lookup identified relevant live source areas: `server/services/readiness-checks.js`, `server/services/event-store.js`, `server/services/runtime-cli.js`, `server/services/job-store.js`, `server/services/jobs-index.js`, `server/services/lease-manager.js`, `server/services/secret-policy.js`, `server/routes/projects.js`, `server/routes/hub.js`, `server/routes/review.js`, `web/src/components/PipelineStatus.jsx`, and `web/src/pages/Dashboard.test.jsx`.

### Risks
- The exact existing test runner commands were not inspected in this planning phase because terminal commands were disallowed; Claude must inspect package scripts before running tests.
- The current module format may require naming/import adjustments for the shared catalog. Prefer JSON for cross server/Web use, but extend an existing catalog if one already exists.
- Some required codes are informational (`lease_stale`, `job_reconciled`) rather than fatal errors; implement them as stable event/message classes without forcing failure semantics.

## Next-Action
Implement the P0.6 slice exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Keep changes scoped, add/adjust focused tests, preserve existing behavior, run relevant verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-051.md` with changed files, test evidence, and known risks.

## Acceptance-Criteria
- [ ] The implementation is limited to P0.6 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
- [ ] All required stable codes exist exactly as specified: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable human-readable message available to CLI, API, Web UI, and event consumers.
- [ ] Server-side known failures use stable error classes or factories with predictable `code`, `message`, and redacted `detail`.
- [ ] API responses for touched known failures expose stable `error.code` and `error.message` while preserving existing status behavior where compatible.
- [ ] CLI-facing known failures show the stable code/message and do not expose raw provider secrets.
- [ ] Web UI surfaces render the canonical human-readable message for known codes and do not expose raw provider secrets.
- [ ] Event payloads for touched known failures/reconciliation include stable code/message fields without changing unrelated event semantics.
- [ ] Tests cover common failures across adapter readiness, permissions/secret/delete/source-path blocks, lease busy/stale, event-log corruption, reconciliation, version mismatch, and verdict failure where those paths exist.
- [ ] Tests prove provider details are redacted from serialized errors and UI-visible messages.
- [ ] No unrelated cleanup, dependency changes, or historical `cpb-task/worktrees/*` edits are included.
- [ ] Relevant server/Web tests pass, and exact verification commands plus results are recorded in `deliverable-051.md`.
