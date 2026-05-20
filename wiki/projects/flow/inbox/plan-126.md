## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: GitHub issues #11, #10, #12, #13, #14
- **Timestamp**: 2026-05-20T11:15:00+08:00

# Complete phase-runner migration, process control, verdict envelope, ACP permission enforcement, and recovery lineage

## Primary Directive

Implement the current GitHub issue chain in this repository:

1. #11 first: finish the thin phase-runner bridge migration.
2. #10 next: add CPB-owned process registry plus CLI control surfaces.
3. #13 alongside #10: wire permission matrix into live ACP side-effect enforcement.
4. #12 after #11 verifier ownership is available: adopt the structured verifier verdict envelope and pipeline classification.
5. #14 after #11/#10 status surfaces are available: expose recovery lineage in jobs/status/inspect outputs.

Use the existing project style, keep diffs reviewable, and do not add dependencies.

## Current Evidence Before Execution

- `bridges/codex-plan.sh`, `bridges/claude-execute.sh`, `bridges/codex-verify.sh`, and `bridges/reviewer-review.sh` still contain prompt construction, artifact ID allocation, verdict parsing, log/dashboard mutation, and heredocs.
- `server/services/phase-runner.js` currently mostly validates and delegates to `bridges/job-runner.mjs`; it does not own prompt construction, artifact allocation, parser contracts, ACP permission context, or process registry.
- `bridges/run-pipeline.mjs` still parses legacy `VERDICT: PASS|FAIL|PARTIAL` strings and uses business retry logic for unclear/missing verifier artifacts.
- `cpb` has no `ps`, `inspect`, `stop`, or `clean` process-management commands.
- `bridges/acp-client.mjs` has only generic write/tool denial behavior and does not append structured `permission_denied` job events.
- Recovery lineage exists in job state/events, but CLI/API status surfaces do not expose it enough for operators.

## Implementation Plan

### Stage 1: Node-owned prompt/artifact/result services for #11

Add or extend Node services so the phase runner owns all control-plane behavior:

- Add `server/services/prompt-builder.js` or equivalent for plan, execute, verify, review, and repair prompts.
- Add/extend artifact locator/allocation helpers for plan, deliverable, verdict, review, and repair outputs.
- Preserve prompt content and observable stdout shapes where practical.
- Move result parsing helpers for plan id, deliverable id, review verdict, and verifier verdict into Node.
- Move log/dashboard/event updates into Node-owned phase execution where possible.
- Reduce `bridges/codex-plan.sh`, `bridges/claude-execute.sh`, `bridges/codex-verify.sh`, `bridges/reviewer-review.sh`, and `bridges/run-pipeline.sh` to thin compatibility wrappers that exec Node entrypoints and contain no prompt heredocs, artifact parsing, retry counters, state-machine branching, or dashboard/log mutation.
- Keep CLI entrypoints `cpb plan`, `cpb execute`, `cpb verify`, `cpb review --agent`, and `cpb pipeline` working.
- Keep Rust as low-level runtime/registry/queue primitives only; do not move workflow semantics into Rust.

### Stage 2: Process registry and CLI controls for #10

Implement file-backed process management under `cpb-task/processes/{jobId}.json`:

- Record `jobId`, `project`, `phase`, `treeId`, `runnerPid`, child pids where available, `startedAt`, `lastHeartbeat`, `status`, `exitCode`, lease id, and command identity/start metadata where the platform supports it.
- Update process registry from the Node-owned runner path, using heartbeat cadence aligned with leases.
- Mark entries `exited`, `stopped`, or failed/error status on runner exit paths.
- Add CLI surfaces:
  - `cpb ps` lists CPB-owned registered process trees only, with job, phase, pid/tree id, age, lease state, and liveness classification.
  - `cpb inspect <jobId>` shows process registry entry, lease state, recent event-log context, and lineage summary.
  - `cpb stop <jobId>` verifies registry identity before signaling, terminates only the registered tree, escalates conservatively, records audit events, and is idempotent.
  - `cpb clean [--dry-run]` removes only eligible exited/orphan registry entries and never broad-matches by executable name.
