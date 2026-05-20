VERDICT: PARTIAL

Static verification only. I read deliverable-003.md, the referenced plan-009.md, and inspected the current implementation files in the job worktree. I did not run tests or terminal commands because this verification phase forbids terminal execution.

What passed:
- The deliverable matches the plan scope for GitHub issue #1.
- Phase/lane policy exists and is wired into run-pipeline and job-runner with CPB_ACP_DENY_TOOLS, CPB_JOB_ID, and CPB_PHASE.
- acp-client emits structured [cpb-audit] JSON before dispatch when an exact denied message.method is received.
- Verify is launched with project + deliverable id, and repair/fix paths use locators rather than inline precomputed evidence payloads.
- Durable cancellation records terminal cancelled state, and reconcileOneJob targets the requested job instead of globally reconciling all jobs.
- cpb exposes scoped recover/reconcile commands and status --json includes active phase, lease heartbeat/expiry/owner liveness, and queue claim/update fields.

What failed or remains incomplete:
- ACP UI tool denial is exact-match on message.method. The denied names are computer-use, browser, text_edit, and desktop_automation, but the client does not inspect actual tool-call params/names. I cannot verify this blocks real ACP/MCP UI tools before side effects unless they arrive with exactly those method names.
- cancel-redirect.mjs can update every in_progress queue entry for the same project when originJobId is absent, so cancelling one job can mutate unrelated jobs.
- The deliverable itself notes lease release is not guaranteed on owner-token failure. Static code confirms release failures are swallowed, while the plan requires no active lease after cancellation.
- Process termination is best effort. job-runner aborts child bridges on SIGTERM, but run-pipeline does not show an equivalent shutdown handler around detached bridge children, so owned ACP child termination is not fully proven.
- The broader test evidence is not complete as written: the deliverable reports 44/45 existing tests passing, not a fresh all-pass result.

Next:
- Tighten ACP policy matching to the actual protocol shape, including MCP/tool-call params and aliases.
- Make queue cancellation/status matching lineage-specific only.
- Guarantee target-job lease cleanup after cancellation, or reconcile it immediately and visibly.
- Re-run focused and full test suites after those fixes.
