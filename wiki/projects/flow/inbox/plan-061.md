## Handoff: codex -> claude — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.6: add stable error classes and human-readable messages across CLI/API/Web UI/events for adapter_missing, adapter_auth_failed, provider_rate_limited, permission_denied, secret_blocked, delete_blocked, worktree_dirty, source_path_mismatch, lease_stale, event_log_corrupt, job_reconciled, project_lock_busy, version_mismatch, verdict_failed. Add tests for common failures and redacted provider detail.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-061
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only the P0.6 slice.
- Introduce or consolidate stable application error identifiers for exactly these codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Ensure each code has a stable class/category and a human-readable message that can be surfaced consistently by CLI, API responses, Web UI state, and emitted events.
- Provider-originated diagnostic detail must be redacted before it reaches user-visible messages, API payloads, Web UI props/state, events, logs captured by tests, or snapshots.
- Preserve existing behavior outside error typing/message normalization; do not refactor unrelated paths or change fake/mock assets just to satisfy tests.

### Rejected
- Broad cleanup of error handling, adapter plumbing, event serialization, or Web UI rendering outside the P0.6 error set — out of scope for this P0 slice.
- Adding new dependencies for error normalization or redaction — unnecessary for stable codes and messages.
- Encoding provider raw errors directly into user-facing messages — violates the redacted provider detail requirement.
- Updating unrelated snapshots, fixtures, or fake responders to force passing tests — prohibited unless they directly validate this P0.6 contract.

### Scope

**目标**: Implement the P0.6 promotion-readiness error contract: stable error classes/codes plus human-readable, redacted messages across CLI/API/Web UI/events for the exact listed failure conditions.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.6 details and any wording/contract constraints.
- Error definition/normalization module(s) discovered in the codebase, likely under `src/`, `lib/`, `packages/`, or equivalent — add the stable error classes/codes/messages in the existing local pattern.
- CLI error rendering/command handling files — map normalized errors to consistent exit output without leaking provider detail.
- API route/controller/error-response files — serialize stable codes/classes and human-readable messages in response payloads.
- Web UI error display/state files — render the same safe user-facing messages and preserve existing UI behavior.
- Event emission/logging files — include stable error code/class/message fields for relevant events while keeping provider detail redacted.
- Existing tests for CLI/API/Web UI/events plus focused new tests near the changed modules — cover common failures and redacted provider detail.

**实现步骤**:
1. Read the P0.6 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then locate existing error-code, error-class, error-response, and event payload patterns before editing.
2. Inventory current call sites that already produce or surface the fourteen target failures; record which already have stable codes/messages and which need normalization.
3. Add the smallest shared error contract needed by existing architecture: stable code, class/category, safe human-readable message, and optional sanitized metadata. Reuse existing utilities and naming style.
4. Wire the contract into CLI rendering so the common failures produce deterministic, human-readable output with the stable code/class available where the CLI already exposes structured error data.
5. Wire the same contract into API responses so HTTP callers receive the stable code/class and safe message while preserving existing status codes unless the P0.6 source plan explicitly requires a correction.
6. Wire the same contract into Web UI error state/rendering so UI-visible text uses the safe human-readable message and does not expose raw provider detail.
7. Wire the same contract into event emission/reconciliation paths so events for these failures carry stable error identity and redacted message fields.
8. Add or adjust focused tests for representative common failures across CLI/API/Web UI/events, including at minimum `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, and `verdict_failed` if those surfaces exist.
9. Add a redaction regression test that injects provider details resembling tokens, authorization headers, API keys, secrets, or raw provider response bodies and verifies none appear in CLI output, API payloads, Web UI-visible text/state, or event payloads.
10. Run the project’s targeted tests first, then the standard lint/typecheck/test commands documented by the repo. If full verification is too expensive, still run the focused P0.6 test set and record the limitation in the deliverable.
11. Self-review the diff for accidental broad cleanup, unrelated formatting churn, changed fixtures/snapshots, and behavior changes outside the P0.6 error contract.

**注意事项**:
- Keep the implementation scoped to P0.6 and the exact error identifiers listed above.
- Preserve existing status codes, exit codes, event names, and UI flows unless the source readiness plan explicitly says they are incorrect.
- Prefer adding a mapping layer over rewriting adapters, job reconciliation, worktree logic, permissions, or event storage.
- Human-readable messages should be stable enough for tests but not so specific that they reveal raw provider or environment detail.
- If a target error has no reachable current producer, define the stable contract and add tests at the normalization boundary rather than inventing new product behavior.
- Do not edit fake/mock tests, fake LLM responders, snapshots, fixtures, or test doubles merely to make tests pass after production behavior changes.

## Next-Action
Implement the P0.6 error contract according to the steps above, keep the diff scoped, run focused and standard verification, then write `deliverable-061.md` with changed files, evidence, risks, and any verification gaps.

## Acceptance-Criteria
- [ ] The implementation uses `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and does not broaden beyond P0.6.
- [ ] All fourteen target error identifiers are represented by stable error classes/categories and stable codes: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- [ ] CLI output for common failures shows a human-readable safe message and preserves existing command behavior except for the intended stable error presentation.
- [ ] API error responses expose the stable code/class and safe message without leaking raw provider detail.
- [ ] Web UI error display/state uses the safe human-readable messages for the affected failures.
- [ ] Event payloads for affected failures include stable error identity and safe message fields without leaking raw provider detail.
- [ ] Tests cover common failures across the surfaces touched by this change.
- [ ] A regression test proves provider detail is redacted from user/API/UI/event-visible output.
- [ ] No unrelated cleanup, dependency additions, or broad refactors are included.
- [ ] Targeted tests pass, and standard lint/typecheck/test verification is run or explicitly documented if unavailable.
