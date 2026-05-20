# Plan: Use the promotion readiness plan at /Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md as the source of truth; implement P0.1 expanded cpb doctor/report readiness checks

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: TASK-110
- **Timestamp**: 2026-05-19T00:00:00+08:00

### Decided
- Treat `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` as the source of truth, but implement only P0.1.
- Expand the existing `cpb doctor` / `cpb report` readiness surface; do not create an unrelated diagnostic command or broaden into cleanup.
- Keep human output behavior compatible by default and add machine-readable `--json` output for readiness results.
- Use one shared readiness-check implementation for both commands so human and JSON output cannot drift.
- Represent each check as structured data with stable `id`, `status`, `summary`, optional `details`, optional `remediation`, and redacted `evidence`.
- Status values should distinguish `pass`, `warn`, `fail`, and `skip`; top-level JSON should expose `ok`, aggregate `status`, `generatedAt`, and `checks`.
- Warnings should not become hard failures unless existing command behavior or the specific condition already requires a nonzero exit; missing mandatory runtime pieces should fail.
- Rust runtime readiness must be checked only when Rust support is enabled by the existing config/env path.
- All human and JSON output must pass through the same redaction path before printing or persisting.

### Rejected
- Broad CLI cleanup or command restructuring | outside the P0.1 scope and risks changing existing behavior.
- Adding new dependencies for version checks, disk checks, redaction, or JSON formatting | the task can be implemented with existing project utilities and Node built-ins unless the repo already has suitable helpers.
- Making Rust globally required | P0.1 only requires Rust runtime checks when Rust support is enabled.
- Updating fake/mock responders, snapshots, or fixtures solely to force tests green | project guidance says production behavior must drive test changes.
- Emitting ad hoc JSON separate from human readiness logic | this would let `doctor` and `report` disagree.

### Scope

**目标**: Implement P0.1 only: expand `cpb doctor` / `cpb report` readiness checks with `--json` output, environment/tool/runtime readiness, Hub and registry health, stale-state detection, provider backoff visibility, disk-space warnings, output redaction, and focused tests.

**涉及文件**:
- `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md` — read-only source-of-truth requirements; do not edit.
- Existing `cpb doctor` command implementation — add/route `--json`, render readiness results, preserve current default human output.
- Existing `cpb report` command implementation — add/route `--json` or include readiness JSON in the existing report JSON path, matching the command's current contract.
- Existing CLI command registration/parser files for `doctor` and `report` — wire the flag without changing unrelated options.
- Existing readiness/report/diagnostics utilities, or a new narrowly scoped module beside them — implement the shared readiness check collector.
- Existing Hub client/state utilities — check Hub liveness, writability, stale Hub state, jobs, workers, and leases using current storage/API conventions.
- Existing provider/adapter registry utilities — check ACP adapter presence, adapter version, adapter smoke readiness, registry consistency, and provider backoff/rate-limit state.
- Existing config/runtime utilities — determine Node/npm, Git, disk space, redaction rules, and Rust-enabled state using current patterns.
- Existing test files for CLI doctor/report/readiness, plus new focused tests in the same test area if no suitable file exists — cover the required P0.1 cases without modifying unrelated fixtures.

**实现步骤**:
1. Read the promotion readiness plan and extract only the P0.1 requirements named in this handoff; ignore later P0/P1/P2 items.
2. Locate the existing `cpb doctor` and `cpb report` command implementations, their option parsing, existing readiness/report utilities, and current tests for those commands.
3. Add a shared readiness result model if one does not already exist:
   - `status`: `pass | warn | fail | skip`
   - stable `id` values such as `node`, `npm`, `git`, `acp-adapter`, `rust-runtime`, `hub-liveness`, `hub-writability`, `registry-consistency`, `stale-jobs`, `stale-workers`, `stale-leases`, `provider-backoff`, `disk-space`
   - top-level aggregate `ok`, `status`, `generatedAt`, and `checks`
4. Implement toolchain checks:
   - Node version from the running process, compared with existing engine/runtime constraints when available.
   - npm presence/version using the repo's existing command-runner abstraction.
   - Git presence/version using the same command-runner abstraction.
   - Missing npm/Git should produce a clear `fail` or existing-severity equivalent with remediation.
5. Implement ACP adapter readiness:
   - Resolve the configured/default ACP adapter through the existing registry/config path.
   - Check adapter presence and version.
   - Run the smallest existing smoke-readiness probe available for the adapter.
   - Missing adapter must be covered by a test and should fail with a remediation that names the adapter/config source.
6. Implement Rust runtime readiness:
   - Detect whether Rust runtime support is enabled through existing config/env/runtime flags.
   - If disabled, emit `skip` with a short reason.
   - If enabled, check the required Rust binary/runtime through existing conventions.
   - Rust unavailable when enabled must be covered by a test and should fail with remediation.
7. Implement Hub readiness:
   - Check Hub liveness using the existing Hub client/health path.
   - Check Hub writability by writing and cleaning up a small probe in the existing Hub state/write location.
   - Detect stale Hub state using existing lock/socket/pid/heartbeat conventions.
   - Stale Hub must be covered by a test and should report a concrete warning/failure according to current Hub semantics.
8. Implement registry consistency:
   - Verify provider and adapter registry entries are internally consistent.
   - Detect duplicate IDs, configured provider/adapter IDs missing from the registry, malformed persisted registry state, and stale references.
   - Do not mutate registry state during `doctor` or `report`.
