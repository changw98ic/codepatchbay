## Handoff: codex -> claude - P0.6 stable errors from the promotion readiness plan

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-035 / P0.6 stable error classes and human-readable messages
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Add one canonical error/diagnostic catalog for these exact stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Use stable classes or stable constructors around the existing project error path rather than scattering ad hoc string literals across CLI, API, Web UI, and events.
- Every surfaced error must have a human-readable message and a stable machine-readable code. API, CLI, Web UI, and event payloads should all agree on the code/message pair.
- Provider-originated details must be redacted before leaving the provider boundary. Redaction must cover common token/secret forms such as bearer tokens, API keys, access tokens, passwords, and obvious `sk-...` style keys.
- Preserve existing behavior: keep existing status codes, response shape fields, event names, CLI exit behavior, and UI states unless P0.6 explicitly requires additive code/message fields.

### Rejected
- Broad cleanup of unrelated error handling | The task explicitly says to implement only the P0.6 slice.
- New dependencies for error catalogs or secret redaction | Existing utilities and small local helpers are sufficient.
- Rewriting CLI/API/Web UI/event architecture | P0.6 needs stable cross-surface errors, not a framework migration.
- Exposing raw provider errors behind a debug flag by default | The requirement specifically calls for redacted provider detail.

### Scope

**目标**: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement P0.6 only: stable error classes plus human-readable messages across CLI, API, Web UI, and events for the required codes, with tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth; confirm P0.6 wording before coding.
- `server/services/error-catalog.js` or the nearest existing shared server error module - add canonical stable codes, messages, classes, normalization, and redaction helpers.
- `server/routes/*.js` and the existing API error middleware/response helpers - ensure API failures serialize the canonical code/message and redacted detail without breaking current response fields.
- `server/services/event-store.js`, `server/services/supervisor.js`, and any existing job/project lock/version/verdict services - throw or emit canonical errors for event log corruption, stale leases, reconciled jobs, busy project locks, version mismatches, and failed verdicts.
- Existing adapter/provider service modules - map missing adapter, provider auth failure, provider rate limit, permission denial, and provider detail redaction into canonical errors.
- Existing CLI entrypoint and CLI error formatter files - print canonical human-readable messages and stable codes while preserving current exit behavior.
- `web/src/components/PipelineStatus.jsx` or the current Web UI error/status display component - render canonical messages for all required codes and keep existing visual states.
- Existing tests beside the touched modules - add or adjust focused unit/integration tests for the catalog, API serialization, CLI formatting, Web UI display, events, and provider-detail redaction.

**实现步骤**:
1. Read the P0.6 section in the promotion readiness plan and write down any exact naming, status-code, or surface requirements found there. Do not start implementation until this confirms the required code list above.
2. Locate the existing error path before editing: shared server errors, route error serialization, CLI error formatting, provider adapter error handling, Web UI error/status mapping, and event emission. Prefer extending the existing path over creating a parallel system.
3. Add the canonical catalog in the existing shared error location. It must export:
   - the exact stable code constants;
   - a human-readable default message for every code;
   - stable classes or constructors for every code;
   - a normalizer that converts thrown unknowns/existing errors into the canonical shape without losing existing fields;
   - a redaction helper for provider details.
4. Wire provider and adapter failures into the catalog:
   - `adapter_missing` when no adapter/provider implementation is available;
   - `adapter_auth_failed` when provider credentials are rejected;
   - `provider_rate_limited` when provider rate limits are detected;
   - `permission_denied` for authorization/permission failures;
   - ensure provider `detail`, `cause`, `message`, and event/API payload fields are redacted before surfacing.
5. Wire project/job/runtime failures into the same catalog:
   - `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`;
   - preserve existing control flow and only replace unstable string errors with canonical classes/messages where the same failure already exists.
