## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-032
- **Timestamp**: 2026-05-19T00:00:00+08:00

# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth. Implement only this P0 slice, keep changes scoped, add/adjust tests, and preserve existing behavior. Do not broaden into unrelated cleanup. Implement P0.1: expand cpb doctor/report readiness checks. Include --json output, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and tests for missing adapter/stale Hub/stale worker/rate limit/Rust unavailable.

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the governing source for exact P0.1 wording, severity expectations, and any existing readiness taxonomy.
- Implement only P0.1 readiness checks for `cpb doctor` / readiness reporting; do not expand into other P0/P1 promotion-readiness items.
- Preserve existing human-readable doctor/report behavior while adding machine-readable `--json` output.
- Structure readiness output as stable, redacted check records with clear status, severity, summary, optional details, and remediation fields so CLI text and JSON can share one evaluation path.
- Add test coverage for required failure modes instead of weakening fake/mock behavior to make tests pass.

### Rejected
- Broad promotion-readiness implementation beyond P0.1 — explicitly out of scope and risks unrelated churn.
- Rewriting doctor/report internals wholesale — unnecessary for the P0.1 slice; prefer additive shared readiness helpers around existing behavior.
- Adding new third-party dependencies for environment probing or disk checks — constraints favor existing runtime APIs and local project patterns.
- Emitting raw paths, tokens, provider payloads, or registry contents in JSON — violates redaction requirement.
- Updating snapshots, fixtures, or fakes only to mask behavior changes — forbidden by project guidance unless the fake/test double itself is the product bug.

### Scope

**目标**: Expand `cpb doctor` / readiness reporting for promotion readiness P0.1, using the promotion readiness plan as source of truth, with scoped production changes and tests for required degraded states.

