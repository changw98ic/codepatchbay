# GitHub issue #1: Harden ACP verifier/repair tool policy and cancellation state convergence

URL: https://github.com/changw98ic/codepatchbay/issues/1

## Handoff: codex -> claude

- **From**: codex
- **To**: claude
- **Project**: flow
- **Phase**: plan
- **Task-Ref**: GitHub issue #1
- **Timestamp**: 2026-05-19T09:20:34+08:00

### Decided
- Treat the GitHub issue body as the source of truth for the fix scope.
- Enforce ACP tool restrictions in CPB launch/runtime code, not only in prompts.
- Add phase/lane policy presets so `verify`, external repair, and `fix-*` lanes deny UI, Computer Use, Browser, TextEdit, and desktop automation by default.
- Keep verifier and external repair lanes independent: verifier must derive its verdict from goal, code, logs, and tests; external repair must read logs/code itself and must not receive precomputed verifier/executor evidence as truth.
- Make cancellation job-scoped and convergent across durable job state, queue entry, active phase lease, and ACP child process group.
- Add a scoped single-job reconcile/recover path that touches only the requested job lineage.
- Improve status JSON so operators can distinguish queue update time from phase heartbeat, lease freshness, lease expiry, and process liveness.
- Preserve worktrees, logs, and artifacts after cancellation for audit.

### Rejected
- Prompt-only tool bans — insufficient because the reported failure involved actual ACP tool calls.
- Global-only reconciliation — too broad for a single affected job and risks mutating unrelated stale jobs.
- Marking only the queue terminal during cancel — this caused split-brain state with durable job state and leases.
- Deleting worktrees or artifacts during cancel — this would reduce auditability.
- Passing executor/verifier evidence into external repair as authoritative input — this weakens independence and reproducibility.

### Files
- `/Users/chengwen/dev/flow/bridges/acp-client.mjs` — likely ACP child launch/policy injection surface; confirm exact ownership before editing.
- `/Users/chengwen/dev/flow/bridges/run-pipeline.mjs` — likely phase orchestration and cancel polling surface; confirm exact ownership before editing.
- `/Users/chengwen/dev/flow/server/services/project-lock.js` — lease ownership, heartbeat, expiry, and release behavior surfaced in the incident.
- `/Users/chengwen/dev/flow/server/services/job-store.js` — durable job terminal state convergence and cancel event persistence.
- `/Users/chengwen/dev/flow/server/services/*queue*.js` or equivalent queue service — queue terminal state and claim heartbeat consistency.
- `/Users/chengwen/dev/flow/cpb` and related CLI command modules — `cpb cancel`, status JSON, and scoped reconcile/recover command wiring.
- `/Users/chengwen/dev/flow/test`, `/Users/chengwen/dev/flow/tests`, or the repo's existing test directory — focused regression tests for the issue acceptance criteria.

### Evidence
- Issue #1 reports ACP verifier/fix lanes invoking `computer-use` against local UI apps during a CPB promotion-readiness run.
- Issue #1 reports `cpb cancel` setting cancel-requested state while active `fix-*` child processes, durable job state, and lease files did not converge without manual intervention.
- Issue #1 acceptance criteria require code-enforced ACP tool denial, repair evidence isolation, terminal cancellation, queue/durable/status consistency, scoped recovery, and heartbeat/status observability.

### Risks
- The exact queue, status, and lease modules may differ from the candidate paths above; first locate the existing command and service boundaries, then keep edits inside those boundaries.
- ACP tool-call interception may be implemented in a bridge protocol layer, launch config layer, or MCP/tool registry layer; choose the narrowest existing enforcement point that can deny before side effects occur.
- Process-group termination must avoid killing unrelated jobs; only signal children owned by the requested job and phase lineage.
- Tests that rely on fake ACP responders should not be loosened merely to pass; add purpose-built tests for policy denial and lifecycle convergence.
- `cpb status --json` may currently print mixed human text; preserve human output while making the advertised JSON mode machine-readable.

### Scope

**目标**: Implement the CPB fix for GitHub issue #1 only: ACP verifier/repair tool policy, cancellation convergence, scoped recovery, and heartbeat/status observability.

