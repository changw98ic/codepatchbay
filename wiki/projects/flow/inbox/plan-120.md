## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-120 / P0.6 stable error classes and messages
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, and implement only the P0.6 slice.
- Introduce or complete one canonical, stable error taxonomy for the required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- Keep machine-facing error codes stable and human-facing messages readable across CLI, API responses, Web UI surfaces, and emitted events.
- Preserve existing behavior by adapting current error paths to the canonical classes/messages instead of broad rewrites.
- Redact provider/system details in user-visible messages and test that sensitive provider detail is not leaked.
- Add focused regression tests for common failure paths and event/API/CLI/Web serialization where existing test seams already exist.

### Rejected
- Do not implement unrelated cleanup, rename broad subsystems, or restructure adapters outside what P0.6 requires.
- Do not add new dependencies for error handling, redaction, or testing.
- Do not change fake/mock responders, snapshots, fixtures, or test doubles only to force green tests after production changes; adjust them only when the test itself is explicitly covering the P0.6 contract.
- Do not invent new error codes beyond the required list unless an existing internal wrapper must preserve backward compatibility; if so, map it to one of the stable P0.6 codes at boundaries.

### Scope

**目标**: Implement P0.6 from the promotion readiness plan: stable error classes plus human-readable, redacted messages across CLI/API/Web UI/events for the required error codes, with focused tests for common failures and redacted provider detail.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for the exact P0.6 requirements.
- Error taxonomy/module files such as `src/**/errors*`, `src/**/error*`, `packages/**/errors*`, or equivalent existing project location — add or extend canonical classes, code constants, message mapping, redaction helpers, and serialization.
- CLI command/runner files such as `src/**/cli/**`, `src/**/commands/**`, or equivalent — route failures through the stable error taxonomy and print readable messages with stable codes.
- API route/server files such as `src/**/api/**`, `src/**/server/**`, or equivalent — serialize stable error codes/messages without leaking provider detail.
- Web UI error display files such as `src/**/web/**`, `src/**/ui/**`, `app/**`, or equivalent — display human-readable messages based on stable codes while preserving existing UI behavior.
- Event emission/log files such as `src/**/events/**`, `src/**/event-log**`, or equivalent — ensure emitted failure/reconciliation events carry stable codes/messages and redacted details.
- Existing tests near the touched code, such as `test/**`, `tests/**`, `src/**/*.test.*`, `packages/**/*.test.*`, or equivalent — add/adjust focused coverage for common failures, boundary serialization, and redaction.

**实现步骤**:
1. Read the P0.6 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and inspect existing error handling paths for CLI, API, Web UI, and events before editing.
2. Locate the current central error abstraction, if any. If one exists, extend it. If none exists, add the smallest canonical module that exports stable error codes, typed/classes for the P0.6 codes, a message map, redaction helper, and boundary serialization helpers.
3. Define canonical error classes or factory functions for all required codes:
   `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
4. For each code, provide a human-readable default message that is actionable but not provider-secret-specific. Keep provider/internal detail available only in safe debug/internal fields if the existing architecture already supports that; otherwise omit it from public boundaries.
5. Wire common CLI failure paths to the canonical taxonomy. CLI output should include a readable message and stable code, preserve existing exit behavior, and avoid exposing raw provider auth tokens, headers, secrets, full provider responses, or raw stack traces by default.
6. Wire API/server error responses to the same taxonomy. Responses should expose stable `code` and human-readable `message`; status codes should preserve existing semantics where already defined.
7. Wire Web UI error rendering to consume stable codes/messages. Avoid broad visual refactors; update only the error-display plumbing needed to show readable P0.6 messages.
8. Wire event emission/logging paths so failure and reconciliation events use the stable codes/messages. Confirm `event_log_corrupt` and `job_reconciled` have explicit event-safe representations.
9. Add focused tests for representative common failures across the affected boundaries. Prioritize existing seams for adapter auth/missing adapter, provider rate limit, permission/secret/delete blocks, dirty worktree/source mismatch, stale lease/project lock/version mismatch, corrupt event log, reconciled job, and failed verdict.
10. Add or adjust redaction tests proving provider detail is not exposed in CLI/API/Web UI/event public output. Include realistic sensitive examples such as bearer tokens, API keys, auth headers, raw provider body fragments, and secret-looking values.
11. Run the project’s normal lint/typecheck/test commands. If there is a documented narrower test target for touched packages, run that first, then the broader required checks. Record exact commands and results in the deliverable.
12. Review the diff for scope creep. Remove unrelated cleanup, dependency changes, formatting churn, or behavior changes not required by P0.6.

**注意事项**:
- Keep changes scoped to P0.6 only.
- Preserve existing behavior except where P0.6 requires stabilized codes/messages/redaction.
- Prefer existing project patterns, helpers, serializers, status-code mapping, and UI error components.
- Keep the public error contract deterministic: the same failure category should produce the same stable code across CLI/API/Web UI/events.
- Use redaction defensively at every public boundary, not only at provider adapters.
- If an existing error already has a user-facing message, keep its intent and make only the minimal changes needed for stable code/message taxonomy.
- If a required code is not currently reachable from a known path, still add the canonical class/message and a narrow unit test for construction/serialization.
- Do not add new dependencies.

### Risks
- Existing code may have multiple ad hoc error representations; centralize only enough to satisfy P0.6 without creating a broad rewrite.
- Some failures may already be tested through mocks or fixtures. Avoid changing those assets just to match implementation changes unless the fixture is directly asserting the new P0.6 contract.
- Web UI and events may consume serialized errors differently from CLI/API; verify each boundary independently rather than assuming a shared serializer covers all surfaces.
- Redaction must not hide the stable code or the actionable human message.

### Evidence
- Planning-only phase; no commands executed and no implementation files inspected or changed.
- This handoff is constrained to `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/plan-120.md`.

## Next-Action
Implement P0.6 exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Keep the diff focused, add/adjust tests for common failures and redacted provider detail, run the relevant verification commands, and write the execution handoff to `wiki/projects/flow/outputs/deliverable-120.md`.

## Acceptance-Criteria
- [ ] The P0.6 section of `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` has been read and followed.
- [ ] Stable classes or equivalent typed constructors exist for all required codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, and `verdict_failed`.
- [ ] Each required code has a deterministic, human-readable default message.
- [ ] CLI failures expose stable codes and readable messages while preserving existing exit behavior.
- [ ] API failures expose stable `code` and `message` fields while preserving existing status semantics.
- [ ] Web UI failures render readable messages derived from the stable taxonomy without unrelated UI redesign.
- [ ] Event emission/logging uses stable codes/messages for the required failure and reconciliation categories.
- [ ] Provider/internal details are redacted from public CLI/API/Web UI/event output, including tokens, auth headers, API keys, raw provider secret strings, and secret-looking values.
- [ ] Focused tests cover common failures and at least one redacted provider-detail path at the relevant public boundary.
- [ ] No new dependencies are added.
- [ ] Existing behavior outside the P0.6 error contract is preserved.
- [ ] All relevant lint, typecheck, and test commands pass, and exact command output is recorded in `deliverable-120.md`.
- [ ] The final diff contains no unrelated cleanup, formatting churn, or broad refactor outside P0.6.