- Include PID recycling/identity guard tests to ensure unrelated processes are not signaled.

### Stage 3: Live ACP permission enforcement for #13

Wire `server/services/permission-matrix.js` into actual ACP write/tool handling:

- Ensure ACP execution receives explicit context: `project`, `jobId`, `phase`, `role`, source path, and allowed boundary.
- Enforce denied `fs/write_text_file` and side-effectful tools through the permission matrix.
- On denial, do not perform the side effect; append a structured `permission_denied` event with `category: "infra"`, operation/tool, target path when applicable, role, phase, job id, allowed boundary, reason, and recovery guidance.
- Return a structured ACP error to the agent with enough context to self-correct.
- Preserve read-only verifier observation.
- Add repeated-identical-denial guard in a phase so agents do not loop forever.
- Surface denial state in status/pipeline classification as infra/blocked, not business failure.

### Stage 4: Structured verifier verdict envelope for #12

Adopt a v1 verifier result schema:

```json
{
  "status": "pass | fail | inconclusive | infra_error",
  "basis": {
    "taskGoal": "read | empty | missing | unreadable",
    "worktreeDiff": "read | empty | missing | unreadable",
    "tests": "read | not_run | missing | unreadable",
    "buildLogs": "read | not_run | missing | unreadable",
    "events": "read | empty | missing | unreadable",
    "runtimeState": "read | missing | unreadable",
    "executorSummary": "read | missing | advisory_only"
  },
  "blockingMissingInputs": [],
  "reason": "short human-readable explanation",
  "summary": "optional concise result summary"
}
```

- Add a schema/validator service.
- Update the verifier prompt builder to require the JSON envelope.
- Parse the envelope robustly and strictly.
- Map legacy `VERDICT: PASS|FAIL|PARTIAL` only through a clearly bounded transitional path with tests and visible diagnostics.
- Pipeline classification:
  - `pass`: complete.
  - `fail`: business/task failure and quality retry budget applies.
  - `inconclusive`: evidence/completeness issue and infra retry path applies.
  - `infra_error`: adapter/tool/runtime/permission issue and business retry budget is not consumed.
- Failure summaries/status output must include status and basis details.

### Stage 5: Recovery lineage/status surfaces for #14

Expose recovery chains without mutating terminal parent jobs:

- API/job response helpers include structured `lineage` for recovered jobs and parent summaries where practical.
- `cpb jobs` output shows recovered jobs with parent id and parent failure phase/code.
- `cpb status <project>` shows active recovery context for latest running/recovered job.
- `cpb inspect <jobId>` includes full bounded lineage and child recovery ids.
- Audit user-facing strings around `retry`; prefer `recover`, `recovery job`, and `fresh recovery` where output currently implies in-place mutation. Keep `cpb retry` as compatibility alias if needed, but make output explicit that it creates a fresh recovery job.
- Add tests for single and multi-level recovery chain display plus parent immutability.

## Required Tests

Add or update focused tests for each issue. Existing tests should keep passing.

- #11:
  - Wrapper parity for plan/execute/verify/review/pipeline through shell wrapper and direct Node runner.
  - Prompt builder contracts include locators and output targets.
  - Shell wrappers contain no heredocs/prompt text/control-plane parsing after migration.
  - SIGINT/SIGTERM propagation reaches Node runner and ACP child.
  - Rust boundary test proves workflow semantics remain Node-owned.
- #10:
  - Active job reports `alive`.
  - Expired heartbeat with matching process reports `stale`.
  - Missing/dead process reports `orphan`.
  - Unrelated `node` process never appears in `cpb ps`.
  - `cpb stop <jobId>` only signals verified registry tree and is idempotent.
  - Stopping exited job is safe and sends no signal.
  - `cpb clean --dry-run` does not delete, actual clean deletes only eligible orphan/exited entries.
  - PID recycling guard prevents signaling mismatched process identity.