**涉及文件**:
- `docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read only; source-of-truth requirements and terminology.
- CLI entrypoint for `cpb doctor` / `cpb report` — add or wire `--json` output without changing existing default text behavior.
- Existing readiness/doctor/report modules — add shared readiness check collection for Node/npm, Git, ACP adapter, optional Rust runtime, Hub, registry, stale runtime state, provider backoff, disk space, and redaction.
- Existing ACP adapter discovery/version/smoke code, if present — reuse it to report adapter presence/version/smoke readiness; add a thin wrapper only if no shared helper exists.
- Existing Hub client/store modules — reuse liveness and writability checks; add timeout-bounded probes where necessary.
- Existing registry modules — add consistency validation that reuses current registry loading/parsing rules.
- Existing jobs/workers/leases modules — detect stale jobs, workers, and leases using current timestamp/TTL semantics already used by the project.
- Existing provider/backoff modules — expose backoff/rate-limit state read-only for readiness output.
- Existing config/runtime feature detection modules — report Rust runtime unavailable only when Rust is enabled or selected by config/env.
- Existing tests near doctor/report/readiness CLI coverage — add tests for JSON shape, redaction, and required degraded states.

**实现步骤**:
1. Read the promotion readiness source plan and map the exact P0.1 acceptance language into an internal checklist before editing code.
   - Expected output: implementation notes identifying existing modules and the minimum check list for P0.1 only.

2. Locate the existing `cpb doctor` and `cpb report` command paths and identify their current output contract.
   - Expected output: one shared readiness evaluation function can feed both default text output and `--json` output.
   - Preserve command names, exit semantics, and current human-readable fields unless the source plan requires otherwise.

3. Add `--json` support to the relevant CLI command(s).
   - Expected output: `cpb doctor --json` and any existing readiness report command requested by the source plan emit valid JSON only, with no banners, colors, progress spinners, or mixed stderr/stdout diagnostics except fatal CLI errors.
   - JSON should include at minimum an overall status plus check records keyed by stable ids.

4. Implement environment prerequisite checks.
   - Node/npm: report detected versions and missing/unusable state.
   - Git: report detected version and missing/unusable state.
   - ACP adapter: report presence, version when discoverable, and smoke readiness using existing adapter launch/probe behavior.
   - Rust runtime: only check when Rust runtime is enabled/selected; report unavailable or version/smoke readiness without failing non-Rust configurations.

5. Implement Hub and registry readiness checks.
   - Hub liveness: verify the configured Hub is reachable enough for current project workflows.
   - Hub writability: verify the Hub storage path or API write path can persist required state using a safe temporary/probe write and cleanup pattern from existing code.
   - Registry consistency: validate that project/adapter/provider registry entries load, parse, and cross-reference consistently with existing schema expectations.

6. Implement runtime state health checks.
   - Stale jobs: detect jobs past their active heartbeat/TTL or stuck terminal-transition thresholds.
   - Stale workers: detect workers with expired heartbeat/lease state.
   - Stale leases: detect expired or orphaned leases according to current lease semantics.
   - Provider backoff: report active provider rate-limit/backoff state, including remaining cooldown when available.

7. Implement disk-space warnings.
   - Check relevant writable roots used by CPB Hub/project state, not arbitrary system paths.
   - Report warnings below the threshold specified by the source plan or existing config; if no threshold exists, use the project’s current warning convention.
   - Keep disk warnings non-fatal unless the source plan says otherwise.

8. Apply redaction consistently.
   - Redact secrets, tokens, auth headers, API keys, provider credentials, home-directory-sensitive paths if the project already does so, and provider payload fragments.
   - Use or extend existing redaction utilities; do not create a competing redaction system unless none exists.
   - Ensure both human text and JSON output pass through the same redaction boundary for dynamic details.

9. Add focused tests for the P0.1 required cases.
   - Missing adapter: readiness reports ACP adapter failure/warning with actionable remediation.
   - Stale Hub: readiness reports Hub liveness/writability failure without crashing JSON output.
   - Stale worker: readiness reports stale worker state using existing heartbeat/TTL semantics.
   - Rate limit: readiness reports provider backoff/rate-limit state and remains redacted.
   - Rust unavailable: when Rust runtime is enabled, readiness reports unavailable runtime; when disabled, it does not incorrectly fail readiness.
   - Add JSON-output tests proving valid JSON, stable check ids, no ANSI color/control output, and no unredacted secrets.

10. Run the existing targeted test suite for the touched doctor/report/readiness areas, then run broader lint/type/test commands normally used by this repo if available.
    - Expected output: deliverable evidence includes exact commands and summarized results.
    - If a required command is unavailable in the execution environment, report that as `Not-tested` with the reason.

**注意事项**:
- Keep all production changes scoped to P0.1 readiness checks and the JSON output surface.
- Do not implement unrelated promotion readiness items from the source plan.
- Do not alter fake/mock tests just to match changed production behavior; prefer adding purpose-built tests or improving the product-facing readiness path.
- Preserve existing exit codes unless the source plan explicitly defines new readiness severity behavior.
- Keep readiness checks timeout-bounded and non-destructive; probes must not leave persistent jobs, workers, leases, or registry mutations behind.
- Ensure JSON output remains deterministic enough for tests while avoiding brittle ordering assumptions where the project already avoids them.

## Next-Action
Read `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, implement only P0.1 as scoped above, add/adjust focused tests, run verification, and write `deliverable-032.md` with changed files, evidence, risks, and any known verification gaps.

## Acceptance-Criteria
- [ ] `cpb doctor --json` produces valid JSON only, with stable readiness check ids and an overall readiness status.
- [ ] Existing default `cpb doctor` / readiness report text behavior is preserved except for intentional added readiness rows.
- [ ] Node/npm readiness reports detected versions or actionable missing/unusable diagnostics.
- [ ] Git readiness reports detected version or actionable missing/unusable diagnostics.
- [ ] ACP adapter readiness reports presence, version when discoverable, and smoke readiness.
- [ ] Rust runtime readiness is checked only when Rust runtime is enabled/selected, and Rust-unavailable behavior is covered by tests.
- [ ] Hub readiness covers liveness and writability with safe, cleaned-up probes.
- [ ] Registry consistency issues are detected and reported without crashing the command.
- [ ] Stale jobs, stale workers, and stale leases are detected using existing heartbeat/TTL semantics.
- [ ] Provider backoff/rate-limit state is reported without exposing provider secrets or raw sensitive payloads.
- [ ] Disk-space warnings are emitted for relevant CPB writable roots below the configured/project threshold.
- [ ] Redaction is applied to JSON and human-readable output; tests prove representative secrets are not emitted.
- [ ] Tests cover missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, JSON shape, and redaction.
- [ ] All targeted and reasonable repo-standard verification commands pass, or any unavailable verification is documented honestly in the deliverable.
- [ ] Code style and behavior match existing project patterns, with no unrelated cleanup or broad refactor.
