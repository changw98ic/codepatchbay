# Plan 056 — P0.1: expand cpb doctor/report readiness checks from the 2026-05-18 promotion readiness must-haves plan

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-056 / P0.1 — Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include `--json` output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation contract and implement only P0.1.
- Expand the existing `cpb doctor` and `cpb report` readiness surface instead of creating a parallel readiness command.
- Add machine-readable `--json` output that uses the same underlying readiness checks as the human-readable output.
- Model each readiness item as a structured check result with stable identifiers, severity, status, message, evidence, and remediation fields so doctor/report can share data and tests can assert behavior without scraping text.
- Preserve existing human-readable behavior and exit-code semantics unless the source-of-truth plan explicitly requires a stricter readiness failure.
- Redact secrets before any doctor/report output is rendered or serialized, including provider keys, tokens, authorization headers, Hub paths containing credentials, environment dumps, command output, and error messages.
- Add or adjust tests for the P0.1 required scenarios: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broad CLI cleanup or command reorganization — outside the P0.1 slice and risks changing unrelated behavior.
- A JSON-only rewrite of doctor/report — would break existing human-readable workflows.
- Live network calls to external providers in readiness tests — use fakes/stubs for deterministic backoff and redaction coverage.
- Updating fake/mock tests merely to hide production regressions — only adjust tests to represent the intended P0.1 readiness contract.

### Scope

**目标**: Expand `cpb doctor` and `cpb report` readiness checks for promotion readiness P0.1, preserving existing behavior while adding structured `--json` output, required runtime/environment checks, stale-state detection, provider backoff reporting, disk-space warnings, redaction, and focused regression tests.

**Source of truth**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read first and keep implementation limited to P0.1.

**涉及文件**:
- Existing `cpb doctor` CLI command implementation — add shared readiness checks and `--json` rendering.
- Existing `cpb report` CLI command implementation — expose the same readiness data in report output and support/propagate JSON where the existing CLI shape allows.
- Existing readiness, health, Hub, registry, provider, worker, lease, ACP adapter, or runtime helper modules — extend in place; create a small focused helper only if no shared readiness module exists.
- Existing CLI tests for doctor/report — add regression coverage for JSON shape, redaction, missing adapter, stale Hub, stale worker, provider backoff/rate limit, and Rust unavailable.
- Existing fixtures/fakes for Hub, workers, leases, providers, ACP adapter, and Rust runtime — reuse or minimally extend only where needed for the new readiness scenarios.