**涉及文件**:
- `/Users/chengwen/dev/flow/bridges/acp-client.mjs` — add or wire launch-time ACP tool policy enforcement and denial audit events.
- `/Users/chengwen/dev/flow/bridges/run-pipeline.mjs` — ensure phase execution observes cancel requests and terminates owned ACP children.
- `/Users/chengwen/dev/flow/server/services/project-lock.js` — release active phase leases for the cancelled job and expose heartbeat/expiry data.
- `/Users/chengwen/dev/flow/server/services/job-store.js` — persist terminal cancelled/failure events and converge durable job state.
- `/Users/chengwen/dev/flow/server/services/*queue*.js` — keep queue state consistent with durable job state and separate claim heartbeat from `updatedAt`.
- `/Users/chengwen/dev/flow/cpb` plus CLI command modules — implement or document one-job reconcile/recover and fix `status --json`.
- Existing test files under the repo test directory — add focused regression tests without broad fixture rewrites.

**实现步骤**:
1. Map the current CPB control-plane flow for `plan`, `execute`, `verify`, `fix-*`, external repair, `cancel`, status, queue claims, and leases. Record the exact files before editing and avoid unrelated refactors.
2. Introduce a small phase/lane policy preset module or local helper at the existing ACP launch boundary. The default policy must deny UI/desktop tools for `plan`, `verify`, external repair, and `fix-*`; `execute` remains non-UI by default unless an existing explicit UI/browser validation opt-in exists.
3. Enforce the policy before tool side effects. A denied verifier or repair call to `computer-use`, Browser, TextEdit, or desktop automation should return a controlled denial to the ACP child and append a compact CPB audit event containing job id, phase, agent, tool, and reason.
4. Update external repair launch/input construction so it receives locators such as job id, worktree path, log paths, and relevant code paths, but not a precomputed evidence payload presented as truth. Keep verifier evidence available only as an artifact/log the repair lane may independently read.
5. Make `cpb cancel <project> <jobId>` converge the requested job: set cancel requested, signal the owning runner/process group, propagate cancellation to active ACP children, append a terminal cancellation or explicit terminal failure event, release the active lease for that job, and update the queue entry consistently.
6. Add scoped recovery for one job, either `cpb jobs reconcile <project> <jobId>` or `cpb recover <project> <jobId> --terminal cancelled`. It must inspect only the requested job, its active phase lease, and its queue lineage, then converge stale state without touching unrelated jobs.
7. Update status surfaces. `cpb status --json` must emit valid JSON only, and include active phase, lease heartbeat timestamp, lease expiry timestamp, owner PID/process liveness, queue claim heartbeat, and queue `updatedAt` as separate fields.
8. Add focused tests for the five issue areas: ACP policy denial/audit event, repair input isolation, cancel during `fix-*`, queue/durable/lease consistency after cancel, and status heartbeat fields that do not rely on queue `updatedAt`.
9. Run the repo's normal test command plus the focused new tests. If a build or test command fails, fix the production issue rather than weakening fakes, snapshots, fixtures, or test doubles.

**注意事项**:
- Keep the change scoped to ACP verifier/repair tool policy, cancellation convergence, scoped recovery, and status/heartbeat observability.
- Do not introduce new dependencies unless the existing code has no suitable process, event, or JSON helpers.
- Prefer small helpers and existing service boundaries over broad architectural rewrites.
- Preserve existing artifacts and worktrees during cancel/recover.
- Do not alter unrelated promotion-readiness behavior.
- Avoid fake/mock test changes except where the fake itself must model the new policy or lifecycle contract.

## Next-Action
Implement the scoped CPB fix above, run focused and normal verification, then write `/Users/chengwen/dev/flow/wiki/projects/flow/outputs/deliverable-009.md` using the execute-to-review handoff format. Include changed files, test commands, outputs, audit event examples, and any remaining risks.

## Acceptance-Criteria
- [ ] ACP launch policy denies verifier `computer-use` and equivalent UI/desktop tool attempts before side effects occur.
- [ ] A denied ACP tool attempt is recorded as a CPB audit event with job id, phase, agent, tool, and denial reason.
- [ ] External repair is launched with locators/log-code context only, not an authoritative precomputed evidence payload.
- [ ] Cancelling a running `fix-*` phase terminates owned runner/ACP children and persists a terminal job state.
- [ ] After cancellation, there is no active lease for the cancelled job.
- [ ] After cancellation, queue status, durable job state, and `cpb status` agree on the terminal outcome.
- [ ] A scoped reconcile/recover command can converge one requested job without mutating unrelated stale jobs.
- [ ] `cpb status --json` emits valid machine-readable JSON.
- [ ] Status JSON separates active phase, lease heartbeat, lease expiry, owner PID/liveness, queue claim heartbeat, and queue `updatedAt`.
- [ ] Focused tests cover verifier tool denial, repair input isolation, cancel during `fix-*`, queue/durable consistency after cancel, and heartbeat/status observability.
- [ ] All relevant existing tests and new focused tests pass.
- [ ] Code style remains consistent with the existing project and the diff stays narrowly scoped.