9. Implement stale jobs/workers/leases checks:
   - Reuse existing TTL/heartbeat semantics when present; otherwise introduce named constants local to readiness code.
   - Report stale jobs, stale workers, and stale leases separately so remediation can be precise.
   - Stale worker must be covered by a test.
10. Implement provider backoff/rate-limit visibility:
   - Read existing provider backoff/rate-limit state without resetting it.
   - Surface active backoff as `warn` with provider ID, sanitized reason, and reset/retry time when available.
   - Rate-limit/backoff state must be covered by a test.
11. Implement disk-space warnings:
   - Check free space for the project/state/output paths that `cpb` actually writes to.
   - Warn below the project's existing low-space threshold if one exists; otherwise use a clearly named local threshold.
   - Do not fail unless the existing code already treats insufficient disk as fatal.
12. Add redaction:
   - Route all readiness summaries, details, evidence, remediation strings, and JSON through an existing redactor if present.
   - If no redactor exists, add a narrow redactor that masks tokens, API keys, bearer values, credentials embedded in URLs, and known secret-like env values.
   - Add or adjust a test so both human and JSON output cannot leak a sample secret.
13. Wire `--json`:
   - `cpb doctor --json` should print only valid JSON to stdout with no ANSI decoration or extra prose.
   - `cpb report --json` should include the readiness payload in the existing report JSON contract, or print the same readiness object if report currently has no broader schema.
   - Preserve existing non-JSON output and exit-code behavior except for newly detected fatal readiness failures.
14. Add focused tests for the required cases:
   - missing ACP adapter
   - stale Hub
   - stale worker
   - provider rate-limit/backoff
   - Rust unavailable when Rust is enabled
   - JSON output validity and redaction if not already covered by the above cases
15. Run the project's relevant test commands for the modified CLI/readiness area, then run the standard lint/typecheck/test commands available in the repo. Record exact commands and results in the deliverable.

**注意事项**:
- Do not implement other promotion-readiness slices.
- Do not rename commands, change unrelated CLI options, or alter existing report fields unless needed to add readiness data.
- Do not create broad framework abstractions; keep new code beside existing doctor/report/readiness utilities.
- Do not change snapshots or fake adapters merely to fit the implementation. If a test double no longer represents the intended workflow, add a purpose-built test fixture for this readiness case.
- Keep all emitted paths, command output, env values, tokens, provider errors, and adapter smoke evidence redacted.
- Prefer existing command-runner, config, Hub, registry, and logging utilities over direct process/global calls.

### Self-Review
- The plan addresses only P0.1 from the specified promotion-readiness plan.
- The plan includes all required readiness categories: `--json`, Node/npm, Git, ACP adapter presence/version/smoke readiness, Rust when enabled, Hub liveness/writability, registry consistency, stale jobs/workers/leases, provider backoff, disk-space warnings, redaction, and required tests.
- The plan preserves existing human output and behavior unless a newly required fatal readiness condition is detected.
- The plan avoids unrelated cleanup, new dependencies, and fake/mock churn.

### Evidence
- Planning-only phase; Codex did not run terminal commands or inspect the repository.
- This handoff is scoped to files under `/Users/chengwen/dev/flow/wiki/projects/flow/inbox/` as requested.

### Risks
- Exact implementation/test file paths must be discovered during execution because this planning phase was constrained from running repository inspection commands.
- Existing `cpb report --json` semantics may already have a schema; readiness data must be added compatibly rather than replacing existing fields.
- Severity mapping for stale Hub/jobs/workers/leases may depend on existing Hub lifecycle semantics; use current project behavior where it exists.

## Next-Action
Implement only P0.1 as described above. Start by reading `/Users/chengwen/dev/flow/docs/superpowers/plans/2026-05-18-promotion-readiness-must-haves.md`, then locate the existing `cpb doctor` / `cpb report` code and tests, make the smallest scoped implementation, run the relevant verification, and write `deliverable-110.md` with changed files, test evidence, and remaining risks.

## Acceptance-Criteria
- [ ] `cpb doctor --json` emits valid, redacted JSON with aggregate readiness status and per-check results.
- [ ] `cpb report --json` includes the same expanded readiness information without breaking the existing report contract.
- [ ] Default human output for `cpb doctor` and `cpb report` remains compatible with existing behavior, aside from the new readiness checks.
- [ ] Readiness checks cover Node/npm availability/version, Git availability/version, ACP adapter presence/version/smoke readiness, Rust runtime when enabled, Hub liveness and writability, registry consistency, stale jobs/workers/leases, provider backoff/rate-limit state, and disk-space warnings.
- [ ] Missing ACP adapter is tested and reported with a non-secret remediation.
- [ ] Stale Hub state is tested and reported with the correct severity for current Hub semantics.
- [ ] Stale worker state is tested and reported separately from stale jobs and leases.
- [ ] Provider rate-limit/backoff state is tested and does not reset or mutate backoff state.
- [ ] Rust unavailable while Rust support is enabled is tested and fails readiness with remediation.
- [ ] Human and JSON readiness output redact sample secrets, tokens, credentials in URLs, and secret-like environment values.
- [ ] Registry consistency checks are read-only and report duplicate/missing/malformed entries without mutating registry state.
- [ ] Disk-space checks warn below the configured threshold or a named local threshold, and do not hard-fail unless existing behavior requires it.
- [ ] Relevant CLI/readiness tests pass.
- [ ] Standard lint/typecheck/test verification available for this repo passes, or any unavailable command is explicitly documented in `deliverable-110.md`.
- [ ] Changes remain scoped to P0.1 and do not include unrelated cleanup.
