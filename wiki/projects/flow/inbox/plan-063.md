## Handoff: codex -> claude

# Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-063
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling requirements document; implement only its P0.1 doctor/report readiness slice.
- Keep the readiness expansion inside the existing `cpb doctor` / report surfaces and their established helpers rather than creating a separate health-check command.
- Add `--json` output as a structured equivalent of the existing human-readable readiness report, preserving current text output behavior by default.
- Model readiness checks as explicit check results with stable ids, severity/status, redacted details, and remediation hints so text and JSON renderers share one source of truth.
- Include checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime only when Rust execution is enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit state, and disk-space warnings.
- Ensure all command output and JSON payloads redact secrets, tokens, API keys, home-directory-sensitive paths where the existing redaction policy requires it, and provider payload details that could leak credentials.
- Add or adjust focused regression tests for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust unavailable when Rust runtime is enabled.

### Rejected
- Broadening into unrelated promotion-readiness items beyond P0.1; this would violate the requested P0 slice.
- Rewriting doctor/report architecture wholesale; prefer extending the current readiness-check pipeline with minimal, reviewable changes.
- Making Rust runtime absence a universal failure; it should only warn/fail when Rust runtime support is configured/enabled.
- Returning raw exception objects or process environments in JSON; that risks leaking secrets and makes the output unstable.
- Updating fake/mock responders just to force tests green after production changes; adjust test doubles only when they directly model the new doctor/report checks.

### Scope

**目标**: Expand `cpb doctor` / report readiness coverage for the P0.1 promotion-readiness slice, including human and JSON output, while preserving existing behavior and keeping the diff limited to readiness checks, rendering, and related tests.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — Source-of-truth requirements to read before implementation; do not edit.
- Existing `cpb doctor` command/module files — Locate the current CLI entrypoint, option parsing, and human report rendering; add `--json` without changing default output.
- Existing doctor/report readiness-check modules — Add or extend checks for Node/npm, Git, ACP adapter, Rust runtime, Hub, registry, stale jobs/workers/leases, provider backoff, disk space, and redaction.
- Existing Hub/registry/job/worker/lease state modules — Reuse current APIs to inspect liveness, writability, consistency, and stale state; do not introduce a parallel state reader if a project helper exists.
- Existing provider/backoff/rate-limit modules — Reuse existing backoff state where available so doctor reports real readiness rather than synthetic status.
- Existing config/runtime capability modules — Reuse current flags to decide whether Rust runtime is enabled before reporting Rust unavailable.
- Existing redaction/sanitization utilities — Reuse and extend narrowly if necessary so all readiness messages and JSON details pass through the same sanitizer.
- Existing doctor/report tests — Add focused tests for the required failure and warning cases.
- Existing CLI snapshot/golden tests, if present — Update only for intentional output changes and keep current non-JSON text compatibility intact.

**实现步骤**:
1. Read the promotion readiness plan and identify only the P0.1 acceptance details that apply to `cpb doctor` / report readiness. Capture any exact terminology or severity expectations in code comments only if the existing project style supports that.
2. Map the current doctor/report implementation: CLI option parsing, check execution, status aggregation, human rendering, JSON/report rendering if any, redaction utilities, and test fixtures. Keep this mapping local to guide edits; do not create extra documentation unless the repo already expects it.
3. Define or extend a shared readiness check result shape with stable fields such as `id`, `label`, `status`, `severity`, `summary`, `details`, `remediation`, and optional machine-readable metadata. Use existing result types if present.
4. Add `--json` to `cpb doctor` so it emits a deterministic JSON payload containing the same check results and overall status as the text report. Preserve default text behavior and exit-code semantics unless the existing tests or source-of-truth plan explicitly require a change.
5. Implement environment/toolchain checks:
   - Node presence and version.
   - npm presence and version.
   - Git presence and version.
   - Disk-space warning using existing filesystem/path helpers and a conservative threshold from the current project config or source-of-truth plan.
6. Implement ACP adapter readiness:
   - Detect adapter presence through the existing configured adapter path/package/command mechanism.
   - Report adapter version when available.
   - Add a low-cost smoke-readiness probe that confirms the adapter can be resolved or invoked in the same way the product already expects.
   - Treat missing adapter as a clear readiness failure with remediation.
