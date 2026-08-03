# Runtime Namespace

CodePatchBay has one runtime namespace: the registered Hub project runtime
root. The source repository and its runtime state are separate trees.

The CLI bootstrap root (`CPB_ROOT`) defaults to `CPB_HOME`, or `~/.cpb` when
`CPB_HOME` is unset. `CPB_EXECUTOR_ROOT` points to the installed `dist`
directory. Neither an installed package directory nor a source checkout is an
implicit data root.

For a Hub at `<hub>` and project id `<project>`:

```text
<source-repository>/                    # git worktree / user source
<hub>/projects/<project>/                # canonical project runtime root
├── wiki/                                # context, inbox, outputs, project.json
├── events/<project>/<job-id>.jsonl      # durable job event streams
├── checkpoints/<project>/<job-id>.json  # canonical recovery checkpoints
├── worktrees/                           # managed task worktrees
├── leases/                              # active job leases
├── state/                               # pipeline state
├── jobs-index.json                      # project job projection
├── agent-homes/                         # isolated agent homes
├── acp-audit/                           # ACP audit records
├── performance/                         # performance records
└── evolve/                              # project evolve state
```

Every runtime read and write receives this explicit project root from the Hub
registry. The source repository is never used as an implicit runtime root, and
there is no global project-data fallback.

## Cutover rule

Retired flat namespaces are outside the current runtime contract. CPB does not
read, migrate, or delete them. A deployment must provision/register the
canonical project runtime root before normal work starts; old data must be
handled outside CPB if it needs to be retained.

## Boundary rule

Runtime modules (`runtime/`, `bridges/`) must not import `server/` directly. Any
server-owned collaborator they need is injected via the explicit assembly point
`bridges/runtime-services.ts`. See [runtime-boundaries.md](architecture/runtime-boundaries.md).
