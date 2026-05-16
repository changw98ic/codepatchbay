# Runtime Namespace

CodePatchbay runtime data belongs under `cpb-task/`.

`.omc/` belongs to oh-my-claudecode and `.omx/` belongs to oh-my-codex. CodePatchbay
must not use either directory as a runtime root for new writes.

Current runtime roots:

- `cpb-task/events/` stores append-only durable job events.
- `cpb-task/leases/` stores live phase leases.
- `cpb-task/state/` stores compatibility pipeline status for `cpb status` and
  the UI watcher.
- `cpb-task/worktrees/` is reserved for CodePatchbay-managed worktrees.

Use `cpb migrate-runtime-root` once to copy legacy CodePatchbay-owned data out of
project-local `.omc/` paths. The migration command does not delete non-CodePatchbay
`.omc/` or `.omx/` data automatically.

Use `cpb migrate-runtime-root --quarantine-non-cpb` when the project root must
be cleaned completely. That mode moves remaining non-CodePatchbay `.omc/` and `.omx/`
directories into `cpb-task/legacy-quarantine/` instead of deleting their
contents.
