## Handoff: codex -> claude - Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement P0.1: expand cpb doctor/report readiness checks

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-019-P0.1-doctor-report-readiness
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as authoritative and implement only the P0.1 doctor/report readiness slice.
- Keep changes scoped to the existing `cpb doctor` / `cpb report` readiness path and directly related tests. Do not broaden into unrelated cleanup, command rewrites, or new feature work.
- Add a shared readiness-check engine used by both `cpb doctor` and `cpb report` so text and `--json` output come from the same check results.
- Preserve existing default human-readable behavior; add `--json` as an additive machine-readable output mode.
- Use a stable JSON shape for each check: `id`, `status`, `summary`, optional `details`, optional `remediation`, and redacted diagnostic metadata. Statuses should distinguish `ok`, `warn`, `fail`, and `skipped` where the existing command model allows it.
- Include readiness checks for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate limit state, disk-space warnings, and redaction.
- Redact secrets, tokens, credentials, home-directory-sensitive paths when already redacted elsewhere in the project, and provider/API keys from both text and JSON outputs.
- Make warnings non-fatal unless existing behavior already treats the same condition as fatal. Missing required adapter, unavailable required Hub, or unreadable/writable required state may fail readiness.
- Add or adjust tests for missing adapter, stale Hub, stale worker, provider rate limit/backoff, and Rust runtime unavailable when Rust is enabled.

### Rejected
- Rewriting `cpb doctor` or `cpb report` as a new command framework; unnecessary for P0.1 and too broad.
- Adding new third-party dependencies for command execution, semver, disk checks, or JSON formatting unless the project already has an established utility; use existing helpers and platform APIs first.
- Changing fake/mock responders, snapshots, or fixtures only to force tests through. Update test doubles only when they directly model the new readiness behavior being tested.
- Making every warning fail the command. Promotion readiness needs actionable diagnostics without breaking existing successful flows on non-critical warnings.
- Emitting raw environment variables, provider configuration, registry contents, job payloads, lease owners, or filesystem paths without the existing project redaction policy.

### Scope

**目标**: Implement P0.1 by expanding `cpb doctor` / `cpb report` readiness checks and adding `--json` output while preserving existing behavior and keeping all work limited to the promotion readiness must-have slice.

**涉及文件**:
- Existing `cpb doctor` command source discovered from current command registration - add or route to shared readiness checks and `--json` output.
- Existing `cpb report` command source discovered from current command registration - include the same readiness results and `--json` support if report has a separate output path.
- Existing readiness, environment, Hub, registry, job, worker, lease, provider, adapter, Rust-runtime, and redaction utilities - reuse or minimally extend only where needed for the checks below.
- Existing tests for doctor/report/readiness commands - add focused coverage for the required P0.1 scenarios without unrelated fixture churn.

