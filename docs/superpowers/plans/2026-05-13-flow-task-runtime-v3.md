# Flow Task Runtime v3 Plan

> Single-system migration plan for Flow's 24h unattended task runtime.
> This supersedes the v2 plan by avoiding a parallel runtime and by making the
> first milestone a root migration, not a schema rewrite.

## Decision Summary

Flow needs its own runtime namespace, but it does not need a second runtime.

This plan chooses:

```text
runtime data root: flow-task/
runtime architecture: single-system evolution
MVP workflow: existing pipeline semantics, moved to flow-task/
automatic classification: deferred
profile config.yaml: deferred
lease implementation: reuse and relocate existing lease-manager
```

This plan explicitly rejects:

```text
parallel job-store + task-store runtimes
parallel materializeJob + materializeTask semantics in MVP
wiki YAML state records
.omc/ or .omx as Flow runtime roots
full multi-agent workflow as the default path
```

## Why v3 Exists

The previous v2 direction fixed the namespace and wiki-state problems, but it
introduced a new risk: a V1 job runtime and a V2 task runtime would coexist with
different event schemas, materializers, facades, tests, commands, and migration
paths.

That is not a compatibility migration. It is two systems.

v3 keeps one system and evolves it in safe slices:

1. Move the existing runtime root from `.omc/` to `flow-task/`.
2. Preserve the existing event schema and materialized shape during that move.
3. Rename and extend concepts only after compatibility is proven.
4. Add workflow/classification/profile richness later, behind explicit gates.

## Namespace Contract

Flow task runtime data lives under:

```text
flow-task/
```

Ownership:

```text
.omc/  belongs to oh-my-claudecode
.omx/  belongs to oh-my-codex
flow-task/ belongs to Flow
```

`flow-task/` must be added to `.gitignore`.

New Flow runtime writes must not target `.omc/` or `.omx/`.

Existing project-local `.omc/` data may be read only by an explicit migration
command or a temporary read-only compatibility path. There must be no dual-write
period.

After migration verification succeeds, project-local legacy Flow runtime data
under `.omc/` must be removed or quarantined. The expected end state for this
repository is that no project-local `.omc/` or `.omx/` directory remains.

Deletion must be conservative: because `.omc/` and `.omx/` are owned by other
tools, the migration command may delete only paths it can prove are legacy Flow
runtime data. If non-Flow data is detected, cleanup must stop and report the
paths for manual review instead of blindly deleting another tool's state.

## Runtime Directory Layout

Target layout:

```text
flow-task/
  events/
    {project}/
      {jobId}.jsonl

  leases/
    {leaseId}.json

  state/
    pipeline-{project}.json

  worktrees/
    {project}/
      {jobId}/

  provider-slots/
    {provider}/
      {jobId}.json

  logs/
    {project}/
      {jobId}/
        {phase}.log

  locks/

  tmp/
```

Note: `provider-slots/` is reserved for future use. The module
`provider-semaphore.js` exists but is not wired into production code. Skip its
migration until it is activated.

Important MVP detail: keep `jobId` naming in code and events until the root
migration is complete. A later compatibility change can expose `taskId` as a
user-facing alias, but MVP should not rename IDs and move roots at the same time.

## State Source Contract

### Event Log (authoritative for recovery)

The authoritative mutable state source for job recovery remains the append-only
event log:

```text
flow-task/events/{project}/{jobId}.jsonl
```

The MVP keeps the existing event store contract:

```text
appendEvent(flowRoot, project, jobId, event)
readEvents(flowRoot, project, jobId)
materializeJob(events)
```

### Pipeline State (progress indicator)

The legacy pipeline state file is a display-only progress tracker:

```text
flow-task/state/pipeline-{project}.json
```

Written by `run-pipeline.sh` via `common.sh` state functions.
Read by `watcher.js` (WebSocket push), `routes/projects.js` (REST API),
and `flow status` (CLI display).

This file is NOT a recovery mechanism. The supervisor does not read it.
It must still migrate to `flow-task/state/` so that all Flow runtime data
lives under one namespace.

### Do not add these in MVP

```text
server/services/task-event-store.js
server/services/task-store.js
materializeTask(events)
wiki/projects/*/tasks/*.yaml
```

The future `task-*` naming can be introduced as aliases after the single system
is already running on `flow-task/`.

## Current System Baseline

Current code has **two parallel state systems** that must both be migrated:

