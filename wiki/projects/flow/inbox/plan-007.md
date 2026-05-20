# Plan 007: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as source of truth; implement only P0.1 cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only its P0.1 slice.
- Keep the implementation centered on the existing readiness service instead of adding a second diagnostics stack.
- Preserve existing human-readable `cpb doctor/report` behavior and add machine-readable `--json` output through the same readiness result model.
- Return structured checks with stable ids, categories, statuses, details, remediation, timestamps, and redacted diagnostic fields.
- Cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- Add focused tests for missing ACP adapter, stale Hub, stale worker, rate-limit/provider backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad cleanup outside P0.1: this task is promotion-readiness must-haves only.
- Replacing existing readiness/report formatting wholesale: preserve current output shape and extend it compatibly.
- Adding new dependencies for command discovery, disk checks, or redaction: use existing Node/runtime helpers and project patterns.
- Editing fake/mock assets only to force green tests: adjust tests only where they assert the intended production behavior for P0.1.

### Scope

**Goal**: Expand `cpb doctor/report` readiness coverage for P0.1 while preserving existing behavior, adding `--json`, redacting sensitive output, and proving the required degraded-state cases with tests.

**Involved files**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` - read-only source of truth for P0.1 requirements.
- `server/services/readiness-checks.js` - primary readiness check model, check implementations, human formatter, JSON formatter.
- `server/services/diagnostics-bundle.js` - report/diagnostics integration point for readiness data and redacted report payloads.
- `server/services/observability.js` - reuse or extend existing diagnostic redaction and worker/provider summary helpers when appropriate.
- `server/services/runtime-cli.js` - use existing Rust runtime enablement/backend helpers for Rust availability checks and Hub/runtime probes.
- `server/routes/hub.js` - ensure Hub report/diagnostics endpoints surface the expanded readiness report without leaking secrets.
- `server/tests/readiness-checks.test.js` - create if no equivalent readiness test file exists; otherwise extend the existing readiness test file in place.
- `server/tests/diagnostics-bundle.test.js` - create or extend only if `cpb report`/diagnostics integration needs direct coverage beyond the service-level tests.

**Implementation steps**:
1. Read the P0.1 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and copy its exact must-have list into the implementation checklist for the deliverable.
2. Map current readiness behavior in `server/services/readiness-checks.js`: existing check ids, status semantics, category ordering, exit/report summary behavior, and formatter output.
3. Introduce or normalize a stable readiness result shape:
   - `generatedAt`, `summary`, `checks`, and optional `metadata`.
   - Each check has `id`, `category`, `status` (`ok`, `warn`, `error`, `skipped`), `title`, `details`, `remediation`, and redacted diagnostic fields only.
   - Human output continues to group by current categories; JSON output emits the raw structured result.
4. Implement toolchain checks for Node/npm/Git:
   - Capture presence and version.
   - Node below the project minimum is `error`; missing npm or Git is `error`.
   - Include remediation that tells the operator which executable is missing or too old.
5. Implement ACP adapter readiness:
   - Detect configured/default adapter path or package according to existing project conventions.
   - Report presence and version.
   - Run the lightest existing smoke check that does not mutate project state.
   - Missing adapter is `error`; smoke failure is `error`; unavailable version is at least `warn` unless the adapter cannot run.
6. Implement Rust runtime readiness:
   - Use `shouldUseRustRuntime`/runtime backend conventions from `server/services/runtime-cli.js`.
   - If Rust runtime is disabled, return `skipped`.
   - If enabled and binary/backend is unavailable or cannot answer a lightweight probe, return `error` with remediation.
7. Implement Hub readiness:
   - Liveness: verify Hub state/root can be reached using existing local Hub helpers and identify stale Hub heartbeat/socket/state as `warn` or `error` based on current semantics.
   - Writability: write and remove a temporary probe file in the Hub-owned writable area; failure is `error`.
   - Do not leave probe files behind.
8. Implement registry consistency:
   - Use existing registry list/get helpers to detect unreadable registry, duplicate ids, missing required project fields, nonexistent project roots, and enabled projects with invalid state.
   - Report inconsistency as `warn` unless it prevents Hub/report operation, then `error`.
9. Implement stale work detection:
   - Stale jobs: jobs not terminal and older than the existing TTL/heartbeat expectation.
   - Stale workers: workers whose `lastSeenAt` exceeds the current worker TTL.
   - Stale leases: leases whose expiry/owner no longer matches active jobs/workers.
   - Include counts and short redacted identifiers, not full sensitive paths or payloads.
10. Implement provider backoff readiness:
    - Read current provider rate-limit/backoff state from existing runtime/observability sources.
    - Active provider backoff or rate limit is `warn` with `until` and reason if available.
    - Ensure this is present in both doctor and report JSON.
11. Implement disk-space warnings:
    - Check the relevant CPB root, Hub root, and workspace/cache areas already used by the service.
    - Warn below the existing threshold if present; otherwise choose a conservative constant local to readiness checks.
    - Include available bytes and threshold bytes in JSON.
12. Apply redaction consistently:
    - Reuse `redactDiagnostics`/existing redaction helpers where possible.
    - Redact tokens, API keys, Authorization headers, cookies, provider secrets, home-directory-sensitive env values, and command stderr/stdout that includes secrets.
    - Add a redaction test that proves JSON and human output do not leak representative secret values.
13. Wire `--json`:
    - Add or preserve CLI parsing so `cpb doctor --json` and `cpb report --json` return valid JSON without ANSI color.
    - Human output remains the default.
    - Exit status behavior should remain compatible with current doctor/report conventions.
14. Add focused tests:
    - Missing adapter reports an ACP adapter `error`.
    - Stale Hub reports stale liveness/writability state without crashing.
    - Stale worker reports a worker `warn` with count/details.
    - Active provider rate limit/backoff reports a provider `warn`.
    - Rust runtime enabled but unavailable reports runtime `error`; Rust disabled reports `skipped`.
    - `--json` output parses and contains the required categories/check ids.
    - Redaction removes representative secrets from both formatted outputs.
15. Run the smallest relevant test subset first, then full lint/type/test commands required by the repo before producing the deliverable.
16. Write `wiki/projects/flow/outputs/deliverable-007.md` with changed files, evidence, any deviations from this plan, and known residual risks.

**Notes**:
- Keep the diff scoped to P0.1. Do not broaden into unrelated cleanup, unrelated CLI behavior, unrelated registry repair, or new UX.
- Preserve existing behavior for current passing readiness/report paths; new failures should appear only for newly detected unhealthy states.
- Prefer small pure helper functions in `server/services/readiness-checks.js` over new modules unless the existing code already has a clear extraction point.
- Make tests deterministic by injecting roots, clocks, adapter overrides, runtime flags, and fake Hub state through existing seams or minimal local options.
- If the exact test file paths differ, extend the existing nearest readiness/diagnostics tests and list the actual paths in the deliverable.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Keep changes small, preserve existing behavior, add/adjust tests for the required degraded states, run verification, and then write `wiki/projects/flow/outputs/deliverable-007.md`.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with no ANSI color and includes summary plus structured checks.
- [ ] `cpb report --json` emits valid JSON with the expanded readiness report included.
- [ ] Human-readable doctor/report output remains compatible with existing behavior.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is detected and tested.
- [ ] Stale Hub state is detected and tested.
- [ ] Stale worker state is detected and tested.
- [ ] Active provider rate limit/backoff is detected and tested.
- [ ] Rust runtime enabled but unavailable is detected and tested; disabled Rust runtime is skipped.
- [ ] JSON and human output redact representative secrets.
- [ ] Existing readiness/report behavior is preserved outside the P0.1 additions.
- [ ] Relevant focused tests pass.
- [ ] Full repo-required lint/type/test verification passes or any unavailable command is documented with the blocker.
- [ ] Deliverable lists changed files, verification evidence, and remaining risks.