**实现步骤**:
1. Read the P0.1 section of `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and list the exact required doctor/report checks before editing code. Do not implement any P1/P2 or unrelated cleanup items.
2. Locate the existing `cpb doctor` and `cpb report` command paths, their current tests, and any shared health/readiness helpers. Record the current output and exit-code behavior from tests so it can be preserved.
3. Introduce or extend a shared readiness result shape used by both commands:
   - `id`: stable check id such as `node`, `npm`, `git`, `acp_adapter`, `hub_liveness`, `hub_writability`, `registry_consistency`, `stale_jobs`, `stale_workers`, `stale_leases`, `provider_backoff`, `disk_space`, `rust_runtime`.
   - `status`: `ok`, `warn`, `fail`, or `skip`.
   - `severity`: `info`, `warning`, or `error`.
   - `message`: concise human-readable summary.
   - `evidence`: non-secret details such as versions, paths, counts, ages, thresholds, and runtime-enabled state.
   - `remediation`: concrete next action when status is `warn` or `fail`.
4. Implement Node/npm readiness:
   - Detect Node and npm availability and versions using the project’s existing process/runtime helpers.
   - Report missing executables or unsupported versions as readiness failures or warnings according to the source-of-truth plan and existing CLI conventions.
   - Include versions in JSON evidence when available.
5. Implement Git readiness:
   - Detect Git availability and usable repository state needed by CPB.
   - Report missing Git, inaccessible repository metadata, or unusable worktree state according to existing doctor/report semantics.
   - Do not change unrelated Git workflow behavior.
6. Implement ACP adapter readiness:
   - Check adapter presence on the configured path or package resolution path.
   - Read adapter version when available.
   - Run the smallest existing smoke/readiness probe for adapter startup or handshake without invoking destructive operations.
   - Surface missing adapter, version mismatch, smoke failure, and smoke timeout distinctly in JSON and human output.
7. Implement Rust runtime readiness only when Rust runtime is enabled:
   - Detect the existing config/env flag that enables Rust runtime.
   - When disabled, emit `skip` or omit the Rust check only if that matches existing readiness style.
   - When enabled, check binary/runtime availability and report unavailable Rust runtime with remediation.
8. Implement Hub liveness and writability readiness:
   - Check that the configured Hub is reachable using existing local Hub APIs/helpers.
   - Check writable state with a non-destructive or temporary write probe that is cleaned up through existing Hub mechanisms.
   - Report stale or unreachable Hub state separately from unwritable state.
9. Implement registry consistency readiness:
   - Validate registry entries against Hub/project state using existing registry read APIs.
   - Detect missing project entries, orphaned entries, duplicate ids, invalid paths, and stale metadata that the P0.1 source plan identifies.
   - Keep checks read-only unless the existing doctor command already has an explicit repair mode.
10. Implement stale jobs, workers, and leases readiness:
    - Use existing job/worker/lease stores and age/heartbeat fields.
    - Apply thresholds from the source-of-truth plan or existing constants; if the plan does not specify a threshold, reuse the closest existing stale-state threshold rather than inventing a new policy.
    - Report counts, oldest age, and representative ids after redaction.
11. Implement provider backoff and rate-limit readiness:
    - Inspect provider state using existing provider/backoff tracking.
    - Report active backoff, rate-limit cooldown, retry-after, and affected provider names without exposing tokens or request payloads.
    - Ensure rate-limit/backoff is at least a warning and becomes failure only if the source-of-truth plan requires promotion blocking behavior.
12. Implement disk-space warnings:
    - Check free space for the project path, Hub path, and any configured runtime/cache path already used by CPB.
    - Use thresholds from the source-of-truth plan or existing config/constants.
    - Report warnings before write failures occur; include available bytes and threshold in JSON evidence.
13. Add centralized redaction:
    - Reuse an existing redaction utility if one exists.
    - Apply redaction before human rendering, JSON serialization, logs emitted by doctor/report, and captured smoke errors.
    - Cover common secret forms: API keys, bearer tokens, authorization headers, provider env vars, credentialed URLs, and file paths containing embedded credentials.
14. Add `--json` output:
    - For `cpb doctor --json`, emit valid JSON only, with no banners, progress spinners, ANSI color, or extra stderr noise unless it is already part of fatal CLI behavior.
    - Include command metadata, timestamp, overall status, check results, and summary counts.
    - For `cpb report`, integrate readiness into the existing report format and add/propagate JSON output if the command already has or is expected to gain `--json` under P0.1.
    - Ensure human-readable output remains readable and backward-compatible for existing tests/users.
15. Update tests with focused fixtures:
    - Missing adapter: doctor/report shows ACP adapter failure and JSON contains `acp_adapter` with failure status and remediation.
    - Stale Hub: stale or unreachable Hub is reported distinctly from unwritable Hub.
    - Stale worker: stale worker heartbeat is detected with count/age evidence.
    - Rate limit: active provider backoff/rate-limit is reported without leaking provider secrets.
    - Rust unavailable: when Rust runtime is enabled and binary/runtime is absent, readiness reports the required warning/failure; when disabled, behavior is skip/omission per existing style.
    - Redaction: JSON and human output contain redacted values and do not contain raw tokens, API keys, bearer headers, or credentialed URLs.
16. Run the smallest relevant test set first, then the project’s standard lint/typecheck/test commands if available. If any command is unavailable or too broad for the handoff environment, document that explicitly in `deliverable-056.md`.
17. Self-review the diff before handoff:
    - Confirm only P0.1 readiness files/tests changed.
    - Confirm existing doctor/report behavior is preserved outside the new readiness checks.
    - Confirm no new dependencies were added.
    - Confirm output is deterministic enough for tests.

**注意事项**:
- Keep the diff scoped; do not broaden into P0.2, P1, cleanup, UX polish, unrelated registry repairs, or command restructuring.
- Prefer existing helpers for process execution, config loading, Hub access, registry reads, provider state, and redaction.
- Do not add new dependencies.
- Do not perform destructive repair actions from readiness checks.
- Avoid tests that depend on the developer machine’s real Node/npm/Git/Rust/Hub state; use fakes, temp directories, injected paths, or existing test harness helpers.
- JSON output must be parseable and stable; tests should parse JSON and assert keys/statuses, not string-match full pretty output.
- Redaction is mandatory for both success and failure paths.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, using `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. After implementation and verification, write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-056.md` with changed files, test evidence, remaining risks, and any source-plan interpretation notes.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with no non-JSON stdout decorations and includes metadata, overall status, summary counts, and structured readiness checks.
- [ ] `cpb doctor` human-readable output still works and preserves existing behavior except for the new P0.1 readiness information.
- [ ] `cpb report` includes the same P0.1 readiness data through the existing report path, with JSON support where required by the command’s existing/P0.1 contract.
- [ ] Readiness checks cover Node/npm availability/version, Git availability, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is reported as a readiness problem with a stable check id, remediation, human output, and JSON output.
- [ ] Stale or unreachable Hub is reported distinctly from Hub unwritable state.
- [ ] Stale worker state is detected and includes safe count/age evidence.
- [ ] Provider rate-limit/backoff is reported without leaking provider secrets.
- [ ] Rust unavailable is reported when Rust runtime is enabled and skipped or omitted when Rust runtime is disabled according to existing readiness style.
- [ ] Registry consistency check reports inconsistent/missing/orphaned registry state without mutating registry data.
- [ ] Disk-space check reports warnings using the plan-defined or existing threshold.
- [ ] All doctor/report outputs redact tokens, API keys, bearer headers, credentialed URLs, secret env values, and sensitive smoke-error details.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust unavailable, JSON parseability, and redaction.
- [ ] No unrelated cleanup, broad refactor, new dependency, fixture churn, or behavior change outside P0.1 readiness is included.
- [ ] Relevant tests pass, and any unrun verification is documented honestly in `deliverable-056.md`.
