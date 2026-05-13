# Runtime Namespace

Flow runtime data belongs under `flow-task/`.

`.omc/` belongs to oh-my-claudecode and `.omx/` belongs to oh-my-codex. Flow
must not use either directory as a runtime root for new writes.

Current runtime roots:

- `flow-task/events/` stores append-only durable job events.
- `flow-task/leases/` stores live phase leases.
- `flow-task/state/` stores compatibility pipeline status for `flow status` and
  the UI watcher.
- `flow-task/worktrees/` is reserved for Flow-managed worktrees.

Use `flow migrate-runtime-root` once to copy legacy Flow-owned data out of
project-local `.omc/` paths. The migration command does not delete non-Flow
`.omc/` or `.omx/` data automatically.

Use `flow migrate-runtime-root --quarantine-non-flow` when the project root must
be cleaned completely. That mode moves remaining non-Flow `.omc/` and `.omx/`
directories into `flow-task/legacy-quarantine/` instead of deleting their
contents.
