## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-095-P0.1-cpb-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the authoritative scope source before editing; implement only P0.1 and do not pull in other P0/P1 work.
- Extend the existing `cpb doctor` / `cpb report` readiness path instead of creating a parallel diagnostics command.
- Add machine-readable `--json` output while preserving existing human-readable behavior by default.
- Model readiness checks as structured results with stable IDs, status/severity, user-facing summary, redacted details, and optional remediation text so both text and JSON output share the same data.
- Keep checks non-destructive: they may inspect versions, filesystem state, process/liveness endpoints, registry data, queues, leases, and provider status, but must not mutate Hub state except for an explicitly safe writability probe that creates and removes only its own temporary probe artifact.
- Redact secrets and sensitive local data from both text and JSON output, including tokens, API keys, auth headers, provider credentials, and secret-bearing URLs.

### Rejected
- Rejected implementing unrelated promotion-readiness items from the source plan; the requested slice is only P0.1.
- Rejected changing fake/mock assets merely to force tests green; update tests only when they verify the new readiness behavior or an existing fake is explicitly the subject of a readiness scenario.
- Rejected adding new dependencies for CLI formatting, schema validation, disk probing, or process checks; use existing project utilities and standard runtime APIs.
- Rejected making `--json` a separate command because it would duplicate diagnostic logic and risk drift between human and machine output.

### Scope

**目标**: Expand `cpb doctor` / `cpb report` readiness checks for promotion P0.1 with structured JSON output, broader runtime/environment coverage, redaction, and focused regression tests while preserving existing command behavior.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth; confirm exact P0.1 wording before implementation.
- CLI entrypoint files for `cpb doctor` and `cpb report` — add or wire `--json` support and ensure both commands use the shared readiness result model.
- Existing doctor/report readiness modules — add Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale job/worker/lease, provider backoff, disk-space, and redaction checks.
- Existing Hub/registry/job/worker/lease/provider helper modules — reuse current APIs for liveness, writability, consistency, queue state, leases, and rate-limit/backoff state.
- Existing redaction/sanitization utilities, or the nearest shared logging/reporting utility — centralize masking before text/JSON output.
- Existing test files for CLI doctor/report readiness — add/adjust cases for missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, JSON output, and redaction.
- Test fixtures/fakes only where they already represent the real readiness surfaces being exercised — avoid broad fixture rewrites.

