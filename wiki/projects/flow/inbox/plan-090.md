## Handoff: codex -> claude

# Plan: Use the promotion readiness plan at `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth; implement only P0.1 expanded `cpb doctor/report` readiness checks

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-090
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the implementation source of truth; implement only P0.1 from that document.
- Expand the existing `cpb doctor` / readiness-report implementation instead of creating a parallel diagnostic command or broad cleanup pass.
- Preserve current human-readable output behavior, and add `--json` as a machine-readable output mode for the same readiness checks.
- Model readiness output as structured checks with stable IDs, severity/status, redacted details, and enough metadata for both text and JSON rendering.
- Keep runtime probes bounded and non-destructive: liveness, writability, version, presence, smoke-readiness, stale-state detection, and warnings only.
- Redaction is part of the readiness layer, not only the text renderer; JSON must not leak tokens, keys, bearer values, auth headers, or provider secrets.
- Add or adjust tests around behavior specified by P0.1, including missing adapter, stale Hub, stale worker, rate limit/provider backoff, and Rust unavailable cases.

### Rejected
- Building a new standalone readiness subsystem | It broadens scope and risks diverging from existing `cpb doctor/report` behavior.
- Rewriting unrelated command plumbing, registry internals, provider orchestration, or Hub lifecycle code | P0.1 is a readiness-check expansion only.
- Making checks fatal by default | Existing behavior should be preserved; readiness checks should report actionable status without changing unrelated command semantics.
- Printing raw diagnostic payloads in JSON | Redaction is required for both text and JSON outputs.
- Adding new third-party dependencies | The task asks for scoped implementation and existing behavior preservation.

### Scope

**目标**: Implement P0.1 by expanding `cpb doctor` / report readiness checks to cover the promotion-readiness must-haves: `--json`, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and focused tests.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source of truth for P0.1 requirements.
- Existing `cpb doctor` command implementation file(s) — add/route the expanded readiness checks and `--json` flag through the current CLI surface.
- Existing readiness report/diagnostic module file(s) — centralize check definitions, status/severity shaping, redaction, and text/JSON renderable results.
- Existing ACP adapter resolution/version/smoke helper file(s), if already present — reuse for adapter presence, version, and smoke-readiness checks.
- Existing Hub client/state helper file(s) — reuse for Hub liveness, writability, registry consistency, stale jobs/workers/leases, and stale Hub detection.
- Existing provider/backoff state helper file(s) — expose rate-limit/backoff readiness warnings without changing provider execution behavior.
- Existing Rust-runtime feature/config helper file(s) — check Rust runtime availability only when the Rust path is enabled.
- Existing CLI/readiness tests — add/adjust focused tests for JSON output, missing adapter, stale Hub, stale worker, provider rate limit/backoff, Rust unavailable, and redaction.

**实现步骤**:
1. Read the P0.1 section in `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` and identify any exact wording, severity expectations, or edge cases that refine this handoff.
2. Locate the current `cpb doctor` and report/readiness code paths. Confirm the command entrypoint, text renderer, test style, and any existing diagnostic result type before editing.
3. Define or extend a single readiness result shape used by both text and JSON output. Include stable fields such as `id`, `label`, `status` (`ok`, `warn`, `fail`, `skip`), `severity`, `summary`, optional redacted `details`, and optional remediation text, matching existing naming conventions where present.
4. Add `cpb doctor --json` support through the existing CLI parser. JSON mode should emit structured readiness results and summary counts; text mode should continue to match existing behavior except for the new checks.
5. Implement environment/tool checks for Node, npm, and Git using existing process/runtime helpers. Missing or unusable tools should be reported as readiness failures or warnings according to the P0.1 source document, without throwing unhandled exceptions.
6. Implement ACP adapter checks: presence, version discovery, and a bounded smoke-readiness probe. Missing adapter must produce a clear failure in both text and JSON output; version/smoke failures must be actionable and redacted.
7. Implement conditional Rust runtime readiness. Only run the Rust check when the current configuration/feature flag enables the Rust runtime; otherwise report `skip` or omit according to existing readiness conventions and the P0.1 source document.
8. Implement Hub readiness checks using existing Hub/state accessors: liveness, writability, registry consistency, stale Hub state, stale jobs, stale workers, and stale leases. Treat stale records as warnings unless the source document specifies failure.
9. Implement provider backoff/rate-limit readiness. Detect active provider backoff or rate-limit state from existing provider state storage and report a warning with redacted provider/account details.
10. Implement disk-space warning checks for relevant project/cache/state paths already used by the app. Keep thresholds aligned with the source document if specified; otherwise choose conservative warning-only thresholds and document them in code comments only if not self-evident.
11. Add a shared redaction pass before any readiness result reaches text or JSON rendering. Cover tokens, API keys, bearer values, auth headers, provider secrets, URLs with credentials, and common env-style secret names.
12. Add or update focused tests using the existing test harness and fixtures. Required cases: missing ACP adapter, stale Hub, stale worker, provider rate-limit/backoff, Rust runtime enabled but unavailable, `--json` output shape, registry inconsistency, and redaction in both text and JSON paths.
13. Run the project’s relevant test suite for the touched command/readiness modules. If broader lint/typecheck commands are standard for this repo, run them after the focused tests.
14. Write `deliverable-090.md` with changed files, test evidence, notable simplifications, and remaining risks.

**注意事项**:
- Do not implement any P0.2/P1/P2 items from the promotion readiness plan.
- Do not broaden into unrelated cleanup, command rewrites, dependency upgrades, formatting churn, or test fixture rewrites unrelated to P0.1.
- Preserve existing human-readable output unless P0.1 requires additional lines/checks.
- Prefer existing utilities for process execution, config loading, Hub access, registry parsing, provider state, and test fixtures.
- Keep probes fast and bounded; readiness checks must not start long-running services, mutate real provider state, or require network access unless existing Hub liveness checks already do so locally.
- If a readiness dependency is absent in test fixtures, simulate it through the repo’s existing mocking pattern instead of changing fake behavior merely to make tests pass.

## Next-Action
Implement only the P0.1 `cpb doctor/report` readiness expansion described above, using `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth. Keep the diff scoped to existing readiness/CLI/test surfaces, run the relevant verification, then write `deliverable-090.md` for Codex review.

## Acceptance-Criteria
- [ ] `cpb doctor` preserves existing text behavior while reporting the new P0.1 readiness checks.
- [ ] `cpb doctor --json` emits valid machine-readable readiness output with stable check IDs, statuses, summaries, details/remediation where appropriate, and summary counts.
- [ ] Readiness checks cover Node, npm, Git, ACP adapter presence/version/smoke readiness, conditional Rust runtime, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is detected and tested.
- [ ] Stale Hub state is detected and tested.
- [ ] Stale worker state is detected and tested.
- [ ] Provider rate-limit/backoff state is detected and tested.
- [ ] Rust runtime enabled-but-unavailable is detected and tested.
- [ ] Registry inconsistency and stale lease/job behavior are covered by tests or explicitly justified in the deliverable if existing tests already cover them.
- [ ] Text and JSON outputs redact secrets, tokens, auth headers, provider keys, and credential-bearing URLs; redaction is tested.
- [ ] All new checks handle unavailable tools/services gracefully without unhandled exceptions.
- [ ] No unrelated cleanup, dependency additions, or behavior changes outside P0.1 are included.
- [ ] Relevant focused tests pass, and lint/typecheck/static checks pass where standard for the touched modules.
