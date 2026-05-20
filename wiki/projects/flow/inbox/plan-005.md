## Handoff: codex -> claude - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement P0.6 stable error classes/messages only

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-005
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.6.
- Add a small stable error catalog rather than scattering hardcoded strings. The catalog must cover exactly: `adapter_missing`, `adapter_auth_failed`, `provider_rate_limited`, `permission_denied`, `secret_blocked`, `delete_blocked`, `worktree_dirty`, `source_path_mismatch`, `lease_stale`, `event_log_corrupt`, `job_reconciled`, `project_lock_busy`, `version_mismatch`, `verdict_failed`.
- Preserve existing wire behavior while adding stable `code` and human-readable `message` fields where the CLI, API, Web UI, and event payloads currently expose raw or inconsistent failures.
- Reuse existing redaction helpers, especially `server/services/secret-policy.js`, so provider details can be useful without leaking tokens, API keys, webhook URLs, or query secrets.
- Keep `job_reconciled` as a non-fatal informational event/status even though it belongs in the same stable code/message catalog.

### Rejected
- Broad cleanup of readiness, hub, runtime, or Web UI flows | P0.6 is a promotion-readiness must-have slice and must remain scoped.
- Changing fake/mock responders or fixtures just to make tests pass | existing behavior must be preserved; adjust tests only where they assert the new stable contract.
- Adding a dependency for typed errors, localization, or schema validation | the requirement can be met with local catalog/classes and existing test tools.
- Surfacing raw provider errors in CLI/API/UI/events | redacted provider detail is explicitly required.

### Files
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth; confirm the P0.6 wording before editing.
- `server/services/error-catalog.js` - add the stable code catalog, human messages, base `FlowError`, named subclasses, response/event serialization helpers, and provider-detail redaction helper.
- `server/services/readiness-checks.js` - emit catalog-backed codes/messages for adapter/provider/readiness failures and ensure `formatReadinessHuman` and `formatReadinessJson` surface the stable message.
- `server/services/secret-policy.js` - make secret-blocked events include `code: "secret_blocked"` and the catalog message while preserving existing `messageKey`, `artifact`, `reason`, and timestamp fields.
- `server/services/event-store.js` - map corrupt event log handling to `event_log_corrupt` responses/events without changing repair behavior.
- `server/services/runtime-cli.js` - normalize runtime command failures such as corrupt event logs, lock contention, stale leases, version mismatches, and queue reconciliation into catalog-backed errors/messages.
- `server/routes/hub.js` - return API failures with stable `error.code` and `error.message` for permission, deletion, source-path, lock, version, rate-limit, and adapter/provider failures.
- `server/services/observability.js` - include stable code/message summaries for provider backoff/rate-limit and redacted diagnostic detail.
- `runtime/cpb-runtime/src/lib.rs` - align runtime JSON/event output for `lease_stale`, `event_log_corrupt`, `project_lock_busy`, `version_mismatch`, and `job_reconciled` with the same stable codes/messages.
- `web/src/components/PipelineStatus.jsx` - display stable human-readable messages for event/status codes without exposing raw provider detail.
- `web/src/components/PipelineStatus.test.jsx` - extend existing component coverage for known stable codes and unknown-code fallback.
- `web/src/pages/Dashboard.test.jsx` - add/adjust Web UI coverage for provider rate-limit/redacted provider details when dashboard data includes stable errors.
- `server/services/error-catalog.test.js` - add unit tests for the full code list, class serialization, messages, and redaction.
- `server/services/readiness-checks.test.js` - add focused tests for adapter missing/auth failed/provider rate-limit output if this repository's Node test runner picks up service tests.
- `server/services/secret-policy.test.js` - add focused tests for `secret_blocked` event shape and redaction if this repository's Node test runner picks up service tests.
- `server/services/event-store.test.js` - add focused tests for `event_log_corrupt` mapping if this repository's Node test runner picks up service tests.

### Evidence
- Planning phase only: no terminal commands were executed.
- Non-terminal code-intel lookup found current root entry points: `server/services/readiness-checks.js`, `server/services/runtime-cli.js`, `server/services/observability.js`, `server/services/secret-policy.js`, `server/routes/hub.js`, `runtime/cpb-runtime/src/lib.rs`, `web/src/components/PipelineStatus.jsx`, `web/src/components/PipelineStatus.test.jsx`, and `web/src/pages/Dashboard.test.jsx`.
- The root Web component test files exist; service test filenames listed above should be created only if they match the repository's existing test runner conventions.

### Risks
- The exact promotion-readiness source document was not read in this planning phase because no terminal/file-read command execution was allowed; executor must read it first and stop if P0.6 differs from this handoff.
- Rust runtime and Node/Web catalogs can drift if duplicated. Keep the code/message list mechanically identical and add tests that compare every expected code on each touched surface.
- `job_reconciled` may already be treated as an event rather than an error. Preserve that behavior; add code/message, not failure semantics.
- Some API callers may depend on existing raw `error` strings. Preserve existing fields while adding `error.code`/`error.message`, and only change display text where P0.6 requires human-readable messages.

### Scope

**Goal**: Implement only P0.6 from the promotion readiness plan: stable error classes and human-readable messages across CLI/API/Web UI/events for the required code list, with tests for common failures and redacted provider detail.

