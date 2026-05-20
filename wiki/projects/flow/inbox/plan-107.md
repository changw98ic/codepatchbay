# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-107
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth and implement only P0.1.
- Keep the implementation centered on the existing readiness surface in `server/services/readiness-checks.js`; code-intel shows `runReadinessChecks`, `formatReadinessHuman`, and `formatReadinessJson` already live there.
- Preserve current human output and command behavior unless P0.1 requires an additive field/check; add `--json` as an additive machine-readable output mode.
- Use structured check records with stable ids, categories, `status`, safe `details`, and `remediation`; derive human and JSON output from the same check data.
- Reuse existing helpers where possible: `server/services/hub-registry.js` for registry/worker status, `server/services/hub-runtime.js` for Hub liveness, `server/services/runtime-cli.js` for Rust runtime backend/rate-limit access, and `server/services/diagnostics-bundle.js` for report integration/redaction.
- Redaction is part of the readiness/report contract: no tokens, credentials, auth headers, secret env values, or raw provider payloads in human or JSON output.
- Negative tests are required for missing ACP adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when Rust is enabled.

### Rejected
- Broad cleanup of diagnostics, Hub, registry, worker, or runtime code unrelated to P0.1.
- New dependencies for CLI parsing, semver, disk checks, or redaction; use existing project patterns and built-in Node APIs.
- Snapshot churn or fake/mock edits merely to make tests pass after production behavior changes.
- Implementing later promotion-readiness slices from the source plan.
- Creating a second doctor/report command path instead of wiring the existing `cpb doctor` / `cpb report` entrypoint.

### Scope

**Goal**: Expand `cpb doctor` / `cpb report` readiness coverage for P0.1 with additive `--json` output, complete readiness checks, redacted structured details, and focused regression tests while preserving existing behavior.

**Source-of-truth preflight**:
1. Open `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`.
2. Confirm the P0.1 wording and any status/severity expectations before editing.
3. Do not implement any P0 item except P0.1, and do not start unrelated cleanup.

**Involved files**:
- `server/services/readiness-checks.js` - centralize and complete readiness checks, statuses, details, remediation, redaction, and human/JSON formatting.
- `server/services/diagnostics-bundle.js` - ensure report readiness output consumes the expanded readiness report and remains redacted.
- `server/services/hub-runtime.js` - use existing Hub liveness metadata; only adjust if the readiness check needs a safe liveness/stale signal.
- `server/services/hub-registry.js` - use existing registry and worker status data; only adjust if missing data prevents consistency/stale-worker checks.
- `server/services/runtime-cli.js` - reuse existing Rust backend/rate-limit helpers; only adjust if readiness needs safe unavailable/backoff reporting.
- Existing CLI entrypoint that currently implements `cpb doctor` and `cpb report` - wire `--json` to `formatReadinessJson` without changing existing human defaults. Identify the exact file from the package/bin entrypoint before editing.
- `server/services/readiness-checks.test.js` - add focused service-level tests if no adjacent readiness test already exists.
- Existing CLI/report test file for `cpb doctor` / `cpb report` - add CLI JSON-output coverage where that command is currently tested; if no CLI test exists, add the smallest project-consistent test file for the command parser/entrypoint.

**Implementation steps**:
1. Inspect the P0.1 source plan and current doctor/report command path.
   - Expected output: exact CLI entrypoint identified, current exit-code/output behavior understood, and no unrelated task scope added.

2. Normalize readiness check shape in `server/services/readiness-checks.js`.
   - Expected output: every check returns a consistent object: `id`, `category`, `status` (`ok`, `warn`, `error`, `skipped`), `message`, redacted `details`, and optional `remediation`.
   - Keep existing summary derivation and human grouping behavior unless a P0.1 check requires a new category.

3. Complete toolchain checks.
   - Expected output: Node major/version check, npm version/presence check, and Git version/presence check all appear in human and JSON output.
   - Missing required tools should be `error`; unsupported versions should be `warn` or `error` according to existing behavior/source-plan wording.

4. Complete ACP adapter readiness.
   - Expected output: adapter presence, reported version if available, and a bounded smoke readiness result are included.
   - Smoke check must not perform destructive work or require a real provider call unless an existing safe adapter probe already exists.
   - Missing adapter must produce a stable check id and remediation.

5. Complete Rust runtime check.
   - Expected output: Rust runtime check is `skipped` when Rust runtime is disabled; when enabled, missing/unexecutable runtime binary is reported with a deterministic `error` and remediation.
   - Reuse `shouldUseRustRuntime`, `resolveRuntimeBin`, or existing runtime backend helpers instead of duplicating path resolution.

6. Complete Hub checks.
   - Expected output: Hub liveness detects missing/stale/dead metadata and reports age/pid/runtime health safely.
   - Expected output: Hub writability verifies the Hub root can accept writes without leaving persistent artifacts.
   - Stale Hub test must be deterministic using temp Hub metadata and injectable clock/time if needed.

7. Complete registry consistency.
   - Expected output: invalid registry shape, duplicate project ids/source paths, missing project roots, and mismatched canonical paths are surfaced as warning/error checks without mutating registry data.
   - Preserve existing `loadRegistry`/normalization semantics; readiness should observe and report, not repair.

