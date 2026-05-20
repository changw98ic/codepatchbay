## Handoff: codex -> claude — Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-086-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth for this task, but implement only P0.1.
- Extend the existing `cpb doctor` / report readiness implementation in place; preserve current text output and existing checks unless they conflict with the P0.1 source-of-truth requirements.
- Add a machine-readable `--json` output path with redacted diagnostic data and stable issue/check identifiers suitable for CI or promotion gates.
- Model readiness as structured checks with statuses such as `pass`, `warn`, `fail`, and `skip`, then render those checks through the existing human report path and the new JSON path.
- Keep changes scoped to readiness diagnostics and tests. Do not refactor unrelated command plumbing, Hub internals, provider logic, registry storage, or worker lifecycle code beyond the minimal seams needed to observe their status.

### Rejected
- Broad cleanup of the doctor/report command stack — rejected because the directive says this is only the P0.1 slice and existing behavior must be preserved.
- Adding new dependencies for process execution, semver parsing, disk inspection, or JSON rendering — rejected unless the repository already uses such utilities; prefer existing helpers and platform APIs.
- Changing fake/mock assets only to make tests pass — rejected by workspace guidance. Update fakes only when the test double itself must represent a new readiness scenario, and document why.
- Making `--json` replace current output — rejected because existing human-facing behavior should remain available and backward compatible.

### Scope

**目标**: Expand `cpb doctor` / report readiness checks for promotion readiness P0.1 only. The command must report environment, adapter, Hub, registry, job/worker/lease, provider backoff, disk, Rust-runtime, and redaction health in both existing human output and new `--json` output, with focused tests for required failure/warning scenarios.

**涉及文件**:
- Existing CLI command entry for `cpb doctor` and report readiness — add/route `--json`, preserve existing flags/output, and call the expanded readiness collector.
- Existing readiness/doctor/report module(s) — add structured checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- Existing Hub/registry/provider/worker status helper module(s), only if already present — expose minimal read-only status methods needed by readiness checks.
- Existing test files for doctor/report CLI behavior — add/adjust tests for `--json` and the P0.1 scenarios.
- Existing fixtures or fakes used by doctor/report tests — adjust only where necessary to represent missing adapter, stale Hub, stale worker, rate limit/backoff, and Rust unavailable states.
- If no single readiness module exists, create one adjacent to the current doctor/report implementation using the project’s existing module style and naming.

**实现步骤**:
1. Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and copy only the P0.1 acceptance requirements into your working notes. Ignore other P0/P1/P2 items unless they directly define P0.1 behavior.
2. Locate the current `cpb doctor` and report readiness code paths and their tests. Identify the existing output contract before editing so current behavior can be preserved.
3. Introduce or extend a structured readiness result shape with:
   - top-level command metadata: command name, generated timestamp, overall status, and version/context fields already available in the project;
   - `checks[]` entries with stable `id`, human label, `status`, concise message, optional redacted details, and optional remediation;
   - `summary` counts by status;
   - no secrets, tokens, credentials, absolute private payloads, or provider request bodies.
4. Add `--json` support to `cpb doctor` and the relevant report readiness path. The JSON output must be valid JSON only, with no human banners, progress text, ANSI color, or logs on stdout. Route diagnostics/logs to the existing stderr/log mechanism if needed.
5. Implement environment checks:
   - Node runtime presence/version;
   - npm presence/version;
   - Git presence/version;
   - disk-space warning using the project’s existing threshold convention if one exists, otherwise a conservative warning threshold with a named constant.
6. Implement ACP adapter checks:
   - adapter binary/package/config presence;
   - adapter version when discoverable;
   - smoke readiness that verifies the adapter can be invoked or initialized without performing destructive work;
   - clear failure for missing adapter and warning/failure for smoke failure according to current doctor severity conventions.
7. Implement conditional Rust runtime checks:
   - run only when Rust-backed runtime/features are enabled by existing config/env/feature flags;
   - report `skip` when Rust is not enabled;
   - report a clear fail/warn when Rust is enabled but unavailable or unusable.
