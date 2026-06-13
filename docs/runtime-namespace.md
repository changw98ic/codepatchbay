# Runtime Namespace

CodePatchbay runtime data lives under `cpb-task/`.

`.omc/` belongs to oh-my-claudecode and `.omx/` belongs to oh-my-codex. CodePatchbay
must not use either directory as a runtime root for new writes.

## Current runtime roots

- `cpb-task/events/{project}/{jobId}.jsonl` — append-only durable job event log.
- `cpb-task/checkpoints/` — job checkpoints used for crash recovery and resume.
- `cpb-task/jobs-index.json` — global job index (projection over events).
- `cpb-task/agent-homes/` — per-agent working/home directories.
- `cpb-task/evolve/` — evolve subsystem runtime data.
- `cpb-task/acp-audit/` — ACP session audit trails.
- `cpb-task/performance/` — performance traces.
- `cpb-task/codegraph-logs/` — codegraph index logs.

> Note: the legacy `cpb-task/leases/` and `cpb-task/state/` directories have been
> removed. Crash recovery is now checkpoint-based (see `cpb-task/checkpoints/`),
> not lease/heartbeat-based. The one-time `cpb migrate-runtime-root` command has
> been removed; runtime data must be written directly under `cpb-task/`.

## Boundary rule

Runtime modules (`runtime/`, `bridges/`) must not import `server/` directly. Any
server-owned collaborator they need is injected via the explicit assembly point
`bridges/runtime-services.ts`. See [runtime-boundaries.md](architecture/runtime-boundaries.md).
