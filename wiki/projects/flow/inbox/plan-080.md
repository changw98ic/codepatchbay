# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.6 stable error classes and human-readable messages

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-080 / P0.6 promotion readiness stable errors
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth before implementation; if any detail below conflicts with that plan, follow the source plan and document the delta in the deliverable.
- Implement only P0.6: stable error classes and human-readable messages for `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Use a single canonical error taxonomy/registry if one already exists; otherwise add the smallest shared module needed so CLI, API, Web UI, and emitted events resolve the same stable error codes, classes, and display messages.
- Preserve existing control flow and status behavior. This task should normalize error identity/message surfaces, not change when failures occur.
- Provider or adapter diagnostic detail must be redacted before it appears in CLI output, API responses, Web UI state, events, logs exposed to users, or tests.

### Rejected
- Broad cleanup or unrelated refactors | The promotion readiness directive explicitly limits this slice to P0.6.
- Replacing existing thrown errors wholesale | Higher risk of behavior drift; wrap/map at boundaries unless a local stable class is already the established pattern.
- Test-only fixture changes to force passing behavior | Existing guidance says not to modify fake/mock assets merely to pass production behavior changes.
- Adding dependencies for error formatting or redaction | Not needed for stable classes/messages and prohibited unless explicitly requested.

### Scope

**目标**: Add stable, reusable error classes and human-readable messages for the P0.6 error codes, then ensure the CLI, API, Web UI, and event payloads expose those stable errors consistently while preserving current behavior.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements.
- Existing shared error module, error-code registry, API error serializer, or equivalent core error boundary — add/extend stable classes, code constants, default messages, retryability/status metadata where the existing design supports it.
- Existing CLI command error handling/output tests and implementation files — map common failures to the canonical error codes/messages without leaking provider details.
- Existing API route/server error serialization tests and implementation files — return stable machine-readable codes/classes and human-readable messages for common P0.6 failures.
- Existing Web UI error presentation/state tests and implementation files — show the canonical human-readable messages and avoid raw provider detail.
- Existing event emitter/event-log schema tests and implementation files — include stable error code/class/message fields for failure/reconciliation events, and handle corrupt event logs with `event_log_corrupt`.

**实现步骤**:
1. Read the promotion readiness source plan and locate any existing P0.6 notes, required field names, or target test commands; keep implementation scoped to those notes.
2. Inventory current error definitions and boundary serializers for CLI, API, Web UI, and events. Identify the smallest shared place to define the 14 stable codes and default messages.
3. Add or extend canonical error definitions for:
   - `adapter_missing`: adapter/provider is not configured or cannot be found.
   - `adapter_auth_failed`: adapter/provider authentication failed; redact tokens, keys, headers, and provider raw response bodies.
   - `provider_rate_limited`: provider throttled the request; preserve existing retry behavior if present.
   - `permission_denied`: caller is not allowed to perform the action.
   - `secret_blocked`: requested operation was blocked because it would expose or persist a secret.
   - `delete_blocked`: delete operation was intentionally blocked by safety rules.
   - `worktree_dirty`: operation requires a clean worktree.
   - `source_path_mismatch`: requested project/source path does not match the registered source path.
   - `lease_stale`: lease is no longer current.
   - `event_log_corrupt`: event log cannot be parsed or fails validation.
   - `job_reconciled`: job state was reconciled after restart or consistency repair.
   - `project_lock_busy`: project lock is already held; preserve existing lock contention semantics.
   - `version_mismatch`: caller/client/versioned payload does not match expected version.
   - `verdict_failed`: verification/verdict step completed with a failed verdict.
4. Route common production failure paths to the canonical error definitions at boundary edges: CLI output, API error responses, Web UI display data, and emitted event payloads. Prefer wrapping/mapping existing errors over moving business logic.
5. Add or adjust focused tests for representative common failures across the four surfaces. At minimum cover auth failure redaction, rate limit, permission denial, dirty worktree/delete block safety, stale lease or busy project lock, corrupt event log, source path mismatch, version mismatch, failed verdict, and reconciled job events.
6. Add explicit redaction tests proving provider detail is not exposed. Include examples with API keys/tokens, authorization headers, provider raw messages, and nested detail objects if those structures exist.
7. Run the project’s relevant lint/typecheck/unit/integration tests identified by the source plan or package scripts. If a full suite is too broad, run the narrowest suites proving CLI/API/Web UI/events plus any central error module tests.
8. Produce `deliverable-080.md` with changed files, exact tests run, any skipped verification, and notes on any source-plan requirement that could not be satisfied.

**注意事项**:
- Do not implement adjacent P0 items from the promotion readiness plan.
- Do not change public success payloads, event names, job lifecycle behavior, lock semantics, deletion rules, or worktree checks except where needed to attach stable error identity/message fields.
- Keep messages human-readable and stable enough for tests; avoid embedding volatile provider text, stack traces, request IDs, paths containing secrets, or timestamps in default messages.
- Preserve machine-readable error codes exactly as listed in this plan.
- If the project already has error names/classes that differ from these codes, add compatibility mapping rather than breaking existing callers.
- For `job_reconciled`, confirm whether it is represented as an error-like event, warning, or status event in the source plan before coding; preserve that intended classification.

### Evidence
- Planning-only phase. No terminal commands were executed.
- Local file reads were not available without terminal commands in this surface; implementation must first read the source plan path above and reconcile any detail before editing.

### Risks
- Existing error architecture may already encode names/statuses differently; avoid broad rewrites by adding a compatibility mapping.
- Web UI and API may consume the same serialized shape; changing field names could break callers. Prefer additive fields unless the source plan explicitly requires replacement.
- Provider detail redaction can be incomplete if there are multiple serialization paths; tests must cover nested details and raw `Error.cause`/provider payload paths.
- `job_reconciled` may not be a failure. Treat it according to the promotion readiness source plan rather than forcing it into thrown-error flow.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.6 according to the scoped steps above, run focused verification for CLI/API/Web UI/events and redaction, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-080.md`.

## Acceptance-Criteria
- [ ] The source promotion readiness plan has been read, and implementation is limited to P0.6.
- [ ] All 14 codes are defined in a stable canonical place: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each code has a stable error class or class-equivalent identity and a human-readable default message.
- [ ] CLI failure output surfaces the stable code/message for representative common failures without exposing provider secrets or raw provider diagnostics.
- [ ] API error responses surface the stable code/message/class-equivalent identity for representative common failures without exposing provider secrets or raw provider diagnostics.
- [ ] Web UI error state/presentation uses the stable human-readable messages for representative common failures without exposing provider secrets or raw provider diagnostics.
- [ ] Event payloads/log handling include stable error identity/message fields where failures or reconciliation events are emitted, including `event_log_corrupt` and `job_reconciled` behavior.
- [ ] Tests cover common failures across CLI/API/Web UI/events, including at least one redacted provider-detail case with nested or raw provider data.
- [ ] Existing behavior is preserved outside error identity/message normalization; no unrelated cleanup or adjacent P0 work is included.
- [ ] Relevant lint/typecheck/test commands pass, or any unrun/failed verification is explicitly documented in the deliverable with reason and risk.