**Stable message contract**:
- `adapter_missing`: `Required adapter is not configured or installed.`
- `adapter_auth_failed`: `Adapter authentication failed. Reconnect or update credentials.`
- `provider_rate_limited`: `Provider rate limit reached. Try again after the backoff period.`
- `permission_denied`: `Permission denied for this operation.`
- `secret_blocked`: `Request blocked because it included a secret. Remove credentials from the input.`
- `delete_blocked`: `Delete blocked because the resource is protected or still in use.`
- `worktree_dirty`: `Worktree has uncommitted changes. Commit, stash, or discard them before continuing.`
- `source_path_mismatch`: `Project source path does not match the registered path.`
- `lease_stale`: `The active lease is stale. Retry after reconciliation.`
- `event_log_corrupt`: `Event log is unreadable or corrupt. Repair or restore it before continuing.`
- `job_reconciled`: `Job state was reconciled after an interruption. Refresh before continuing.`
- `project_lock_busy`: `Project is locked by another operation. Try again when it completes.`
- `version_mismatch`: `Client and runtime versions do not match. Refresh or update and try again.`
- `verdict_failed`: `Verification verdict failed. Inspect the evidence and resolve failing checks.`

**Implementation steps**:
1. Read `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and confirm P0.6 is exactly the active slice. Do not implement other P0 items.
2. Add `server/services/error-catalog.js` with `ERROR_CODES`, `ERROR_MESSAGES`, `ERROR_HTTP_STATUS`, `FlowError`, named subclasses for all required codes, `toErrorPayload(error)`, `toEventPayload(code, details)`, `messageForCode(code)`, and `redactProviderDetail(value)`.
3. Wire API responses in `server/routes/hub.js` so common failures return both the existing response shape and `error: { code, message, details }`. Use HTTP status mappings conservatively: auth/permission as 401/403, rate-limit as 429, conflicts/locks/version/source/delete/worktree as 409, corrupt/verdict as 500 unless existing route semantics already choose a narrower status.
4. Wire CLI/readiness output in `server/services/readiness-checks.js` and `server/services/runtime-cli.js`. Human format must print the catalog message; JSON format must include the stable code/message while preserving existing summary/check fields.
5. Wire events in `server/services/secret-policy.js`, `server/services/event-store.js`, and runtime-facing code so event payloads include `code` and `message` for `secret_blocked`, `event_log_corrupt`, `lease_stale`, `job_reconciled`, `project_lock_busy`, and `version_mismatch` without removing existing event fields.
6. Align `runtime/cpb-runtime/src/lib.rs` JSON/event output with the same code list for runtime-owned failures. Keep Rust changes minimal: a local enum/function pair for code/message is enough if there is no existing runtime error abstraction.
7. Update `web/src/components/PipelineStatus.jsx` so known codes display catalog messages and unknown codes fall back to the existing status/phase display. Do not show raw provider detail in the UI.
8. Add/adjust tests for common failures: adapter missing, adapter auth failed, provider rate limited, permission denied, secret blocked, event log corrupt, project lock busy, version mismatch, verdict failed, and unknown-code fallback.
9. Add redaction tests using representative provider detail containing bearer tokens, API keys, webhook URLs, and query secrets. Assert CLI/API/event/UI-facing outputs contain the stable message and redacted detail, never the raw secret.
10. Run the repository's normal verification commands after implementation: server unit tests, Web component tests, Rust runtime tests, lint/typecheck if present, and any promotion-readiness test command named by the source plan.

**Notes**:
- Keep existing behavior and fields unless P0.6 specifically requires code/message additions.
- Do not edit snapshots, fixtures, fake LLM responders, or mock providers unless the executor finds an existing test that already represents the intended real workflow and only needs assertion updates for the new stable code/message.
- Prefer deletion of duplicated inline strings after the catalog is wired, but do not refactor unrelated flows.
- The deliverable should list exact changed files, commands run, and any verification gaps.

## Next-Action
Implement the P0.6 slice exactly as scoped above, run the relevant tests, and write `deliverable-005.md` with changed files, verification evidence, and remaining risks.

## Acceptance-Criteria
- [ ] The executor reads `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` first and confirms only P0.6 is implemented.
- [ ] All 14 required codes exist in the stable catalog with deterministic human-readable messages.
- [ ] Stable classes or typed constructors exist for all 14 codes, including non-fatal `job_reconciled` handling.
- [ ] CLI human output uses the catalog message for covered failures.
- [ ] CLI/JSON output includes stable `code` and `message` for covered failures while preserving existing fields.
- [ ] API failures include stable `error.code` and `error.message` and preserve existing status/response behavior.
- [ ] Web UI displays human-readable messages for known codes and preserves a safe fallback for unknown codes.
- [ ] Event payloads include stable `code` and `message` where P0.6 codes are emitted, without removing existing event fields.
- [ ] Provider detail is redacted in CLI/API/Web UI/events; tests prove raw tokens, API keys, webhook URLs, and query secrets do not appear.
- [ ] Tests cover common failures: adapter missing, adapter auth failed, provider rate limited, permission denied, secret blocked, event log corrupt, project lock busy, version mismatch, verdict failed, and unknown-code fallback.
- [ ] Existing behavior outside P0.6 is preserved; no unrelated cleanup or dependency additions are included.
- [ ] Server tests, Web tests, Rust runtime tests, and any source-plan promotion-readiness verification command pass, or the deliverable records the exact blocker.