- #13:
  - Denied write outside phase boundary records one structured infra denial and does not write.
  - Allowed write inside boundary succeeds.
  - Verifier read-only operations still work.
  - Denied side-effectful tool records operation/tool context.
  - Denial during execute/verify is infra/blocked, not verifier/task fail.
  - Repeated identical denial triggers bounded fail-fast behavior.
  - Status surface shows reason and recovery guidance.
- #12:
  - Valid pass/fail/inconclusive/infra_error envelopes parse and classify correctly.
  - Missing canonical inputs cannot become success.
  - Malformed JSON becomes infra/retryable state, not business failure.
  - Legacy verdict parser is bounded and tested.
  - Retry accounting distinguishes business retry from infra/completeness retry.
- #14:
  - Single recovery shows parent id and failure phase/code in jobs/status/inspect.
  - Multi-level recovery is navigable with bounded default depth.
  - Parent terminal event/state remains unchanged after lineage display.
  - API response includes lineage for recovered job and omits/empties it for ordinary job.
  - Help/output wording does not imply in-place retry semantics.

Run at minimum:

```bash
npm test
(cd runtime && cargo test)
```

If full verification is too slow or blocked, run the focused tests you added plus the existing affected suites, and record the exact gap in the deliverable.

## Acceptance-Criteria

- [ ] #11: Shell bridge scripts contain no heredocs, prompt text, retry counters, state-machine branching, artifact parsing, or dashboard/log mutation.
- [ ] #11: Each shell wrapper is small and exists only for CLI compatibility and signal propagation.
- [ ] #11: All phase lifecycle state flows through Node APIs: event store, job store, lease manager, locator, and phase runner.
- [ ] #11: Existing CLI entrypoints preserve observable behavior for plan, execute, verify, pipeline, review, and repair.
- [ ] #11: SIGINT/SIGTERM to shell wrappers propagate to Node runner and ACP child.
- [ ] #11: Rust cannot define independent workflow semantics.
- [ ] #10: `cpb ps` shows only CPB-owned registered process trees with job/phase ownership and liveness.
- [ ] #10: `cpb inspect <jobId>` shows process, lease, event context, and lineage summary.
- [ ] #10: `cpb stop <jobId>` never kills a PID not verified through the registry and is idempotent.
- [ ] #10: `cpb clean` is registry/liveness based, with dry-run support, and no broad executable-name matching.
- [ ] #10: Status/report surfaces explain running, stuck, stale, stopped, and orphaned jobs.
- [ ] #13: A denied ACP write records `permission_denied` with `category: infra` and does not write the file.
- [ ] #13: A denied side-effectful tool records `permission_denied` with operation/tool details.
- [ ] #13: Verifier read-only operations still work under restricted write scope.
- [ ] #13: Denials do not become `VERDICT: FAIL` or ordinary business `job_failed`.
- [ ] #13: `cpb status` or equivalent shows denial as infra/blocked with recovery guidance.
- [ ] #13: Business retry budget is not consumed by pure permission infra denial.
- [ ] #12: Verifier can return exactly one of `pass`, `fail`, `inconclusive`, or `infra_error`.
- [ ] #12: Every verdict includes basis entries for all canonical inputs.
- [ ] #12: Missing task goal, missing diff, unreadable runtime state, or absent logs cannot collapse into accidental success.
- [ ] #12: Pipeline treats `fail` as business failure and `inconclusive`/`infra_error` as infra/completeness failure.
- [ ] #12: Retry accounting distinguishes business retry budget from infra retry behavior.
- [ ] #12: Legacy verdict parsing is bounded, tested, and visibly marked as transitional.
- [ ] #14: Recovered jobs display parent job id and failure phase/code in `cpb jobs` or equivalent.
- [ ] #14: Inspect/status output shows parent context without mutating the parent job.
- [ ] #14: Multi-level recovery chains are navigable with bounded default depth.
- [ ] #14: Original terminal jobs remain unchanged and inspectable as audit records.
- [ ] #14: API responses include structured lineage for recovered jobs.
- [ ] #14: User-facing text does not imply in-place retry semantics.
- [ ] Tests and lint/build verification are run and recorded.
- [ ] Deliverable includes changed files, simplifications made, test evidence, and remaining risks.