**实现步骤**:
1. Read the P0.1 section in `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and map each required readiness item to the current doctor/report code path. Expected output: a short internal checklist in the implementation notes or deliverable showing every P0.1 bullet is covered.
2. Locate the existing `cpb doctor` and `cpb report` command parsing and output flow. Add `--json` handling in the existing command surface, keeping default text output unchanged. Expected output: both commands can emit the same structured readiness payload as JSON without losing current text behavior.
3. Introduce or extend a shared readiness result type with stable check IDs, status (`ok`, `warn`, `fail`, or equivalent existing vocabulary), severity, summary, details, remediation, and metadata. Expected output: all new checks return data through the shared model before rendering.
4. Add environment checks for Node/npm and Git. Verify executable presence and version when available; report clear warnings/failures when missing or below any project-defined minimum. Expected output: text and JSON both expose Node, npm, and Git readiness status without throwing when tools are unavailable.
5. Add ACP adapter readiness checks. Verify adapter presence, version discoverability, and smoke readiness using the existing adapter resolution path. Missing adapter must produce a deterministic failure, and smoke failures must include redacted diagnostic context. Expected output: missing adapter and adapter-smoke scenarios are testable without invoking real external services.
6. Add Rust runtime readiness only when Rust-backed runtime support is enabled by existing config/env/feature flags. If enabled, detect runtime availability and version/smoke readiness; if disabled, report skipped/neutral according to current diagnostic conventions. Expected output: Rust unavailable is a warning/failure only when Rust is enabled.
7. Add Hub liveness and writability checks. Confirm the Hub is reachable through the current Hub client or local endpoint, then run a safe scoped writability probe using existing storage conventions and cleanup. Expected output: stale/unreachable Hub produces a deterministic readiness issue; writable Hub produces `ok`.
8. Add registry consistency checks. Use the existing registry reader/index APIs to detect corrupt, missing, duplicate, or stale entries relevant to CPB promotion readiness. Expected output: inconsistent registry state is reported without mutating unrelated registry content.
9. Add stale jobs, stale workers, and stale leases checks. Reuse existing job/worker/lease metadata and project-defined TTLs if present; otherwise place TTL constants near the readiness code and document why. Expected output: stale worker and stale lease/job states produce warnings with IDs and redacted identifiers.
10. Add provider backoff/rate-limit readiness. Inspect existing provider state for active rate-limit/backoff windows and report provider name, retry-after/backoff expiry when safe, and remediation. Expected output: active provider backoff appears as a warning/failure and is covered by a rate-limit test.
11. Add disk-space warnings. Check relevant CPB paths, Hub storage paths, temp/cache paths, or the smallest existing set used by doctor/report. Warn when free space is below existing threshold; if no threshold exists, choose a conservative constant and keep it local to diagnostics. Expected output: low disk space does not crash diagnostics and is visible in JSON/text.
12. Apply output redaction at the final rendering boundary and, where practical, before storing details in the result object. Cover secret-like values in environment variables, URLs, tokens, auth headers, adapter/provider metadata, and filesystem paths that include credentials. Expected output: no raw secrets appear in either output mode.
13. Add focused tests. Cover at minimum: missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable when enabled, `--json` schema/parseability, and redaction. Expected output: tests assert observable command output and structured result fields rather than implementation internals.
14. Run the project’s relevant test commands plus any lint/typecheck/static checks normally used for this CLI area. Expected output: deliverable records exact commands and results; if a command cannot run, record why and what narrower verification replaced it.
15. Prepare `deliverable-095.md` for Codex review using the handshake protocol. Include changed files, simplifications or scope controls, test evidence, and any remaining risks.

**注意事项**:
- Keep the diff scoped to readiness diagnostics and tests for P0.1 only.
- Preserve existing command names, defaults, exit-code semantics, and human-readable output unless the source plan explicitly requires a change.
- Do not add dependencies without explicit approval.
- Prefer existing project helpers for command discovery, version parsing, Hub/registry access, provider state, redaction, and filesystem probing.
- Do not mutate persistent project state during diagnostics except for the minimal scoped Hub writability probe, and clean that probe up even on failure.
- Do not broaden into unrelated cleanup, formatting churn, fixture rewrites, or promotion plan items outside P0.1.
- If current tests rely on fakes that no longer represent the real workflow, report the mismatch and add a purpose-built verification path instead of weakening production behavior.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, starting by reading the promotion readiness source plan. Keep changes limited to `cpb doctor` / `cpb report` readiness behavior and tests. After implementation and verification, write `deliverable-095.md` with changed files, evidence, risks, and review instructions.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with a stable readiness result structure and does not print unstructured text to stdout in JSON mode.
- [ ] `cpb report --json` emits valid JSON using the same readiness result model or an explicitly compatible schema.
- [ ] Existing human-readable `cpb doctor` and `cpb report` output remains available and existing behavior is preserved unless P0.1 requires a targeted addition.
- [ ] Readiness checks include Node presence/version, npm presence/version, and Git presence/version.
- [ ] Readiness checks include ACP adapter presence, adapter version discoverability, and smoke readiness.
- [ ] Readiness checks include Rust runtime availability/version/smoke readiness when Rust runtime support is enabled, and do not fail when Rust support is disabled.
- [ ] Readiness checks include Hub liveness and safe Hub writability.
- [ ] Readiness checks include registry consistency.
- [ ] Readiness checks include stale jobs, stale workers, and stale leases.
- [ ] Readiness checks include provider backoff/rate-limit state.
- [ ] Readiness checks include disk-space warnings for relevant CPB/Hub paths.
- [ ] Text and JSON outputs redact secrets, tokens, provider credentials, auth headers, and secret-bearing URLs.
- [ ] Tests cover missing ACP adapter.
- [ ] Tests cover stale Hub.
- [ ] Tests cover stale worker.
- [ ] Tests cover provider rate-limit/backoff.
- [ ] Tests cover Rust unavailable when Rust runtime support is enabled.
- [ ] Tests cover JSON parseability/schema for doctor/report.
- [ ] Tests cover redaction in text and JSON output.
- [ ] All relevant tests, lint/typecheck/static checks for the changed CLI area pass, or any unavailable verification is explicitly documented with a narrower substitute.
- [ ] The final deliverable states changed files, simplifications made, verification evidence, and remaining risks.