6. Update API serialization so common failures include `error.code` and human-readable `error.message` with redacted optional details. Keep existing HTTP statuses and any currently documented response fields unless P0.6 source text explicitly says otherwise.
7. Update CLI formatting so canonical errors print a readable message plus stable code, with no raw provider secret material. Keep stack traces/debug output behavior exactly as it currently works.
8. Update Web UI error/status mapping to display the canonical human-readable messages for every required code, while falling back gracefully for unknown codes. Do not redesign the UI.
9. Update event payloads so emitted failure/status events carry the canonical code/message pair and redacted details. This includes `event_log_corrupt` and `job_reconciled`, even if `job_reconciled` is informational rather than fatal in the current flow.
10. Add tests before final handoff:
    - catalog test asserting every required code exists once, has a class/constructor, and has a non-empty human-readable message;
    - provider redaction test using representative secrets in messages and structured detail;
    - API tests for representative common failures: `adapter_missing`, `provider_rate_limited`, `permission_denied`, `worktree_dirty`, and `verdict_failed`;
    - CLI tests for at least one provider failure and one local project failure;
    - Web UI tests for mapped message rendering and unknown-code fallback;
    - event tests for `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, and `version_mismatch`.
11. Run the repo's normal verification commands after implementation: targeted tests for touched modules first, then the standard full test/lint/typecheck suite used by this project. Include exact commands and outputs in `deliverable-035.md`.

**注意事项**:
- Keep the diff scoped to P0.6. Do not implement adjacent P0 items from the promotion readiness plan.
- Do not modify mocks, fake providers, snapshots, or fixtures merely to hide changed production behavior. Only update test doubles when they need to represent the new canonical error contract.
- If an existing error already has a public status code or exit code, preserve it and add the stable code/message around it.
- Do not allow provider raw details to reach API JSON, CLI output, Web UI text, event payloads, or persisted diagnostics unless the promotion plan explicitly defines a safe internal-only field.
- If the current repo uses TypeScript instead of JavaScript in the relevant modules, mirror the same plan in the existing TypeScript locations and export types for the canonical error shape.

### Evidence
- Planning phase only. No terminal commands were executed and no tests were run.
- Non-shell code-intel lookup found existing P0.6-style code names in a PipelineStatus UI surface from indexed workspace artifacts; executor must verify the current source paths before editing.

### Risks
- Some required codes may be status/notice conditions rather than thrown errors, especially `job_reconciled`; handle those with the same canonical code/message contract without forcing fatal behavior.
- Existing API clients may depend on current response fields; keep changes additive unless the source-of-truth P0.6 text requires a breaking change.
- Redaction must be tested against both plain strings and structured provider error objects; otherwise secrets can leak through alternate fields.

## Next-Action
Implement the scoped P0.6 changes above, run targeted and full verification, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-035.md` with changed files, test output, behavior notes, and any remaining risks.

## Acceptance-Criteria
- [ ] The implementation is grounded in the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and does not broaden into unrelated cleanup.
- [ ] All required codes exist exactly as stable machine-readable values: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable class or constructor and a non-empty human-readable default message.
- [ ] API error responses for common failures include the stable code and human-readable message while preserving existing response behavior.
- [ ] CLI output for common failures includes the stable code and human-readable message while preserving existing exit behavior.
- [ ] Web UI error/status rendering shows human-readable messages for the required codes and has an unknown-code fallback.
- [ ] Event payloads for relevant failures/statuses include the stable code and human-readable message.
- [ ] Provider-originated details are redacted in API, CLI, Web UI, event payloads, and persisted diagnostics covered by this slice.
- [ ] Tests cover the catalog, common API failures, CLI formatting, Web UI rendering, event payloads, and redacted provider detail.
- [ ] Targeted tests for touched modules pass.
- [ ] The repo's normal lint/typecheck/test verification passes, or any non-P0.6 pre-existing failure is clearly identified with evidence.
- [ ] `deliverable-035.md` lists changed files, simplifications made, verification evidence, and remaining risks.