**实现步骤**:
1. Read the promotion readiness plan and locate the existing `cpb doctor` / `cpb report` command implementations, their option parsing, current output contracts, and related tests.
2. Inventory existing utilities before adding code: command execution helpers for `node`, `npm`, and `git`; ACP adapter discovery/version helpers; Hub client/state helpers; registry validators; job/worker/lease stores; provider backoff/rate-limit state; Rust-runtime enablement checks; disk-space helpers; and redaction helpers.
3. Define the shared readiness result model in the existing doctor/report area. Keep it small and serializable, with stable check IDs such as `node`, `npm`, `git`, `acp.adapter`, `acp.smoke`, `rust.runtime`, `hub.liveness`, `hub.writability`, `registry.consistency`, `jobs.stale`, `workers.stale`, `leases.stale`, `provider.backoff`, `disk.space`, and `redaction`.
4. Implement the Node/npm/Git checks using existing process/version helpers. Each check should report presence and version when available, fail only when the tool is required by current readiness behavior, and redact executable paths if project policy requires it.
5. Implement ACP adapter readiness: detect missing adapter, report adapter version when available, and run the lightest existing smoke/readiness probe. The smoke probe must avoid starting long-running work or mutating project state beyond existing safe readiness behavior.
6. Implement the Rust runtime check only when Rust support is enabled by existing config, feature flag, or environment rules. If Rust is disabled, return `skipped`; if enabled but unavailable, return a clear `fail` or existing-equivalent readiness status with remediation.
7. Implement Hub checks for liveness and writability using the existing Hub client/state location. Liveness should identify unavailable or stale Hub state; writability should verify the command can write required Hub/readiness state without corrupting existing data.
8. Implement registry consistency checks using the existing registry source of truth. Report mismatched, missing, duplicate, or unreadable entries with redacted details and actionable remediation.
9. Implement stale job, worker, and lease checks using existing TTL/staleness definitions where present. Do not invent aggressive TTLs if the project already defines them. Report stale workers separately from stale jobs and stale leases so operators can act precisely.
10. Implement provider backoff/rate-limit readiness by reading existing provider state. A current backoff/rate-limit should produce a warning or existing-equivalent non-ready status with retry timing redacted to safe values; expired backoff should not warn.
11. Implement disk-space warnings for the relevant project, Hub, registry, and runtime state locations using existing thresholds where defined. If no threshold exists, choose a conservative warning threshold and document it in code comments near the check.
12. Thread redaction through every readiness result before text or JSON rendering. Add a specific redaction self-check or assertion path so `cpb doctor --json` and `cpb report --json` cannot leak obvious token/key/secret-shaped values.
13. Add `--json` output to `cpb doctor` and `cpb report` through existing option parsing. JSON output should be deterministic, parseable, and free of human-only formatting. Existing text output should remain compatible except for the new readiness lines.
14. Update command exit-code handling only where required by the new readiness statuses. Preserve existing success/failure behavior for unchanged checks, and make added warnings non-fatal unless they represent a required missing capability.
15. Add or adjust tests for:
    - missing ACP adapter reports the correct failed check and redacted remediation;
    - stale Hub/liveness or writability problem is surfaced without corrupting Hub state;
    - stale worker is reported distinctly from stale job and stale lease;
    - active provider rate limit/backoff is reported with safe retry information;
    - Rust unavailable fails only when Rust is enabled and is skipped when disabled;
    - `--json` output is valid JSON, deterministic enough for assertions, and contains redacted values only.
16. Run the project’s relevant doctor/report test suite first, then the broader lint/typecheck/test commands normally required by this repository. If a broad command is too expensive or blocked, report the blocker and the narrower evidence in the deliverable.

**注意事项**:
- This is a readiness expansion, not a cleanup pass. Avoid renaming existing command modules, moving large blocks of code, or changing unrelated output.
- Prefer existing helpers and patterns over new abstractions. Add a helper only when both doctor and report need the same behavior.
- Keep all probes bounded and side-effect-light. Readiness checks must not enqueue real work, claim leases, mutate registry records, or clear provider backoff.
- Preserve existing behavior for users who do not pass `--json`.
- Keep JSON output intentionally boring: no ANSI color, no log prefixes, no stack traces, no unredacted paths/secrets.
- Make test fixtures purpose-built for the new readiness behavior; do not weaken existing assertions to accommodate regressions.

## Next-Action
Implement P0.1 exactly as scoped above. After implementation and verification, write `deliverable-019.md` describing changed files, readiness checks added, test evidence, and any remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor` preserves its existing default human-readable behavior and additionally supports parseable `--json` output.
- [ ] `cpb report` includes the expanded readiness checks and supports parseable `--json` output through the existing report surface.
- [ ] JSON readiness output includes stable check IDs, statuses, summaries, and redacted details for Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, and redaction.
- [ ] Missing ACP adapter is detected and covered by a focused test.
- [ ] Stale or unavailable Hub readiness is detected and covered by a focused test.
- [ ] Stale worker readiness is detected distinctly from stale jobs and leases and covered by a focused test.
- [ ] Active provider rate limit/backoff readiness is detected and covered by a focused test.
- [ ] Rust runtime unavailable is covered by a focused test and only fails readiness when Rust support is enabled.
- [ ] Text and JSON outputs redact secrets, tokens, provider credentials, and sensitive diagnostics.
- [ ] Existing doctor/report behavior and tests continue to pass unless the change is directly required by P0.1.
- [ ] No unrelated cleanup, broad refactor, dependency addition, or behavior change is included.
- [ ] All relevant tests, plus lint/typecheck where normally required by the repository, pass or any blocked verification is explicitly reported with reason.
