## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only P0.6 stable error classes and human-readable messages

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-045-P0.6-stable-error-classes
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth; implement only P0.6 and do not broaden into unrelated cleanup.
- Introduce or extend one canonical error surface for stable error codes, typed/stable error classes, human-readable public messages, HTTP/API serialization, CLI formatting, Web UI display, and event-log payloads.
- Required stable error codes are exactly: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Provider/internal diagnostic details must remain available only in non-public/internal metadata where existing patterns allow it; all CLI/API/Web UI/event public output must use redacted, human-readable messages.
- Tests must cover common failure paths and explicitly prove provider detail redaction.

### Rejected
- Broad cleanup/refactor across unrelated error handling is rejected because this task is a narrow P0.6 promotion-readiness slice.
- Adding new dependencies for error serialization or message formatting is rejected; use existing project utilities and test stack.
- Rewriting fake/mock responders or fixtures just to make changed behavior pass is rejected unless those tests are directly asserting the newly intended stable error contract.
- Exposing raw provider errors in public messages is rejected because P0.6 requires human-readable messages and redacted provider detail.

### Scope

**目标**: Implement P0.6 from the promotion-readiness must-haves plan: add stable error classes and human-readable messages across CLI, API, Web UI, and events for the required error codes, while preserving existing behavior outside the public error contract.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first to confirm the P0.6 wording and any repository-specific acceptance notes; do not modify.
- Existing shared error/domain module, likely under `src/**/error*`, `src/**/errors*`, `packages/**/error*`, or equivalent — define the canonical code union/enum, stable error classes, default public messages, redaction helpers, and serialization helpers.
- Existing API route/server error boundary or response serializer — map thrown stable errors to consistent API responses with stable `code` and redacted human-readable `message`.
- Existing CLI error formatting layer — render stable codes and public messages without leaking raw provider details.
- Existing Web UI error display/client error adapter — show the same human-readable message/code contract from API responses or client-side stable errors.
- Existing event-log/event-emitter schema and call sites — include stable `code` and redacted public `message` for these failures without putting raw provider diagnostics in public event payloads.
- Tests near the touched modules, likely `test/**`, `tests/**`, `src/**/*.test.*`, or `packages/**/__tests__/**` — add or adjust focused tests for common failures and redacted provider detail.

**实现步骤**:
1. Read the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and record any exact wording, file hints, or required behavior before editing.
2. Locate the existing error-handling seams for CLI, API, Web UI, and events. Prefer extending existing helpers/classes over introducing parallel abstractions.
3. Add the canonical stable error contract in the existing shared error module:
   - Define the required code set exactly as listed in this plan.
   - Provide a stable base error class plus specific classes or factory helpers for each required code, following project style.
   - Provide default human-readable public messages for each code.
   - Preserve existing cause/internal detail behavior while ensuring public serialization is redacted.
4. Wire API serialization so every stable error response includes a stable code and public message. Keep current status-code behavior unless P0.6 explicitly requires a mapping; if a mapping is needed, use the closest existing project convention and keep the mapping local and explicit.
5. Wire CLI formatting so stable errors print the public message and code consistently. Do not print raw provider response bodies, tokens, secret names, stack traces, or auth payloads in normal user-facing output.
6. Wire Web UI error handling so stable API/client errors render the same human-readable message/code. Preserve current UI flows and only adjust the displayed error contract.
7. Wire event emission/logging so public event payloads contain stable `code` and redacted public `message`. If internal logs already carry raw causes, leave them internal and avoid duplicating raw provider detail into user-facing event payloads.
8. Replace ad hoc error construction at common failure call sites with the stable classes/factories for:
   - adapter missing/auth failures and provider rate limits
   - permission/secret/delete blocks
   - dirty worktree/source path mismatch
   - stale lease/corrupt event log/reconciled jobs/project lock busy/version mismatch/verdict failure
   Keep call-site edits minimal and avoid unrelated behavior changes.
9. Add focused tests:
   - Unit tests for the canonical code list, class/factory serialization, default messages, and redaction.
   - API tests for at least one representative stable error response and provider-detail redaction.
   - CLI formatting tests for at least one common failure and provider-detail redaction.
   - Web UI/client adapter tests for display of stable code/message where existing test infrastructure supports it.
   - Event serialization tests proving stable code/message and no raw provider detail.
10. Run the project’s relevant test commands after implementation. At minimum run the focused tests added/changed; if practical, also run the existing full unit test suite and any lint/typecheck commands documented by the repo.
11. Write `deliverable-045.md` using the handshake protocol and include changed files, test evidence, any deliberately untouched areas, and remaining risks.

**注意事项**:
- Keep the diff scoped to P0.6. Do not reorganize unrelated error handling, rename unrelated symbols, or perform broad formatting churn.
- Preserve existing public behavior except where the P0.6 stable error contract intentionally changes output shape/message.
- Do not introduce new dependencies.
- Do not modify fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to mask production behavior changes. Only update tests/fixtures when they directly encode the new stable error contract.
- Provider detail redaction must cover raw provider messages that may contain tokens, secrets, authorization payloads, request IDs, response bodies, or upstream stack traces.
- If a required code already exists under a different name, add a compatibility path only if needed to preserve current callers, but expose the required P0.6 code in the public contract.
- If the P0.6 source-of-truth document conflicts with this handoff, follow the source-of-truth document and note the difference in the deliverable.

## Next-Action
Implement only the P0.6 stable error classes/messages slice described above, run focused and relevant regression tests, then generate `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-045.md` with evidence and remaining risks.

## Acceptance-Criteria
- [ ] The implementation follows the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and does not broaden into unrelated cleanup.
- [ ] A canonical stable error contract exists for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable error class or project-consistent factory and a human-readable public message.
- [ ] CLI output for covered failures includes the stable code/public message and does not expose raw provider detail.
- [ ] API error responses for covered failures include the stable code/public message and do not expose raw provider detail.
- [ ] Web UI error display for covered failures uses the stable code/public message and does not expose raw provider detail.
- [ ] Event payloads/logged public events for covered failures include the stable code/public message and do not expose raw provider detail.
- [ ] Common failure tests cover representative CLI/API/Web UI/events paths.
- [ ] Redaction tests prove raw provider detail is not present in public CLI/API/Web UI/event output.
- [ ] Existing behavior outside the P0.6 stable error contract is preserved.
- [ ] Relevant focused tests pass, and broader lint/typecheck/unit verification is run where practical and reported in the deliverable.
- [ ] Code style matches existing project conventions and no new dependencies are added.