### System A: Durable Job (event-sourced)

Used by `job-runner.mjs` and the supervisor for crash recovery.

```text
server/services/event-store.js
server/services/job-store.js
server/services/lease-manager.js
server/services/supervisor.js
bridges/job-runner.mjs
bridges/run-pipeline.mjs
bridges/run-pipeline.sh
```

State source: `.omc/events/{project}/{jobId}.jsonl` (append-only).

### System B: Legacy Pipeline State (file-based)

Used by `run-pipeline.sh` for progress tracking during `flow pipeline`.

```text
bridges/common.sh           (state_read / state_write / state_init)
bridges/json-helper.mjs     (reads/writes pipeline-{project}.json)
server/services/watcher.js  (watches .omc/state/ for WebSocket push)
server/routes/projects.js   (reads state for REST API)
flow                        (cmd_status reads state for CLI display)
```

State source: `.omc/state/pipeline-{project}.json`.

Schema:
```json
{
  "project": "<name>",
  "task": "<description>",
  "started": "<ISO timestamp>",
  "phase": "plan",
  "retryCount": 0,
  "maxRetries": 3,
  "status": "running"
}
```

These two systems are **not synchronized**. `run-pipeline.sh` writes to
`.omc/state/` but not to `.omc/events/`. The supervisor's `recoverJobs()`
does not discover pipelines started by `run-pipeline.sh`. Both roots must
migrate to `flow-task/` to maintain all active behavior paths.

### Dead Code

```text
server/services/provider-semaphore.js   (not imported by any production code)
```

Do not migrate this module until it is wired into production. It is safe to
leave unchanged in Phase 4.

The current materialized job shape is the MVP compatibility shape:

```json
{
  "jobId": null,
  "project": null,
  "task": null,
  "status": null,
  "phase": null,
  "attempt": null,
  "workflow": null,
  "artifacts": {},
  "leaseId": null,
  "worktree": null,
  "createdAt": null,
  "updatedAt": null,
  "blockedReason": null
}
```

The current MVP event set remains valid:

```text
job_created
worktree_created
phase_started
phase_completed
phase_failed
budget_exceeded
job_blocked
job_failed
job_completed
```

The first migration must not change this contract except for the runtime root.

## v3 Principles

1. Move one boundary at a time.
2. Keep one event store and one materializer during MVP.
3. Keep `flow pipeline` as the main user path.
4. Treat classification as input, not magic, until real usage data exists.
5. Reuse tested lease semantics.
6. Separate state-changing events from activity/audit events.
7. Keep profiles thin until the runner has a real consumer for config.
8. Add tests before expanding event semantics.

## Rejected Alternatives

### Rejected: Parallel V2 Runtime

Creating `task-event-store.js`, `task-store.js`, `materializeTask()`, and a new
event schema while keeping the existing job runtime active would double the
maintenance surface.

Rejected because it would require duplicate routes, duplicate CLI behavior,
duplicate supervisor logic, duplicate tests, and unclear user commands.

### Rejected: Immediate Full Task Rename

Renaming `jobId` to `taskId` while moving the runtime root would make migration
harder to verify.

Rejected for MVP. Use `jobId` internally until root migration passes.

### Rejected: Rule-Based Auto Classification as Default

Automatic classification sounds cheap, but it still requires understanding task
scope, repo shape, risk, and verification cost.

Rejected for MVP. Use explicit workflow selection and a safe default.

### Rejected: Rewriting Lease Manager

The current lease manager already handles atomic creation, stale locks, renewal,
release, owner tokens, and tests.

Rejected for MVP. Relocate and parameterize it instead.

## MVP Scope

MVP means:

```text
flow pipeline still works
existing event schema still works
existing materializeJob shape still works
existing supervisor semantics still work
runtime writes go to flow-task/
tests prove old behavior survived the root migration
```

MVP does not include:

```text
automatic workflow classification
complex multi-agent workflow
new materializeTask shape
new task-store facade
profile config routing
parallel phase scheduling
wiki task YAML
```

## Workflow Selection in MVP

MVP should avoid automatic classification.

Default workflow:

```text
standard
```

Allowed explicit workflow input:

```text
flow pipeline <project> "<task>" --workflow standard
flow pipeline <project> "<task>" --workflow simple
flow pipeline <project> "<task>" --workflow blocked
```