8. Implement Hub and registry checks:
   - Hub liveness/readiness;
   - Hub writability using a non-destructive temporary/probe write through existing safe APIs;
   - registry consistency against the Hub/project registry invariants already used by the app;
   - stale Hub state detection where existing timestamps/heartbeats indicate stale state.
9. Implement operational health checks:
   - stale jobs;
   - stale workers;
   - stale leases;
   - provider backoff/rate-limit state, including surfacing rate-limit/backoff as a warning or fail consistent with promotion-readiness policy.
10. Add redaction at the boundary where details enter readiness output. Cover environment variables, paths/details that may contain tokens, provider keys, auth headers, URLs with credentials/query secrets, and adapter/provider stderr. Prefer an existing redaction helper if present; otherwise add a small local helper in the readiness module and test it through command output.
11. Update human-readable output to include the new checks in the existing style. Do not remove or rename existing checks unless the source-of-truth plan explicitly requires it.
12. Add focused tests:
   - `--json` emits parseable JSON with expected summary/check IDs and no extra stdout text;
   - missing ACP adapter is reported;
   - stale Hub state is reported;
   - stale worker is reported;
   - provider rate limit/backoff is reported;
   - Rust unavailable is reported only when Rust is enabled;
   - redaction removes representative secrets from JSON and human output;
   - existing doctor/report behavior still passes.
13. Run the repository’s relevant test/lint/typecheck commands used for this CLI area. If full-suite verification is too expensive, run targeted tests first, then the standard broader verification available for the project.
14. Write `wiki/projects/flow/outputs/deliverable-086.md` with changed files, simplifications made, test evidence, and remaining risks.

**注意事项**:
- Keep the implementation narrow. Do not implement other promotion-readiness items from the source plan.
- Preserve existing command names, default human output, exit-code behavior, config loading, and fake/test conventions unless the P0.1 requirements require a specific change.
- Do not introduce network calls for smoke checks unless the existing adapter readiness path already does so. Prefer local initialization/version/status probes.
- Do not leak secrets in failure messages, JSON details, snapshots, test names, or logs.
- Make stale thresholds explicit and configurable only if the project already has a configuration pattern for these thresholds.
- For Hub writability, use a reversible probe through existing storage APIs and clean up after it.

## Next-Action
Implement P0.1 exactly as scoped above, starting from the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`. Run the relevant tests and verification commands. When complete, write `wiki/projects/flow/outputs/deliverable-086.md` using the handshake protocol for `claude -> codex`, Phase `execute`.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON only on stdout and includes structured metadata, summary counts, and check entries with stable IDs/statuses/messages.
- [ ] Existing non-JSON `cpb doctor` and report readiness output remains backward compatible except for the addition of the new P0.1 checks.
- [ ] Readiness checks include Node/npm, Git, ACP adapter presence, ACP adapter version when discoverable, ACP adapter smoke readiness, Rust runtime when enabled, Hub liveness, Hub writability, registry consistency, stale jobs, stale workers, stale leases, provider backoff/rate-limit state, disk-space warnings, and redaction.
- [ ] Rust runtime readiness is skipped when Rust support is not enabled and reports unavailable/unusable Rust when Rust support is enabled.
- [ ] Hub writability uses a safe reversible probe and does not leave persistent test artifacts.
- [ ] Registry consistency reports inconsistent or orphaned state without mutating the registry.
- [ ] Stale jobs/workers/leases use existing heartbeat/timestamp semantics where available and expose clear remediation text.
- [ ] Provider backoff/rate-limit state is visible in both JSON and human output without leaking provider secrets.
- [ ] JSON and human output redact representative secrets, including API keys/tokens, auth headers, credentialed URLs, and sensitive adapter/provider stderr.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust enabled but unavailable, `--json` parseability/shape, and redaction.
- [ ] Existing doctor/report tests still pass.
- [ ] No unrelated cleanup, broad refactors, new dependencies, or unrelated behavior changes are included.
- [ ] Deliverable lists changed files, simplifications made, verification evidence, and remaining risks.
