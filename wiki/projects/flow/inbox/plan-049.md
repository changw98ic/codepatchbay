# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-049
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative requirements document and implement only the P0.1 doctor/report readiness slice.
- Keep the change inside existing `cpb doctor` / `cpb report` command surfaces and their shared readiness helpers; do not introduce a parallel diagnostic stack.
- Preserve existing human-readable command behavior by default, and add machine-readable `--json` output without changing existing non-JSON exit/status semantics except where P0.1 explicitly requires readiness failures or warnings.
- Use one shared readiness result model for text and JSON output so `doctor` and `report` cannot drift.
- Give every readiness finding a stable code, severity, summary, details, and redacted evidence payload.
- Redact secrets and sensitive values before both human-readable and JSON output. Redaction must cover tokens, API keys, bearer credentials, authorization headers, provider keys, DSNs, and sensitive environment variable values.
- Prefer dependency injection or existing test doubles for readiness checks so tests can simulate missing tools, stale state, rate limits, and unavailable runtimes without relying on the developer machine.

### Rejected
- Implementing any P0.2/P1/P2 readiness items from the promotion plan | this task is explicitly limited to P0.1.
- Broad cleanup or command rewrites | the task requires scoped changes that preserve existing behavior.
- Adding new third-party dependencies for command parsing, JSON formatting, disk checks, or semver parsing | use existing dependencies and standard library/runtime APIs unless the repo already has a local utility.
- Testing by mutating fake responders, fixtures, or snapshots merely to force passing output | tests should represent the intended readiness behavior.
- Duplicating readiness logic separately in `doctor` and `report` | shared checks prevent inconsistent diagnostics.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` promotion-readiness diagnostics for P0.1 only, including `--json` output, required runtime/tooling checks, Hub and registry state checks, provider backoff/rate-limit visibility, disk-space warnings, redaction, and focused regression tests.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; consult before editing and do not modify.
- Existing `cpb doctor` command registration/handler file — add or wire `--json`, keep default output compatible, and route through the shared readiness model.
- Existing `cpb report` command registration/handler file — expose the same readiness result model in report output and honor `--json` if the existing report command has or should share the flag.
- Existing readiness/diagnostics helper modules used by `cpb doctor` and `cpb report` — add the P0.1 checks and redaction at the boundary before rendering.
- Existing Hub state, registry, worker/job/lease, provider, ACP adapter, and Rust-runtime helper modules — reuse public APIs where available; add narrow exported probes only when the command layer cannot currently observe readiness state.
- Existing unit/integration test files for `cpb doctor`, `cpb report`, readiness helpers, Hub state, registry, workers, leases, provider backoff, ACP adapter detection, and Rust runtime gating — add focused cases listed below without rewriting unrelated tests.

**实现步骤**:
1. Read the promotion-readiness plan and mark only P0.1 requirements as in scope. Record any ambiguous P0.1 wording in the deliverable, but do not implement adjacent requirements unless the document explicitly includes them in P0.1.
2. Locate the current `cpb doctor` and `cpb report` command handlers, their renderers, and existing readiness/test helpers. Preserve existing command names, aliases, default text output, and exit-code behavior unless P0.1 already defines a stricter result.
3. Introduce or extend a shared readiness result type with:
   - top-level status such as `ok`, `warning`, or `error`;
   - command/runtime metadata with redacted values;
   - ordered check results with stable `code`, `label`, `severity`, `status`, `summary`, `details`, and optional redacted `evidence`;
   - timestamps/durations only if the project already includes them or they are useful for report output.
4. Add `--json` handling for `cpb doctor` and the readiness portion of `cpb report`. JSON must be deterministic enough for tests: stable key names, stable finding codes, stable ordering, no ANSI color, and no unredacted secrets.
5. Implement runtime/tooling checks:
   - Node presence/version and npm presence/version;
   - Git presence/version;
   - ACP adapter presence, reported version, and smoke-readiness result;
   - Rust runtime availability only when the relevant Rust runtime feature/configuration is enabled, with a warning or error for unavailable Rust according to existing severity conventions.
6. Implement Hub and state checks:
   - Hub liveness;
   - Hub writable storage/path check using the existing Hub storage abstraction where possible;
   - registry consistency check for broken, duplicate, missing, or unreadable registry entries already visible to the project;
   - stale jobs, workers, and leases using existing timeout/TTL semantics rather than inventing new thresholds.
7. Implement provider and capacity checks:
   - provider backoff/rate-limit readiness, including active backoff windows and retry-after evidence where available;
   - disk-space warning for the Hub/state/workspace storage location, using an existing disk-space utility if present and otherwise the narrowest platform-compatible standard approach already used in the repo.
8. Add redaction centrally before rendering and before writing JSON. Include targeted tests proving redaction applies to tokens, provider keys, authorization values, and sensitive environment evidence in both text and JSON output.
9. Add or adjust tests for the required P0.1 scenarios:
   - missing ACP adapter reports a stable non-OK readiness finding;
   - stale Hub or unwritable/dead Hub reports a stable non-OK finding;
   - stale worker reports a stable non-OK finding and does not require deleting worker state;
   - provider rate limit/backoff reports a stable warning/error with redacted evidence;
   - Rust unavailable reports only when Rust runtime is enabled and is absent when Rust runtime is disabled;
   - `--json` output is valid JSON, deterministic, and contains the same finding codes as text/report readiness;
   - existing passing doctor/report behavior still passes for the healthy path.
10. Run the repo’s normal lint/typecheck/test commands for the touched package(s). If the full suite is too expensive, run the smallest command set that covers CLI command parsing, readiness helpers, and the required scenarios, then record exactly what was and was not run in the deliverable.

**注意事项**:
- Do not modify files outside the P0.1 doctor/report readiness path except for narrowly required tests.
- Do not change fake/mock tests or fixtures only to match new output. Update them only when the fake/test double is the intended subject of the test or when adding purpose-built readiness scenarios.
- Keep findings additive and compatible: existing consumers of `cpb doctor` / `cpb report` should not break unless they opt into `--json`.
- Keep JSON output redacted by construction. Do not rely on callers to remember to redact.
- Do not introduce unrelated cleanup, formatting churn, snapshot churn, command renames, or dependency upgrades.

## Next-Action
Implement P0.1 exactly as scoped above. First read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then update only the existing `cpb doctor` / `cpb report` readiness implementation and focused tests. After implementation and verification, write `deliverable-049.md` with changed files, evidence, risks, and any intentionally deferred non-P0.1 items.

## Acceptance-Criteria
- [ ] The implementation is limited to P0.1 from `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; no P0.2/P1/P2 work or unrelated cleanup is included.
- [ ] `cpb doctor --json` emits valid, deterministic, machine-readable JSON with stable readiness finding codes and no ANSI formatting.
- [ ] `cpb report` includes the expanded readiness checks and shares the same underlying result model as `cpb doctor`; JSON behavior is consistent with the command’s existing or newly added `--json` surface.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is covered by a test that asserts a stable non-OK finding code and useful redacted diagnostic details.
- [ ] Stale/dead/unwritable Hub state is covered by a test that asserts a stable non-OK finding code.
- [ ] Stale worker state is covered by a test that asserts a stable non-OK finding code without deleting or mutating unrelated state.
- [ ] Provider rate-limit/backoff state is covered by a test that asserts a stable warning/error and redacted evidence.
- [ ] Rust unavailable is covered by tests for both enabled and disabled Rust-runtime configurations.
- [ ] Redaction is tested for human-readable output and JSON output.
- [ ] Existing healthy-path doctor/report behavior remains covered and passing.
- [ ] Normal relevant lint/typecheck/tests pass, or the deliverable clearly records any command that could not be run and why.
- [ ] The final deliverable lists changed files, simplifications made, remaining risks, and verification evidence.