If CLI compatibility makes flags awkward for the existing shell command, add the
flag first to the Node pipeline path and keep the shell wrapper forwarding it.

MVP guardrails may still block unsafe work:

```text
missing project -> blocked
missing required credential known before launch -> blocked
destructive explicit operation without authority -> blocked
invalid project path -> blocked
```

These guardrails are not a general classifier. They only prevent unsafe or
impossible execution.

Future automatic classification may be added after telemetry exists. It should
start as advisory:

```text
workflow_suggested
```

It should not decide the workflow until explicitly promoted by a later plan.

## Command Contract

`flow pipeline` remains the primary user-facing command.

Do not add `flow team-run` in MVP unless it is clearly marked experimental and
implemented as an alias over the same runtime.

Recommended MVP CLI:

```text
flow pipeline <project> "<task>" [max-retries] [timeout-min] [--workflow standard]
flow jobs
flow supervisor
```

Future CLI after task terminology is introduced:

```text
flow task run <project> "<task>"
flow task list
flow task show <project> <taskId>
```

But those commands must be aliases over the same store, not a second runtime.

## Lease Migration Plan

Do not redesign lease semantics in MVP.

Change only the lease root:

```text
from: .omc/leases/{leaseId}.json
to:   flow-task/leases/{leaseId}.json
```

Keep:

```text
atomic wx creation
lock directory around renewal/release
lock TTL stale detection
owner token verification
ownerHost and ownerPid metadata
retry/backoff behavior
lease-manager tests
```

Implementation direction:

```text
add runtimeRoot helpers
make leaseFileFor use flow-task/leases
preserve leaseId validation
preserve owner token behavior
preserve public acquire/read/renew/release API
```

Known limit:

The existing in-memory owner token cache is process-local. Cross-container or
multi-host execution is not an MVP target unless all processes share the same
filesystem and pass owner tokens explicitly.

If cross-container orchestration becomes a target, add a separate design for
external coordination storage or explicit token passing. Do not smuggle that
requirement into the root migration.

## Event Semantics After MVP

Before adding new event types, classify each event as one of:

```text
state
activity
audit
```

State events affect runtime decisions and must be materialized.

Activity events may update only:

```text
lastActivityAt
lastActivityMessage
```

Audit events are preserved but do not affect scheduling, completion, blocking,
or recovery.

Proposed post-MVP event additions:

| Event | Class | Materializer effect |
| --- | --- | --- |
| `workflow_selected` | state | Sets workflow and selection reason |
| `workflow_planned` | state | Sets phase graph |
| `phase_activity` | activity | Sets latest activity timestamp/message only |
| `verification_completed` | state | Sets verification verdict/artifact |
| `workflow_suggested` | audit | No runtime decision effect |

Do not add all of these in one change. Each event must come with tests and a
clear materializer rule.

## Profile Plan

MVP uses only role prompt files that the runner actually consumes:

```text
profiles/codex/soul.md
profiles/claude/soul.md
```

If new role names are needed for docs, add `soul.md` only:

```text
profiles/builder/soul.md
profiles/verifier/soul.md
```

Do not add `config.yaml` in MVP unless the runner reads it and a test proves its
effect.

Deferred profile files:

```text
config.yaml
user.md
memory.md
env.schema
skills/
variants/
```

Provider/model routing remains runtime configuration:

```text
FLOW_ACP_CODEX_COMMAND
FLOW_ACP_CODEX_ARGS
FLOW_ACP_CLAUDE_COMMAND
FLOW_ACP_CLAUDE_ARGS
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
ANTHROPIC_MODEL
```

Do not version hardcoded short-lived provider model variants in MVP.

## Wiki Contract

Wiki remains human-readable handoff and project memory.

Allowed:

```text
wiki/projects/{project}/inbox/plan-001.md
wiki/projects/{project}/outputs/deliverable-001.md
wiki/projects/{project}/outputs/verdict-001.md
wiki/projects/{project}/outputs/task-summary-001.md
wiki/projects/{project}/log.md
wiki/projects/{project}/decisions.md
```

Forbidden for machine state:

```text
wiki/projects/{project}/tasks/{taskId}/classification.yaml
wiki/projects/{project}/tasks/{taskId}/workflow.yaml
wiki/projects/{project}/tasks/{taskId}/status.yaml
```

If an operator needs a readable status report, generate markdown from events and
write it as an output artifact. It is a report, not a source of truth.

