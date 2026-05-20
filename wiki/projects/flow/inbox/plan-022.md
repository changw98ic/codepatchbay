## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-022 / P0.6 stable error taxonomy and messages from "Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail."
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative scope document, and implement only the P0.6 slice.
- Introduce or extend one central error catalog for the exact stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each stable error entry must expose a machine-stable code/class and a human-readable message suitable for CLI output, API responses, Web UI rendering, and event payloads.
- Provider/auth diagnostic details must be redacted before they cross process/UI/event/API boundaries; raw provider messages may be retained only in internal logs if the project already has an explicit safe internal logging path.
- Preserve existing behavior and status semantics wherever possible; map existing failures into the stable taxonomy without broad refactors or unrelated cleanup.

### Rejected
- Rejected broad error-handling rewrite across the project because P0.6 requires stable classes/messages only and explicitly says to keep changes scoped.
- Rejected adding a new dependency for redaction or error serialization because the task can be completed with existing project utilities and local helpers.
- Rejected changing unrelated test fixtures, mocks, snapshots, or fake responders just to make tests pass; tests should assert the intended real workflow and redaction contract.
- Rejected adding additional error codes outside the P0.6 list because that broadens the promotion-readiness slice.

### Scope

**目标**: Implement P0.6 from the promotion readiness must-haves plan by adding a stable, documented error taxonomy with human-readable messages across CLI, API, Web UI, and event/log payload surfaces for the exact listed codes, plus focused tests for common failures and redacted provider detail.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the P0.6 scope and non-goals.
- Error catalog module already used by the project, or the nearest shared error module if no catalog exists — add the 14 stable codes, class names, default human messages, and safe serialization/redaction helpers.
- CLI command/error rendering modules — ensure mapped failures print the stable code/class and the human-readable message without leaking provider secrets.
- API error serialization/response modules — ensure mapped failures return the stable code/class, human-readable message, and existing compatible status behavior.
- Web UI error display/state modules — ensure the UI consumes the stable code/message fields instead of parsing raw provider text.
- Event/job log serialization modules — ensure events use stable codes/messages and redact provider detail for outward-facing payloads.
- Existing unit/integration tests covering CLI/API/event/UI failure paths — add or adjust tests for the common failures in this slice and for redacted provider detail.

**实现步骤**:
1. Read the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify any project-specific acceptance notes for this slice before editing.
2. Locate the current shared error shape used by CLI, API, Web UI, and event/job logs. If multiple shapes exist, add the taxonomy at the narrowest shared boundary and adapt existing per-surface renderers to consume it.
3. Define stable error classes/codes for exactly these values:
   `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, provide a concise human-readable default message. Messages should tell a user what failed and, where safe, what to do next; they must not include tokens, credentials, full provider request/response bodies, filesystem secrets, or raw remote error blobs.
5. Add a serializer/redaction path that emits the stable code/class and safe message for CLI/API/Web UI/events. Preserve existing fields that callers already depend on unless they currently leak sensitive provider details.
6. Map existing common failure sources into the taxonomy:
   adapter discovery/config failures to `adapter_missing`;
   adapter credential/provider auth failures to `adapter_auth_failed`;
   provider throttling/quota failures to `provider_rate_limited`;
   access-control failures to `permission_denied`;
   secret-protection refusal to `secret_blocked`;
   destructive operation refusal to `delete_blocked`;
   dirty worktree protection to `worktree_dirty`;
   source path validation mismatch to `source_path_mismatch`;
   stale lease handling to `lease_stale`;
   corrupt event log handling to `event_log_corrupt`;
   reconciliation notification to `job_reconciled`;
   lock contention to `project_lock_busy`;
   optimistic/version conflict to `version_mismatch`;
   failed verdict/validation result to `verdict_failed`.
7. Update CLI output tests for representative failures: at minimum `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `worktree_dirty`, and `verdict_failed`.
8. Update API/event serialization tests for representative failures: at minimum `secret_blocked`, `delete_blocked`, `lease_stale`, `event_log_corrupt`, `project_lock_busy`, and `version_mismatch`.
9. Add a redaction-focused test that injects provider detail containing obvious sensitive values, such as `Authorization: Bearer sk-test-secret`, `api_key=abc123`, or raw provider response text, and asserts those details do not appear in CLI/API/Web UI/event outward-facing output.
10. Run the project's relevant test commands after implementation, including targeted failure-path tests first and the broader standard test/lint/typecheck suite if available. Capture exact command output in the deliverable.
11. Produce `deliverable-022.md` with changed files, exact tests run, evidence, and any remaining risk. Do not include unrelated cleanup or opportunistic refactors.

**注意事项**:
- Keep the implementation scoped to P0.6. Do not start adjacent P0/P1 items from the promotion readiness plan.
- Do not rename public APIs or change existing status codes unless a current path cannot represent the stable error class/message without doing so.
- Do not expose raw provider/auth details to CLI, API, Web UI, or events. Redaction must be asserted by tests.
- Keep messages stable enough for docs and UI, but tests should primarily assert codes/classes plus key safe text rather than brittle full prose unless the project already snapshots user-facing messages.
- Preserve existing behavior for successful paths and unrelated failure paths.
- If an error surface cannot be fully wired without broad architectural work, implement the narrow adapter at its boundary and document the remaining risk in `deliverable-022.md`.

## Next-Action
Implement the P0.6 stable error taxonomy and surface mappings exactly as scoped above, add/adjust focused tests for common failure paths and redacted provider detail, run relevant verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-022.md`.

## Acceptance-Criteria
- [ ] The implementation is scoped to P0.6 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; no unrelated cleanup or adjacent plan items are included.
- [ ] All 14 required stable error codes/classes exist exactly as named: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required error code/class has a safe human-readable message used by CLI, API, Web UI, and event/job payload rendering.
- [ ] CLI outward-facing failures include the stable code/class and safe message for representative common failures.
- [ ] API outward-facing failures include the stable code/class and safe message while preserving existing compatible status behavior.
- [ ] Web UI error rendering consumes stable code/message fields and does not parse or display raw provider details.
- [ ] Event/job log outward-facing payloads include stable code/message fields and do not leak provider secrets.
- [ ] Provider/auth diagnostic detail is redacted in tests; obvious secrets such as bearer tokens, API keys, and raw provider response bodies are absent from CLI/API/Web UI/event outputs.
- [ ] Existing behavior is preserved for successful paths and unrelated failure paths.
- [ ] Targeted tests for common failure mapping and provider-detail redaction pass.
- [ ] Standard relevant project verification commands, such as tests/lint/typecheck where available, pass or any pre-existing unrelated failures are documented with evidence.
