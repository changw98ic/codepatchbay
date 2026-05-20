## Handoff: codex -> claude

# Plan 057: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; implement only P0.1 expanded `cpb doctor/report` readiness checks

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-057
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the controlling product scope, but implement only P0.1.
- Expand the existing `cpb doctor` / report readiness surface instead of introducing a separate readiness command.
- Preserve existing human-readable output and add machine-readable `--json` output as an additive interface.
- Model readiness as structured checks with severity, status, stable check IDs, human messages, optional remediation hints, and redacted evidence.
- Keep redaction central so `--json`, text output, logs, and tests do not leak tokens, API keys, bearer values, private paths beyond what existing output already exposes, or provider credentials.
- Prefer dependency injection or small probe abstractions for tests so missing adapters, stale Hub state, provider rate limits, and Rust unavailability are deterministic without changing real fakes merely to force tests green.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — out of scope for this handoff.
- Unrelated cleanup, command rewrites, or new dependencies — violates the scoped P0 slice and risks behavior drift.
- JSON output produced by scraping text output — brittle and likely to break redaction/status semantics.
- Tests that only snapshot full terminal output — too weak for readiness behavior; assert structured check IDs/statuses instead.
- Failing hard on optional Rust runtime when Rust support is disabled — readiness should reflect configuration, not require unavailable optional paths.

### Scope

**目标**: Implement P0.1 only: expand `cpb doctor/report` readiness checks to cover `--json`, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, disk-space warnings, redaction, and regression tests for missing adapter, stale Hub, stale worker, rate limit, and Rust unavailable.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; source of truth for P0.1 scope.
- Existing `cpb doctor` command module under the CLI source tree — add readiness checks and `--json` output while preserving existing text behavior.
- Existing `cpb report` command module under the CLI source tree — include the same readiness data or delegate to the shared readiness collector used by doctor.
- Existing CLI argument parser/command registration file — add or wire the `--json` flag only where the current command framework expects flags.
- Existing Hub client/runtime module — expose liveness and writability probes if not already available.
- Existing registry module — expose registry consistency checks for configured providers/adapters without mutating registry state.
- Existing ACP adapter discovery/invocation module — add presence, version, and smoke-readiness probes.
- Existing provider/backoff module — expose current backoff/rate-limit readiness state without clearing or retrying provider calls.
- Existing Rust runtime bridge/module — check runtime availability only when Rust support is enabled.
- Existing test files for doctor/report CLI behavior — add focused regression cases.
- New narrowly scoped test helper only if the current test suite lacks an injection point for probes.

**实现步骤**:
1. Read the source-of-truth plan and existing `cpb doctor` / `cpb report` implementation. Record the exact current command behavior before editing so any existing output remains compatible.
2. Introduce a shared readiness result shape in the existing CLI/service layer, using stable IDs such as `node.version`, `npm.version`, `git.version`, `acp.adapter.present`, `acp.adapter.version`, `acp.adapter.smoke`, `rust.runtime.available`, `hub.liveness`, `hub.writable`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, and `disk.free`.
3. Implement probe collection with no broad side effects:
   - Node/npm: check executable/version readiness and report missing or unsupported versions.
   - Git: check executable/version readiness.
   - ACP adapter: check configured adapter presence, version discoverability, and a lightweight smoke-readiness path that does not start long-running work.
   - Rust runtime: run only when Rust-backed functionality is enabled; report warning/error when enabled but unavailable.
   - Hub: verify liveness and writability with the existing Hub storage/client APIs; avoid destructive writes, or use an existing temp/probe facility with cleanup.
   - Registry: validate configured adapters/providers/jobs against registry entries and report missing, duplicate, or inconsistent references.
   - Stale jobs/workers/leases: detect age-threshold violations using existing timestamps and lifecycle rules; do not mutate or reap state in doctor/report.
   - Provider backoff: surface active rate-limit/backoff state as a readiness warning with retry-after metadata when available.
   - Disk space: warn below the project’s existing or documented free-space threshold.
4. Add a redaction pass applied to every readiness message, remediation, evidence field, JSON payload, and text-rendered detail. Reuse existing redaction utilities if present; otherwise add a small local utility near current diagnostics/reporting code.
5. Add `cpb doctor --json` output. It must emit valid JSON with overall status, generated timestamp, checks array, and redacted details. Non-JSON `cpb doctor` output must remain human-readable and compatible with existing tests.
6. Expand `cpb report` so readiness checks are included in the existing report format. If report already has JSON support, include the structured readiness object there too; if it is text-only, add a clearly delimited readiness section without changing unrelated report sections.
7. Add or adjust tests around structured readiness behavior:
   - Missing ACP adapter reports the adapter presence check as failed and redacts configured paths/secrets as required.
   - Stale Hub state reports Hub liveness or writability failure without throwing an unhandled exception.
   - Stale worker reports `workers.stale` warning/error based on the existing stale threshold.
   - Provider rate-limit/backoff reports `provider.backoff` warning with redacted provider details and retry-after data when available.
   - Rust unavailable reports failure only when Rust runtime is enabled; when disabled, Rust readiness is skipped or informational.
   - `cpb doctor --json` parses as JSON and contains expected stable check IDs and overall status.
8. Run the smallest relevant tests first, then the project’s normal CLI test suite. Fix only failures caused by this P0.1 implementation. Do not update fake/mock responders, snapshots, fixtures, or test doubles merely to mask production behavior drift.
9. Write `deliverable-057.md` with changed files, test evidence, any source-of-truth P0.1 notes, and remaining risks.

**注意事项**:
- Keep changes scoped to P0.1 readiness checks; do not implement unrelated promotion plan items.
- Preserve existing behavior for current `cpb doctor` and `cpb report` users unless the source-of-truth plan explicitly requires an additive field/section.
- Do not add new npm/crate dependencies unless the repository already has an accepted utility for the same purpose unavailable through existing code.
- Do not make readiness probes destructive. Doctor/report may observe and warn; it must not repair, reap, clear backoff, rewrite registries, or mutate leases except for a safe Hub writability probe that is explicitly temporary and cleaned up.
- Treat provider rate-limit/backoff as a readiness warning unless existing command semantics already classify it as fatal.
- If exact stale thresholds are already defined in code/config, reuse them. If absent, add one named constant in the readiness layer and cover it in tests.
- If `report` and `doctor` currently live in different packages, keep shared readiness logic in the lowest existing common CLI/service module rather than duplicating probe behavior.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, run the targeted and normal CLI tests, and write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-057.md` with changed files, evidence, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid JSON with overall status, timestamp, stable readiness check IDs, per-check status/severity/message, redacted details, and no unredacted secrets.
- [ ] Existing non-JSON `cpb doctor` behavior remains compatible except for additive readiness lines/sections.
- [ ] `cpb report` includes the expanded readiness checks through the same collector or an equivalent shared path, without unrelated report changes.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Readiness probes do not repair, reap, clear, or otherwise mutate project/runtime state beyond a safe temporary writability probe with cleanup.
- [ ] Missing ACP adapter test fails the appropriate adapter readiness check and verifies redaction.
- [ ] Stale Hub test reports Hub liveness/writability readiness failure without an unhandled exception.
- [ ] Stale worker test reports the stale worker readiness check using the project’s stale threshold.
- [ ] Provider rate-limit/backoff test reports the provider backoff readiness check with redacted details.
- [ ] Rust unavailable test fails or warns only when Rust runtime support is enabled, and is skipped/informational when disabled.
- [ ] Targeted CLI/readiness tests and the normal relevant test suite pass.
- [ ] Deliverable documents changed files, simplifications made, test evidence, and remaining risks.