## Implementation Phases

### Phase 0: Plan Cleanup and Guardrails

1. Mark v2 as superseded by v3 or leave it as historical context.
2. Add `flow-task/` to `.gitignore`.
3. Add a short architecture note that `.omc/` and `.omx/` are not Flow runtime
   namespaces.
4. Add tests that fail if new Flow runtime writes target `.omc/events`,
   `.omc/leases`, or `.omc/state`.
5. Mark `provider-semaphore.js` as dead code (not imported by any production
   path). Do not migrate it.

Acceptance:

- New plan is discoverable.
- Runtime namespace rule is explicit.
- No production behavior changes yet.

### Phase 1: Runtime Root Helper

Add a tiny helper used by existing services:

```text
server/services/runtime-root.js
```

Suggested API:

```text
runtimeDataRoot(flowRoot) -> path.join(flowRoot, "flow-task")
runtimeDataPath(flowRoot, ...parts)
```

MVP should not make this configurable unless tests require temp roots. Existing
tests can still pass `flowRoot` as a temp directory.

Acceptance:

- Helper is covered by unit tests.
- No existing behavior changes until services adopt it.

### Phase 2: Move Event Store Root

Modify the existing event store:

```text
server/services/event-store.js
```

Change:

```text
from: path.resolve(flowRoot, ".omc", "events")
to:   runtimeDataPath(flowRoot, "events")
```

Keep:

```text
eventFileFor
appendEvent
readEvents
listEventFiles
materializeJob
existing event names
existing materialized shape
```

Optional read-only migration support:

```text
flow migrate-runtime-root
```

This command may copy existing `.omc/events` into `flow-task/events`, then stop.
Runtime code should not dual-write.

Acceptance:

- `tests/event-store.test.mjs` passes after expected path updates.
- `tests/job-store.test.mjs` passes.
- New event files are created under `flow-task/events`.
- No task-state writes go to `.omc/events`.
- `server/services/watcher.js` eventsWatcher glob updated from
  `.omc/events/*/*.jsonl` to `flow-task/events/*/*.jsonl`.

### Phase 2.5: Move Pipeline State Root

Move the legacy pipeline state file from `.omc/state/` to `flow-task/state/`.

Modify:

```text
bridges/common.sh           (state_read / state_write / state_init)
server/services/watcher.js   (stateWatcher glob)
server/routes/projects.js    (state file path in GET routes)
flow                         (cmd_status path)
```

In `common.sh`, change:

```text
from: $FLOW_ROOT/.omc/state/pipeline-${project}.json
to:   $FLOW_ROOT/flow-task/state/pipeline-${project}.json
```

In `watcher.js`, change the stateWatcher glob:

```text
from: .omc/state/pipeline-*.json
to:   flow-task/state/pipeline-*.json
```

In `routes/projects.js`, update the two state file reads.

In the `flow` CLI entry point, update `cmd_status` path (line ~105).

Do not change the pipeline state schema or semantics.

Acceptance:

- `flow pipeline` writes state to `flow-task/state/pipeline-{project}.json`.
- `flow status` reads from `flow-task/state/`.
- Watcher broadcasts `pipeline:update` events from `flow-task/state/`.
- REST API returns correct `pipelineState` from `flow-task/state/`.
- No state writes go to `.omc/state/`.

### Phase 3: Move Lease Root Without Changing Semantics

Modify:

```text
server/services/lease-manager.js
```

Change:

```text
from: path.resolve(flowRoot, ".omc", "leases")
to:   runtimeDataPath(flowRoot, "leases")
```

Do not change lease semantics.

Acceptance:

- `tests/lease-manager.test.mjs` passes.
- Lease files are created under `flow-task/leases`.
- Owner token mismatch tests still pass.
- Stale lock tests still pass.

### Phase 4: Move Adjacent Runtime Roots

Move other Flow-owned runtime roots:

```text
worktrees -> flow-task/worktrees
logs      -> flow-task/logs if runtime logs are introduced
locks     -> flow-task/locks if project locks are introduced
```

Skip `provider-slots` — `provider-semaphore.js` is not wired into production
(see Dead Code section in Current System Baseline). Do not migrate it until it
has a consumer.

Update `worktree-manager.mjs` `REQUIRED_IGNORES` to reference the new roots:

```text
from: ".omc/state/", ".omc/worktrees/"
to:   "flow-task/state/", "flow-task/worktrees/"
```

