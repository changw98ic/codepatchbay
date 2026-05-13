# Unattended Supervisor

Flow unattended mode is designed for long-running work where a task may run for
24 hours or more and the operator may close terminals, restart the server, or
resume after a child process exits.

## Guarantees

- Job state is reconstructed from `flow-task/events/{project}/{jobId}.jsonl`.
- Active phases hold renewable leases under `flow-task/leases/`.
- Supervisor recovery treats missing or stale leases as resumable work.
- Code-writing phases can run in task git worktrees under `flow-task/worktrees/`.
- Budget and blocked states stop loops without deleting job history.

## Non-Guarantees

- Flow does not push to remotes without an explicit user request.
- Flow does not bypass blocked states for missing credentials or destructive actions.
- Flow does not silently auto-resolve merge conflicts.
- Flow does not delete failed worktrees as part of normal recovery.

## Commands

```bash
flow jobs
flow supervisor
flow pipeline <project> "<task>" 3 0
```

Use `flow jobs` to inspect durable jobs. Use `flow supervisor` to print
recoverable jobs from the durable event store. For supervisor-managed work, keep
the pipeline timeout at `0`; phase liveness is represented by child process
activity and lease heartbeats.

## Recovery

1. Run `flow jobs`.
2. Find jobs with `running`, `blocked`, or `failed` status.
3. Inspect `flow-task/events/{project}/{jobId}.jsonl`.
4. Inspect `flow-task/leases/` for missing or stale current leases.
5. Restart `flow supervisor`.
6. Resume from the next missing phase shown by the materialized job state.

## Safe Defaults

- Total timeout is disabled by default for supervisor-managed work.
- ACP idle timeout is activity-based and can be disabled with `FLOW_ACP_TIMEOUT_MS=0`.
- Budget limits block the job instead of deleting work.
- Worktrees are preserved on failure for manual inspection.
