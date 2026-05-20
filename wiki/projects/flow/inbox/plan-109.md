## Handoff: codex -> claude — P0.6 stable errors and human-readable messages

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-109 / P0.6 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, and implement only P0.6.
- Introduce a stable, centralized error taxonomy for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Each stable error must expose a machine-readable code, a human-readable default message, and a redacted details shape safe for CLI, API, Web UI, and event consumers.
- Preserve existing behavior and public flows; only normalize error classes/messages and add focused regression coverage.
- Provider-specific failure details must be redacted before reaching user-visible output, HTTP responses, persisted events, or frontend-rendered state.

### Rejected
- Broad cleanup or refactor outside P0.6 — explicitly out of scope for this slice.
- Adding unrelated error codes or changing existing success-path behavior — not required by the readiness plan.
- Surfacing raw provider responses in messages or details — violates the redacted provider detail requirement.
- Updating fake/mock responders only to make tests pass — preserve the real workflow contract and adjust tests only where they verify the intended P0.6 behavior.

### Scope

**目标**: Implement P0.6 by adding stable error classes and human-readable messages across CLI, API, Web UI, and event payloads for the required error codes, with tests covering common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 requirements.
- Existing shared error/domain module, or the nearest existing equivalent — add the stable error class, code enum/union, default message map, and redaction helper.
- Existing adapter/provider error handling files — translate adapter missing/auth/rate-limit/provider failures into stable errors without leaking raw provider detail.
- Existing permission/secret/delete/worktree/source-path/lease/event-log/job-reconciliation/project-lock/version/verdict failure paths — map current failures to the required stable codes while preserving behavior.
- Existing CLI command/output tests and CLI error rendering code — assert stable codes and human-readable messages for common failures.
- Existing API route/controller tests and API error serialization code — assert stable HTTP error payloads and redacted details.
- Existing Web UI error-rendering tests/components — assert user-visible messages come from stable error metadata rather than raw thrown errors.
- Existing event-log/event-emitter tests and event serialization code — assert event payloads carry stable error codes/messages and redacted details.

**实现步骤**:
1. Read the P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and inspect existing error handling entry points before editing.
   - Expected output: a short implementation map of current CLI/API/Web UI/event error paths and the existing module best suited for shared error definitions.
2. Add or extend the shared stable error module.
   - Define the exact required error-code set.
   - Add a base stable error class with `code`, `message`, optional safe `details`, optional `cause`, and serialization helpers if the project already has that pattern.
   - Add specific subclasses or factory helpers for each required code, matching existing style.
   - Add default human-readable messages that are clear to operators and users without exposing secrets, tokens, raw provider payloads, stack traces, filesystem internals beyond already-public paths, or authorization headers.
3. Add provider-detail redaction at the shared boundary.
   - Normalize provider causes into safe details such as provider name, status class, retry-after value, or request id only if already considered safe by existing conventions.
   - Remove or mask tokens, API keys, bearer headers, cookies, raw prompts, raw completion text, and full provider response bodies.
   - Ensure `adapter_auth_failed` and `provider_rate_limited` never expose raw provider errors in CLI/API/UI/event output.
4. Wire stable errors into backend failure paths for the required codes.
   - Map missing adapter resolution to `adapter_missing`.
   - Map adapter credential/auth failures to `adapter_auth_failed`.
   - Map provider quota/throttle responses to `provider_rate_limited`.
   - Map authorization failures to `permission_denied`.
   - Map secret scanning or secret policy blocks to `secret_blocked`.
   - Map protected delete refusals to `delete_blocked`.
   - Map dirty worktree refusal to `worktree_dirty`.
   - Map source path validation mismatch to `source_path_mismatch`.
   - Map stale lease failures to `lease_stale`.
   - Map corrupt event log read/parse failures to `event_log_corrupt`.
   - Map reconciliation-created or reconciliation-updated jobs to `job_reconciled` where the existing flow treats that as a reportable condition.
   - Map project lock contention to `project_lock_busy`.
   - Map client/server or schema version conflicts to `version_mismatch`.
   - Map failed verdict/quality gate outcomes to `verdict_failed`.
5. Wire serialization/rendering consistently across surfaces.
   - CLI: render the stable human-readable message and include the stable code in the existing error output format.
   - API: serialize a predictable error payload containing the stable code, message, and redacted details while preserving current HTTP status behavior unless the readiness plan says otherwise.
   - Web UI: render stable human-readable messages from API/event errors and keep fallback handling for unknown errors.
   - Events: persist or emit stable error code/message/redacted details for failed operations without storing raw causes.
6. Add focused regression tests before or alongside implementation changes.
   - Cover representative common failures across CLI/API/Web UI/events rather than duplicating every code on every surface.
   - Include at least one table-driven/unit test that proves all required codes have stable default messages.
   - Include provider redaction tests proving raw provider detail, bearer tokens, API keys, and raw response bodies are absent from serialized output.
   - Add targeted tests for the highest-risk mappings: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `event_log_corrupt`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
7. Run the smallest meaningful verification set first, then the broader project checks required by the repo.
   - Start with the affected unit tests for shared errors, adapters/providers, CLI, API, UI error rendering, and event serialization.
   - Then run the repo’s standard lint/typecheck/test/static-analysis commands documented in package scripts or project guidance.
   - Do not report completion until fresh command output confirms the relevant checks pass.

**注意事项**:
- Keep the diff small, reversible, and scoped to P0.6.
- Do not introduce new dependencies.
- Prefer existing error utilities, serializers, frontend conventions, and test helpers over new abstractions.
- Preserve current HTTP status codes, exit codes, event names, and user workflows unless the P0.6 source plan explicitly requires a change.
- Unknown errors should continue to use the existing fallback behavior; P0.6 is about stable handling for the listed known failures.
- Avoid changing snapshots, fixtures, fake provider responses, or mock behavior merely to satisfy production changes unless the test itself is intentionally covering the new stable-error contract.
- If an existing path cannot cleanly distinguish one required code from another, add the narrowest local classification needed and document the residual risk in the deliverable.

## Next-Action
Implement only the P0.6 stable-error slice described above, run focused and standard verification, then write `deliverable-109.md` with changed files, tests run, evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] The shared stable error taxonomy contains exactly the required P0.6 codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] Each required code has a stable class or factory, a machine-readable code, and a human-readable default message.
- [ ] CLI-visible failures for common paths render stable human-readable messages and expose stable codes without raw provider detail.
- [ ] API error responses serialize stable code/message/redacted details while preserving existing HTTP status behavior unless the source plan explicitly requires otherwise.
- [ ] Web UI error rendering displays stable human-readable messages for API/event errors and keeps existing fallback behavior for unknown errors.
- [ ] Event payloads for failed/reportable operations include stable code/message/redacted details and do not persist raw causes.
- [ ] Provider auth and rate-limit failures are redacted across CLI, API, Web UI, and events; tests prove secrets, bearer tokens, API keys, raw provider bodies, and raw provider error strings are not exposed.
- [ ] Focused regression tests cover common failures, including representative tests for adapter, permission, secret, delete, worktree, event-log, lock, version, and verdict failures.
- [ ] Existing behavior outside the P0.6 error normalization slice is preserved.
- [ ] No unrelated cleanup, dependency additions, broad refactors, or non-P0.6 behavior changes are included.
- [ ] Relevant unit/integration tests plus repo-standard lint/typecheck/test/static-analysis checks pass with fresh evidence in `deliverable-109.md`.
