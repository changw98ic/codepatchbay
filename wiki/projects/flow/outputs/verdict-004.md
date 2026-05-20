VERDICT: PARTIAL

The deliverable implements meaningful parts of plan-009, especially ACP tool-policy hardening:
- `bridges/acp-client.mjs` now checks the RPC method plus `params.name`, `params.toolName`, and `params.tool`, normalizes underscores to hyphens, and emits `cpb_tool_denied` audit events with job, phase, agent, tool, method, and reason.
- `bridges/phase-tool-policy.mjs` applies deny presets to verify/repair/fix lanes and includes hyphen/underscore variants.
- `bridges/run-pipeline.mjs` passes phase deny tools into bridge env and wires SIGTERM/SIGINT into active phase abort.
- `bridges/common.sh` external repair prompt is locator-based and explicitly tells repair to read logs/code rather than trust copied summaries.
- Scoped `reconcileOneJob` and `cpb recover ... --terminal`/`jobs reconcile --project ... --job-id ...` paths exist.

Blocking gaps remain against the plan Acceptance-Criteria:
1. Focused repair-input isolation tests are placeholders. In `tests/issue-001-hardening.test.mjs`, the two B tests only call `assert.ok(true)`, so the required coverage for "repair input isolation" is not real.
2. `cpb status <project> --json` can hang. In `cmd_status`, the branch that first assigns `project="$1"` does not `shift`, so the documented argument order loops forever before emitting JSON.
3. Status queue association can still report an unrelated `in_progress` queue entry for the same project when no lineage match exists. That weakens the criterion that queue status, durable job state, and `cpb status` agree on the cancelled job's terminal outcome.
4. The cancel tests do not prove the actual `cpb cancel`/`cancel-redirect` path end to end: some tests manually call `cancelJob()` and manually release leases, while D2 simulates the queue filter logic instead of invoking the implementation.

Next: replace placeholder tests with assertions over the actual repair prompt/input, fix `cmd_status` argument parsing, make status queue matching lineage-specific, and add a focused cancel-redirect/status test that exercises lease release and queue/durable convergence through the real implementation.