7. Implement Rust runtime readiness only when Rust execution is enabled:
   - Use existing config/capability detection to determine whether Rust runtime applies.
   - When enabled, verify required runtime/tool availability and report unavailable Rust as the required warning/failure.
   - When disabled, omit the check or mark it skipped according to existing doctor conventions.
8. Implement Hub readiness:
   - Check Hub liveness using the existing Hub client/health path.
   - Check Hub writability through the least invasive existing write/probe mechanism; avoid mutating durable state unless the current Hub already has a probe API.
   - Detect stale Hub state as required by the tests and report actionable remediation.
9. Implement registry consistency:
   - Reuse registry loading/validation APIs to detect malformed, missing, duplicate, or mismatched entries.
   - Include project/adapter/provider identifiers only after redaction/sanitization.
10. Implement stale lifecycle checks:
   - Inspect jobs, workers, and leases through existing state stores.
   - Flag stale jobs/workers/leases using existing TTL/staleness constants where available; otherwise add narrowly scoped constants near the readiness check with tests.
   - Include stale worker coverage required by this task.
11. Implement provider backoff/rate-limit readiness:
   - Surface active provider backoff/rate-limit state from the existing provider/backoff store.
   - Report affected provider, retry time/window, and remediation in redacted form.
   - Ensure the required rate-limit test verifies the doctor/report output, not only the low-level backoff helper.
12. Route every human-readable detail and JSON detail through redaction before rendering. Add a targeted test that a representative secret/token/path-like sensitive value does not appear in `--json` output if no such coverage exists.
13. Add or adjust tests in the existing test framework for:
   - Missing ACP adapter.
   - Stale Hub / Hub not live or not writable, matching the project’s state model.
   - Stale worker.
   - Provider rate limit/backoff.
   - Rust unavailable when Rust runtime is enabled.
   - `cpb doctor --json` deterministic schema and redacted payload.
14. Run the project’s relevant unit/integration tests for doctor/report readiness and any CLI tests that cover `cpb doctor`. If failures reveal fixture mismatches, fix production/test setup rather than weakening expected behavior.
15. Self-review the diff for scope creep: no unrelated cleanup, no broad rewrites, no new dependencies, no production behavior changes outside doctor/report readiness and intended tests.

**注意事项**:
- Do not edit `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`; it is source input only.
- Do not broaden into other P0/P1 promotion readiness items.
- Prefer existing CLI, config, Hub, registry, provider, redaction, and test utilities.
- Keep `--json` machine-stable: deterministic ordering, stable check ids, no stack traces, no raw environment dumps, and no unredacted sensitive strings.
- Preserve existing text output and exit-code semantics unless the source-of-truth plan explicitly says otherwise.
- Avoid adding dependencies. Use existing runtime APIs and standard library facilities.
- Keep smoke probes cheap and safe for local developer machines and CI.

## Next-Action
Implement the scoped P0.1 doctor/report readiness expansion exactly as described above, run the relevant tests, and write `deliverable-063.md` with changed files, test evidence, simplifications made, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` preserves existing default human-readable behavior while including the expanded P0.1 readiness checks.
- [ ] `cpb doctor --json` emits deterministic structured JSON with overall readiness status and per-check results using stable ids/status/severity fields.
- [ ] Node and npm presence/version are reported.
- [ ] Git presence/version is reported.
- [ ] ACP adapter presence, version when available, and smoke readiness are reported; missing adapter is covered by a failing readiness test.
- [ ] Rust runtime readiness is checked only when Rust runtime is enabled; Rust unavailable in that mode is covered by a test.
- [ ] Hub liveness and writability are reported; stale Hub behavior is covered by a test.
- [ ] Registry consistency problems are surfaced through the readiness report.
- [ ] Stale jobs, workers, and leases are surfaced; stale worker behavior is covered by a test.
- [ ] Provider backoff/rate-limit readiness is surfaced; active rate limit/backoff behavior is covered by a test.
- [ ] Disk-space warnings are surfaced using existing project thresholds or a narrowly scoped threshold.
- [ ] Text and JSON outputs are redacted; sensitive values do not appear in readiness details.
- [ ] Tests are added or adjusted for missing adapter, stale Hub, stale worker, rate limit/backoff, Rust unavailable, and JSON/redaction behavior.
- [ ] All relevant doctor/report/CLI tests pass.
- [ ] Changes remain scoped to P0.1 readiness behavior and tests, with no unrelated cleanup or new dependencies.