These are gitignore injection entries, not directory creation. They must match
the actual runtime root so that `flow-task/` directories are never accidentally
committed.

Do this only for code paths that already exist or are required by the MVP.

Acceptance:

- `tests/worktree-manager.test.mjs` passes after root update.
- `REQUIRED_IGNORES` references `flow-task/` instead of `.omc/`.
- No new `.omc/` runtime writes are introduced.

### Phase 5: Pipeline Compatibility on New Root

Keep command behavior stable:

```text
flow pipeline
flow jobs
flow supervisor
```

The behavior can be implemented through existing Node runtime pieces, but the
user-facing contract should remain stable.

Important correction:

Compatibility means command behavior, not freezing old internals. It is valid
to migrate `flow pipeline` internals to `flow-task/` as long as output,
artifacts, retries, and status semantics remain compatible.

Acceptance:

- `tests/flow-jobs.test.sh` passes.
- `tests/supervisor.test.mjs` passes.
- `tests/job-runner.test.mjs` passes.
- Route tests for pipeline still pass.
- A pipeline run writes events to `flow-task/events`.

### Phase 6: Explicit Workflow Input

Add explicit workflow selection only after root migration is stable:

```text
--workflow standard
--workflow simple
--workflow blocked
```

Default remains:

```text
standard
```

Do not add automatic classification in this phase.

Acceptance:

- Omitted workflow behaves exactly like today's standard pipeline.
- Explicit `standard` behaves the same as omitted workflow.
- Explicit `blocked` records a typed blocked event without launching agents.
- Tests cover CLI parsing and job state.

### Phase 7: Event Extension Gate

Only now consider new event semantics.

First event to add should be the smallest useful one, likely:

```text
workflow_selected
```

Do not add `workflow_planned`, `phase_activity`, and
`verification_completed` until each has a concrete consumer.

Acceptance for every new event:

- It is classified as state, activity, or audit.
- `materializeJob()` handles it if state/activity.
- Tests prove materialization.
- Supervisor behavior is unchanged or explicitly tested.

### Phase 8: Future Task Terminology

After root migration and event extension are stable, introduce task terminology
as aliases:

```text
taskId alias for jobId
materializeTask alias or wrapper over materializeJob
task commands as aliases over job store
```

This is not MVP.

Acceptance:

- Existing job APIs still work.
- New task aliases call the same underlying store.
- There is still one event log and one materializer contract.

## Test Migration Matrix

| Test file | MVP treatment |
| --- | --- |
| `tests/event-store.test.mjs` | Update expected root from `.omc/events` to `flow-task/events`; preserve event schema assertions |
| `tests/job-store.test.mjs` | Keep existing job API assertions; ensure files land under `flow-task/events` |
| `tests/lease-manager.test.mjs` | Preserve all lease semantics; update expected root only |
| `tests/supervisor.test.mjs` | Preserve recovery behavior; update fixtures to `flow-task/events` |
| `tests/job-runner.test.mjs` | Preserve phase start/complete/fail behavior on new root |
| `tests/provider-semaphore.test.mjs` | **Skip** — module is dead code, not wired into production |
| `tests/worktree-manager.test.mjs` | Update `REQUIRED_IGNORES` assertions from `.omc/` to `flow-task/` |
| `tests/routes-tasks.test.mjs` | Update `.omc/state` and `.omc/events` fixture paths to `flow-task/` |
| `tests/routes-projects.test.mjs` | Update `.omc/state` fixture path to `flow-task/state` |
| `tests/flow-jobs.test.sh` | Update fixture paths from `$TMP/.omc/events/` to `$TMP/flow-task/events/`; preserve CLI output semantics |
| `tests/flow-bridges.test.sh` | Preserve bridge behavior unless bash state helpers are removed |
| `tests/flow-variant-env.test.sh` | No change unless provider routing changes |
| `tests/acp-client.test.mjs` | No root migration changes expected |
| `tests/executor.test.mjs` | No root migration changes expected unless running task registry changes |

New tests:

```text
tests/runtime-root.test.mjs
tests/runtime-root-no-omc-writes.test.mjs
tests/workflow-selection.test.mjs
```

The no-omc-writes test should exercise event, lease, state, and worktree paths
where practical. It must assert that no new writes target `.omc/events`,
`.omc/leases`, `.omc/state`, or `.omc/worktrees`.

