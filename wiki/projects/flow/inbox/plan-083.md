# TASK-083 Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement only P0.6 stable error classes and human-readable messages

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-083 / P0.6 promotion readiness errors
- **Timestamp**: 2026-05-19T22:16:26+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.6 slice.
- Add a stable project-level error taxonomy for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each error must expose a stable machine-readable code, a stable class/type, a human-readable message, and a safe detail channel that redacts provider secrets or raw sensitive payloads.
- CLI, API, Web UI, and event/log emission should consume the same canonical error representation rather than each surface inventing strings.
- Preserve existing behavior outside error naming, message presentation, status mapping, and safe detail redaction.

### Rejected
- Broad promotion-readiness cleanup outside P0.6 — explicitly out of scope for this slice.
- Renaming unrelated errors or changing success-path behavior — unnecessary blast radius.
- Adding a new dependency for redaction or error formatting — use existing utilities/patterns unless the repo already has a suitable dependency.
- Updating fake provider responders, snapshots, or fixtures only to force tests green — forbidden unless the test double itself is the bug or the changed behavior is intentionally covered.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: introduce stable error classes and human-readable messages for the listed failure codes across CLI/API/Web UI/events, with tests covering common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; use only to confirm P0.6 requirements.
- Existing shared error module, if present, such as `src/**/errors*`, `packages/**/errors*`, or similar — add/extend canonical error classes, code enum/union, message registry, status/category metadata, serialization, and redaction hooks.
- Existing provider/adapter failure paths — map adapter lookup/auth/rate-limit failures to `adapter_missing`, `adapter_auth_failed`, and `provider_rate_limited` without changing success behavior.
- Existing permission/secret/delete guards — map deny/block paths to `permission_denied`, `secret_blocked`, and `delete_blocked`.
- Existing worktree/source/lease/event-log/job/project-lock/version/verdict paths — map current thrown/reported failures to `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Existing CLI rendering code — render the canonical human-readable message and stable code for command failures.
- Existing API error response code — serialize stable code/class/message plus redacted details and preserve existing HTTP status semantics unless P0.6 explicitly defines a safer mapping.
- Existing Web UI error display code — display the human-readable message from the canonical error shape and avoid leaking raw provider detail.
- Existing event/log emission code — include stable error codes/classes and redacted details in failure events.
- Existing unit/integration tests near these modules — add focused tests for common failures and redacted provider detail.

**实现步骤**:
1. Read `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and extract only P0.6 requirements; do not implement adjacent P0 items.
2. Locate the repo's current error creation, serialization, CLI rendering, API error handling, Web UI failure display, and event/log emission paths.
3. Add or extend a canonical error taxonomy with exactly the fourteen P0.6 codes, stable class names/types, default human-readable messages, optional safe details, and a single conversion helper for unknown/native errors.
4. Implement provider-detail redaction in the canonical error serialization path so provider tokens, authorization headers, API keys, secrets, raw credentials, and raw provider bodies cannot reach CLI/API/Web UI/events.
5. Map existing adapter/provider failures:
   - missing adapter/provider configuration -> `adapter_missing`
   - provider authentication failure -> `adapter_auth_failed`
   - provider rate limit/throttle/quota response -> `provider_rate_limited`
6. Map existing guard and policy failures:
   - access or filesystem permission failure -> `permission_denied`
   - blocked secret exposure/write/propagation -> `secret_blocked`
   - blocked destructive delete -> `delete_blocked`
7. Map existing repository/runtime coordination failures:
   - dirty worktree guard -> `worktree_dirty`
   - mismatched source path guard -> `source_path_mismatch`
   - stale lease detection -> `lease_stale`
   - corrupt event log read/replay -> `event_log_corrupt`
   - reconciled job state notification/failure path -> `job_reconciled`
   - busy project lock acquisition -> `project_lock_busy`
   - version/schema/protocol mismatch -> `version_mismatch`
   - failed verdict/validation result -> `verdict_failed`
8. Update CLI/API/Web UI/events to use the canonical error object/message. Keep existing status codes, exit codes, and event names unless a current mapping is clearly unstable or contradicts the P0.6 plan.
9. Add focused tests close to existing coverage:
   - canonical construction/serialization for every P0.6 code
   - CLI/API surface includes stable code and human-readable message for representative failures
   - Web UI rendering uses the canonical message and does not render raw provider detail
   - event/log emission includes stable code/class and redacted details
   - provider auth/rate-limit detail is redacted while preserving safe diagnostic context
10. Run the repo's normal lint/typecheck/test commands documented in package scripts or project docs. If the full suite is expensive, run targeted tests first, then the smallest broader verification that covers CLI/API/Web UI/events.
11. Produce `deliverable-083.md` with changed files, test commands and outputs, simplifications made, behavior preserved, and remaining risks.

**注意事项**:
- Keep the diff tightly scoped to P0.6. Do not refactor unrelated error handling, logging, UI copy, adapters, job state, or project-lock behavior.
- Do not introduce new dependencies.
- Prefer existing naming, serialization, and UI-rendering patterns.
- Human-readable messages should be stable, actionable, and safe. They should identify the failure category without exposing provider credentials, tokens, request bodies, secret values, or raw auth headers.
- Machine-readable codes must remain lowercase snake_case exactly as listed.
- Stable classes/types should be easy for tests and downstream callers to match without parsing messages.
- Preserve existing HTTP/exit status behavior unless the existing behavior leaks secrets or prevents the stable code from being returned.
- If a listed code has no existing failure path, add the taxonomy entry and serialization test, then document that no runtime mapping was found in the deliverable rather than inventing unrelated behavior.
- If existing tests assert brittle legacy strings, adjust only the assertions necessary to verify the new stable error contract.

## Next-Action
Implement the scoped P0.6 error taxonomy and surface mappings described above, add/adjust tests for common failures and redacted provider detail, run verification, and write `deliverable-083.md` when complete.

## Acceptance-Criteria
- [ ] The implementation is grounded in P0.6 of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and does not include unrelated promotion-readiness work.
- [ ] All fourteen required codes exist exactly as stable machine-readable identifiers: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable error class/type and a human-readable default message.
- [ ] CLI failures for representative mapped errors display the canonical human-readable message and stable code.
- [ ] API failures serialize the canonical code/class/message and include only redacted safe details.
- [ ] Web UI failure states render the canonical human-readable message and never display raw provider credentials, tokens, authorization headers, API keys, secret values, or raw provider bodies.
- [ ] Event/log failure payloads include the stable code/class and redacted provider detail.
- [ ] Common failure tests cover adapter missing/auth/rate-limit, permission or delete block, worktree/source mismatch, event-log corruption or stale lease, and verdict failure.
- [ ] Redaction tests prove sensitive provider detail is removed while safe diagnostic context remains.
- [ ] Existing success-path behavior, public command/API semantics, and unrelated UI flows are preserved.
- [ ] Relevant lint/typecheck/tests pass, or any inability to run a verification command is documented with the reason in `deliverable-083.md`.
- [ ] Changed files, simplifications made, and remaining risks are reported in `deliverable-083.md`.