8. Complete stale jobs/workers/leases checks.
   - Expected output: stale jobs, stale workers, and orphan/stale leases are reported with counts and safe ids.
   - Do not delete, renew, or repair stale records from doctor/report.
   - Use existing TTL constants where already present; otherwise define a local readiness threshold with a clear name and tests.

9. Complete provider backoff/rate-limit check.
   - Expected output: active provider backoff/rate-limit state is reported as `warn` with provider name, safe reason/code, and expiry timestamp.
   - Expired or absent backoff is `ok`; raw provider errors and credentials are redacted.

10. Complete disk-space warning.
    - Expected output: Hub/project relevant filesystem has available-byte details and warns below the existing threshold.
    - If the platform cannot provide available space, report `skipped` or `warn` according to existing style; do not fail doctor on unsupported statfs alone.

11. Add `--json` output wiring.
    - Expected output: `cpb doctor --json` and the report command's JSON mode emit parseable JSON only on stdout, with no ANSI/color/human prose in JSON mode.
    - JSON schema must include at least `command`, `generatedAt`, `summary`, and `checks`.
    - Preserve existing no-flag human output.

12. Apply redaction consistently.
    - Expected output: all readiness details and diagnostics/report output pass through a single redaction path or shared redaction helper.
    - Add tests proving token-like env values, auth headers, provider credentials, and raw secret strings do not appear in human or JSON output.

13. Add/adjust tests.
    - Required scenarios: missing adapter, stale Hub, stale worker, active rate limit/provider backoff, Rust unavailable when Rust runtime is enabled.
    - Also cover `--json` parseability, JSON schema stability, and redaction.
    - Prefer dependency injection/temp directories over modifying broad mocks or fixtures.

14. Run verification and write deliverable.
    - Expected output: focused tests pass, relevant lint/typecheck/build checks pass if present, and `deliverable-107.md` lists files changed plus exact command evidence.

**Notes and constraints**:
- Keep changes small and additive.
- Do not repair Hub/registry/job/lease state from doctor/report; readiness reports only.
- Do not broaden into dashboard UI, unrelated diagnostics cleanup, worker scheduling behavior, provider execution behavior, or promotion readiness items beyond P0.1.
- If existing CLI exit-code behavior is already defined, preserve it. If undefined, use the minimal existing convention in the command file; avoid inventing a new global policy.
- Use stable check ids so future tests and automation can rely on them. Suggested ids: `toolchain.node`, `toolchain.npm`, `toolchain.git`, `acp.adapter`, `runtime.rust`, `hub.liveness`, `hub.writability`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.orphan`, `provider.backoff`, `disk.space`.

### Evidence
- Planning phase did not run terminal commands per constraint.
- Read-only code-intel found `server/services/readiness-checks.js` with `runReadinessChecks`, `formatReadinessHuman`, `formatReadinessJson`, and existing check categories for toolchain, disk, acp, runtime, hub, registry, jobs, workers, leases, and provider.
- Read-only code-intel found supporting services: `server/services/hub-registry.js`, `server/services/hub-runtime.js`, `server/services/runtime-cli.js`, and `server/services/diagnostics-bundle.js`.

### Risks
- The exact CLI entrypoint for `cpb doctor` / `cpb report` was not identified from symbol search; identify it from the package/bin entrypoint before editing and wire existing commands rather than adding a parallel path.
- Existing readiness code may already cover part of P0.1; implementation should fill gaps and tests, not rewrite working checks.
- Rust runtime severity may be specified in the source plan or existing behavior; confirm before deciding `warn` vs `error` when enabled and unavailable.

### Self-Review
- Covers every requested P0.1 topic: `--json`, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk warnings, redaction, and required negative tests.
- Scope is limited to doctor/report readiness and tests.
- No unrelated cleanup, dependency addition, dashboard/UI work, or later readiness slice is included.

## Next-Action
Implement the P0.1 readiness expansion exactly as scoped above, run focused and relevant full verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-107.md` with changed files, test evidence, and any residual risks.

## Acceptance-Criteria
- [ ] `cpb doctor` retains existing human-readable behavior and includes the expanded readiness checks.
- [ ] `cpb doctor --json` emits parseable JSON with `command`, `generatedAt`, `summary`, and `checks`, and contains no ANSI output or human prose outside JSON.
- [ ] `cpb report` readiness output uses the same expanded check data and supports the relevant JSON/report mode without duplicating readiness logic.
- [ ] Readiness checks cover Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit, and disk-space warnings.
- [ ] Missing adapter is tested and produces a deterministic non-ok readiness check with remediation.
- [ ] Stale Hub is tested and produces a deterministic non-ok readiness check with safe details.
- [ ] Stale worker is tested and produces a deterministic non-ok readiness check with safe worker identifiers/counts.
- [ ] Active provider rate limit/backoff is tested and produces a warning with safe provider/backoff details.
- [ ] Rust runtime unavailable while Rust runtime is enabled is tested and produces a deterministic error or source-plan-compatible non-ok status.
- [ ] Human and JSON outputs redact secrets, tokens, auth headers, provider credentials, and raw secret-like values.
- [ ] Readiness checks do not mutate registry, jobs, workers, leases, or Hub state except for a temporary writability probe that is cleaned up.
- [ ] Existing behavior outside doctor/report readiness is preserved.
- [ ] Relevant tests, lint/typecheck/build checks available in the project pass, with exact commands and outputs recorded in `deliverable-107.md`.