Note on test migration approach: since `.omc` paths are hardcoded inline in
tests (no shared path utility), the correct approach is to first change the
source modules (event-store, lease-manager, common.sh) to use `flow-task/`,
then update test assertions to match. Do not create a path abstraction layer
for tests — let the source modules own their paths.

## Migration From Existing Data

Existing Flow-created data may exist under `.omc/`.

MVP should provide an explicit command:

```text
flow migrate-runtime-root
```

Behavior:

1. Detect `.omc/events`, `.omc/state`, and `.omc/worktrees`.
2. Copy Flow-owned durable data into `flow-task/`.
3. Do not copy `.omc/leases` or lock directories. Leases are liveness hints and
   must be recreated by the new runtime.
4. Do not merge conflicting files automatically.
5. Verify copied event/state/worktree data before cleanup.
6. Delete or quarantine migrated Flow-owned legacy paths after verification.
7. Delete the project-local `.omc/` directory only if it is empty or contains
   only migrated Flow-owned legacy paths.
8. Delete the project-local `.omx/` directory only if it exists and is empty or
   contains only Flow-owned legacy paths. Otherwise leave it untouched and report
   why it was retained.
9. Report copied, skipped, conflicted, deleted, quarantined, and retained paths.

Note: `.omc/state/pipeline-*.json` files are the most likely to have real user
data (written by every `flow pipeline` run). Events are populated by the durable
job system which may not have been used yet. Leases must not be migrated because
old lease files can create false liveness, stale owner-token failures, or delayed
recovery.

This command is a one-time migration and cleanup aid, not part of normal runtime
reads.

## Performance Contract

MVP should not add extra agent invocations.

The default path remains one standard pipeline:

```text
plan -> execute -> verify/fix
```

Do not add an LLM coordinator before this path.

Measure:

```text
event append duration
materializeJob duration
lease acquire/renew/release duration
pipeline wall time
supervisor recovery duration
ACP spawn/init duration
```

Performance success for MVP:

```text
root migration adds no meaningful wall-clock overhead to pipeline execution
```

## Acceptance Criteria

MVP is complete when:

- `flow-task/` is ignored by git.
- Existing event schema works under `flow-task/events`.
- Existing lease semantics work under `flow-task/leases`.
- Pipeline state writes to `flow-task/state/` (not `.omc/state/`).
- Watcher broadcasts from `flow-task/events/` and `flow-task/state/`.
- `flow pipeline` behavior remains compatible.
- `flow status` reads from `flow-task/state/`.
- `flow jobs` reads from the new event root.
- `flow supervisor` recovers from the new event root.
- `worktree-manager.mjs` `REQUIRED_IGNORES` references `flow-task/`.
- No MVP production code creates new Flow runtime state under `.omc/` or `.omx/`.
- Migration cleanup removes or quarantines project-local legacy Flow runtime
  paths under `.omc/`.
- The repository has no project-local `.omc/` or `.omx/` directory after a clean
  migration, unless cleanup retained non-Flow data and reported it explicitly.
- No wiki YAML task state files are introduced.
- Existing tests are updated rather than abandoned.
- New root-specific tests prove the namespace migration.

## Post-MVP Roadmap

### V1: Workflow Selection

- Add explicit `--workflow`.
- Add `workflow_selected` event.
- Keep default `standard`.
- Keep automatic classification disabled.

### V2: Phase Graph

- Add `workflow_planned` only when the supervisor and runner consume it.
- Extend `materializeJob()` with a phase graph.
- Keep old phase fields as compatibility projections.

### V3: Task Terminology

- Add `taskId` aliases.
- Add `flow task ...` commands as aliases.
- Consider renaming `materializeJob` only after all consumers are migrated.

### V4: Optional Automation

- Add advisory classifier.
- Add read-only phase parallelism.
- Add richer profile configs only when the runner consumes them.

## Implementation Notes

- Root migration should be a small, reviewable diff.
- Do not introduce `task-store.js` until there is a concrete reason to rename
  or wrap `job-store.js`.
- Do not introduce `config.yaml` until there is a runtime reader and tests.
- Do not introduce `flow team-run` as a separate path in MVP.
- Keep all state-changing behavior append-only through the existing event
  store.
- If a future plan chooses a V2 rewrite instead, it must explicitly freeze V1
  and name the cost of maintaining both systems.
