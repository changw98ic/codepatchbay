# Flow Task Runtime v2 Plan

> Replacement plan for Flow's 24h unattended fixed-role task runtime.
> This plan intentionally keeps Flow runtime state out of `.omc/` and `.omx/`.

## Goal

Make Flow capable of running long-lived project tasks with durable recovery,
role-based phases, and optional multi-agent escalation while keeping task state
simple and auditable.

The central correction is namespace ownership:

```text
.omc/  belongs to oh-my-claudecode
.omx/  belongs to oh-my-codex
Flow task runtime data belongs to flow-task/
```

Flow task state must not depend on wiki YAML files, profile files, `.omc/`, or
`.omx/`.

## Non-Goals

- Do not store Flow task runtime state under `.omc/`.
- Do not store Flow task runtime state under `.omx/`.
- Do not create machine-state YAML files under `wiki/projects/*/tasks/`.
- Do not make every task run through a full multi-agent workflow.
- Do not keep one agent process alive for 24 hours.
- Do not push code to remotes automatically.
- Do not auto-resolve merge conflicts silently.
- Do not store API keys, tokens, or raw credentials in profiles, wiki files, or
  event logs.

## Runtime Data Root

All Flow task runtime data lives under:

```text
flow-task/
```

Recommended layout:

```text
flow-task/
  events/
    {project}/
      {taskId}.jsonl

  leases/
    {project}/
      {taskId}/
        {phaseId}.json

  worktrees/
    {project}/
      {taskId}/

  logs/
    {project}/
      {taskId}/
        {phaseId}.log

  locks/
    project-{project}.lock/

  tmp/
```

Directory semantics:

| Directory | Purpose | Authoritative for task state |
| --- | --- | --- |
| `flow-task/events/` | Append-only task event logs | Yes |
| `flow-task/leases/` | Process leases and heartbeats | No |
| `flow-task/worktrees/` | Task-isolated git worktrees | No |
| `flow-task/logs/` | stdout/stderr attachments | No |
| `flow-task/locks/` | Local coordination locks | No |
| `flow-task/tmp/` | Temporary files | No |

`flow-task/` should be ignored by git.

## State Model

The event log is the only authoritative mutable task state:

```text
flow-task/events/{project}/{taskId}.jsonl
```

All state changes go through:

```text
appendTaskEvent(flowRoot, project, taskId, event)
```

All reads materialize state from events:

```text
events = readTaskEvents(flowRoot, project, taskId)
state = materializeTask(events)
```

Forbidden state sources:

```text
flow-task/state/*.json
wiki/projects/*/tasks/*.yaml
profiles/* current task state
.omc/*
.omx/*
```

If UI performance later requires caching, the cache must be a rebuildable
projection from `flow-task/events/`. Runtime correctness must not depend on the
cache.

## Event Contract

MVP event types:

```text
task_created
task_classified
workflow_planned
worktree_created
phase_started
phase_activity
phase_completed
phase_failed
phase_blocked
verification_completed
task_blocked
task_failed
task_completed
```

Rules:

- Every event is one JSON object per line.
- Every event includes `type`, `taskId`, `project`, and `ts` unless the helper
  fills them.
- Every event type that affects task state must be handled by
  `materializeTask()`.
- Adding a new event type requires a materializer update and tests in the same
  change.
- Unknown event types may be preserved for audit, but they must not be required
  for runtime decisions until materialized.

## Materialized Task Shape

`materializeTask(events)` should return a stable object:

```json
{
  "taskId": null,
  "project": null,
  "task": null,
  "status": null,
  "classification": null,
  "workflow": null,
  "phaseGraph": [],
  "currentPhaseId": null,
  "currentRole": null,
  "attempt": null,
  "artifacts": {},
  "verification": null,
  "worktree": null,
  "leaseId": null,
  "createdAt": null,
  "updatedAt": null,
  "lastActivityAt": null,
  "blockedReason": null
}
```

Expected status values:

```text
created
classified
planned
running
blocked
failed
completed
```

## Task Lifecycle

### 1. Create Task

Creating a task appends only `task_created`:

```json
{
  "type": "task_created",
  "project": "demo",
  "taskId": "task-20260513-120000-abc123",
  "task": "Add login flow",
  "ts": "2026-05-13T12:00:00.000Z"
}
```

### 2. Classify Task

MVP coordinator classification is deterministic and rule-based. It does not call
an LLM by default.

Classification rules:

| Classification | Use when |
| --- | --- |
| `simple` | Read-only lookup, explanation, tiny docs, or one-command check |
| `standard` | Focused code change with clear acceptance criteria |
| `complex` | Multi-module, architecture, security, migration, new dependency, or unclear design |
| `blocked` | Missing credential, destructive authority, irreversible action, or missing critical decision |

Classification appends `task_classified`:

```json
{
  "type": "task_classified",
  "classification": "standard",
  "workflow": "builder_then_verifier",
  "roles": ["builder", "verifier"],
  "risk": "low",
  "reasons": ["clear_scope", "code_change_expected"],
  "ts": "2026-05-13T12:00:01.000Z"
}
```

Optional future LLM classification may emit advisory events, but the MVP runtime
decision remains rule-based:

```text
classifier_suggested
```

That advisory event must not become authoritative unless the plan explicitly
upgrades the contract.

### 3. Plan Workflow

The workflow planner expands classification into a phase graph and appends
`workflow_planned`:

```json
{
  "type": "workflow_planned",
  "workflow": "builder_then_verifier",
  "phases": [
    { "id": "build", "role": "builder", "dependsOn": [] },
    { "id": "verify", "role": "verifier", "dependsOn": ["build"] }
  ],
  "ts": "2026-05-13T12:00:02.000Z"
}
```

The MVP runner may execute serially, but the phase graph must exist from the
start so later read-only parallelism does not require a runner rewrite.

### 4. Run Phase

Starting a phase appends `phase_started` and writes a lease file:

```json
{
  "type": "phase_started",
  "phaseId": "build",
  "role": "builder",
  "leaseId": "lease-task-20260513-120000-abc123-build",
  "attempt": 1,
  "ts": "2026-05-13T12:00:03.000Z"
}
```

Progress may append `phase_activity`:

```json
{
  "type": "phase_activity",
  "phaseId": "build",
  "message": "tests running",
  "ts": "2026-05-13T12:03:00.000Z"
}
```

Completing a phase appends `phase_completed`:

```json
{
  "type": "phase_completed",
  "phaseId": "build",
  "artifact": "wiki/projects/demo/outputs/deliverable-001.md",
  "ts": "2026-05-13T12:10:00.000Z"
}
```

Failing a phase appends `phase_failed`:

```json
{
  "type": "phase_failed",
  "phaseId": "build",
  "error": "child exited with 1",
  "ts": "2026-05-13T12:10:00.000Z"
}
```

Blocking a phase appends `phase_blocked`:

```json
{
  "type": "phase_blocked",
  "phaseId": "build",
  "reason": "missing credential: GITHUB_TOKEN",
  "ts": "2026-05-13T12:10:00.000Z"
}
```

### 5. Verify

Verification appends `verification_completed`:

```json
{
  "type": "verification_completed",
  "phaseId": "verify",
  "verdict": "PASS",
  "artifact": "wiki/projects/demo/outputs/verdict-001.md",
  "ts": "2026-05-13T12:15:00.000Z"
}
```

### 6. Finish Task

Successful completion appends `task_completed`:

```json
{
  "type": "task_completed",
  "summary": "Implemented and verified login flow.",
  "ts": "2026-05-13T12:16:00.000Z"
}
```

Terminal failure appends `task_failed`; user/action blockers append
`task_blocked`.

## Lease Rules

Lease files live under:

```text
flow-task/leases/{project}/{taskId}/{phaseId}.json
```

Leases answer only one question:

```text
Is a process probably still executing this phase?
```

Leases must not decide:

- task completion
- task failure
- task blocking
- workflow selection
- classification
- phase completion

Those decisions come only from events.

Supervisor recovery flow:

```text
1. Scan flow-task/events/*/*.jsonl
2. Materialize each task
3. Skip completed, failed, and blocked tasks
4. If a phase is running, inspect the phase lease
5. Fresh lease means the phase is still active
6. Missing or stale lease means recovery is allowed
7. Append a recovery-related event before retrying or resuming
```

## Wiki Contract

The wiki remains human-readable project memory and handoff space.

Allowed task artifacts:

```text
wiki/projects/{project}/inbox/plan-001.md
wiki/projects/{project}/outputs/deliverable-001.md
wiki/projects/{project}/outputs/verdict-001.md
wiki/projects/{project}/outputs/task-summary-001.md
wiki/projects/{project}/log.md
wiki/projects/{project}/decisions.md
```

Not allowed:

```text
wiki/projects/{project}/tasks/{taskId}/classification.yaml
wiki/projects/{project}/tasks/{taskId}/workflow.yaml
wiki/projects/{project}/tasks/{taskId}/status.yaml
```

If operators need a readable task summary, generate a markdown report from
events and write it as an output artifact. That markdown is a report, not a
state source.

## Profile MVP

MVP profiles are deliberately thin:

```text
profiles/{role}/
  soul.md
  config.yaml
```

Deferred until real need:

```text
user.md
memory.md
env.schema
skills/
variants/
```

`config.yaml` declares role capabilities and runtime requirements, not concrete
provider or model names:

```yaml
role: builder
capabilities:
  - code_write
  - test_run
runtime_requirements:
  context: long
  filesystem: write
provider_policy: runtime_resolved
```

Concrete provider/model selection is resolved at runtime from environment or an
ignored local config:

```text
FLOW_ROLE_BUILDER_PROVIDER=claude-code
FLOW_ROLE_BUILDER_MODEL=...
```

Versioned profiles must not hardcode short-lived model names unless the file is
explicitly a local, ignored runtime override.

## Workflow Levels

Multi-agent orchestration is an escalation path, not the default for every task.

```text
simple:
  coordinator rule classify -> one selected role

standard:
  coordinator -> builder -> verifier

complex:
  coordinator -> researcher -> planner -> builder -> reviewer -> fix loop -> verifier -> writer

blocked:
  coordinator -> ask for missing decision or authority
```

MVP implements `simple`, `standard`, and `blocked`. `complex` may be specified
but can remain unavailable until V2.

## Concurrency Policy

MVP execution may be serial.

The public runner interface must still be phase-graph based:

```text
runPhase({ project, taskId, phaseId, role, worktree, profileSpec })
```

Future concurrency rules:

- Read-only phases may run concurrently after their dependencies are complete.
- Code-writing phases must run in task worktrees.
- One task has one active writer by default.
- Integration into the primary project directory requires a project-level lock.
- Provider semaphores limit concurrent use of the same provider.

This preserves a path to parallelism without rewriting the role phase runner.

## Performance Strategy

The coordinator MVP is rule-based to avoid paying model latency for every task.

Expected performance posture:

| Task shape | Runtime cost | Policy |
| --- | --- | --- |
| `simple` | One agent invocation or less | Avoid full team |
| `standard` | Builder plus verifier | Default for focused code work |
| `complex` | Multiple agent invocations | Use only when risk justifies cost |

Metrics to record from the start:

```text
task.created -> task.completed wall time
phase queued/running/completed duration
ACP spawn and initialize duration
provider queue wait
verification fail count
fix loop count
supervisor recovery duration
event append p95
materializeTask p95
```

## API Surface

Add a Flow task store module:

```text
server/services/task-event-store.js
```

Suggested exports:

```text
taskEventFileFor(flowRoot, project, taskId)
appendTaskEvent(flowRoot, project, taskId, event)
readTaskEvents(flowRoot, project, taskId)
listTaskEventFiles(flowRoot)
materializeTask(events)
```

Add a task store facade:

```text
server/services/task-store.js
```

Suggested exports:

```text
createTask(flowRoot, { project, task })
classifyTask(flowRoot, project, taskId, classification)
planWorkflow(flowRoot, project, taskId, phaseGraph)
startPhase(flowRoot, project, taskId, phase)
completePhase(flowRoot, project, taskId, result)
failPhase(flowRoot, project, taskId, result)
blockPhase(flowRoot, project, taskId, result)
completeTask(flowRoot, project, taskId, result)
failTask(flowRoot, project, taskId, result)
blockTask(flowRoot, project, taskId, result)
getTask(flowRoot, project, taskId)
listTasks(flowRoot)
```

## CLI and Routes

MVP CLI additions:

```text
flow team-run <project> "<task>"
flow tasks
flow task <project> <taskId>
flow supervisor
```

Compatibility commands remain stable:

```text
flow plan
flow execute
flow verify
flow pipeline
```

`flow pipeline` should not be rewritten until `flow team-run` is stable.

## Migration Plan

### MVP

1. Add `flow-task/` to `.gitignore`.
2. Add `task-event-store.js` backed by `flow-task/events/`.
3. Add `materializeTask()` and event coverage tests.
4. Add deterministic coordinator classification.
5. Add workflow planner for `simple`, `standard`, and `blocked`.
6. Add thin profile loader for `soul.md` and `config.yaml`.
7. Add role phase runner with phase graph input.
8. Add `flow team-run <project> "<task>"`.
9. Keep existing `flow pipeline` behavior unchanged.

### V1

1. Teach supervisor to resume phase graphs from `flow-task/events/`.
2. Move leases, logs, locks, provider slots, and worktrees under `flow-task/`.
3. Add UI/CLI task state display from `materializeTask()`.
4. Add task worktree creation for write phases.
5. Add provider semaphore integration.

### V2

1. Add complex workflow execution.
2. Add concurrent read-only phase scheduling.
3. Add optional LLM classifier as advisory or explicitly approved mode.
4. Add richer profile files only where needed.
5. Add rebuildable projection cache if event materialization becomes expensive.

## Acceptance Criteria

MVP is complete only when:

- `flow-task/events/` is the only authoritative Flow task state source.
- New Flow task runtime code does not write task state to `.omc/` or `.omx/`.
- New Flow task runtime code does not write wiki YAML state files.
- `materializeTask()` handles every MVP event type.
- Tests cover every state-changing event type.
- Deterministic coordinator rules are tested.
- Standard workflow can run `builder -> verifier`.
- Blocked workflow produces a typed blocked state.
- Supervisor can recover from event logs and stale leases.
- `flow pipeline` remains compatible during migration.
- `flow team-run` is available as the new task-runtime entry point.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Reintroducing multiple state sources | Make `appendTaskEvent()` the only mutable task-state write API |
| Wiki schema drift | Keep machine state out of wiki and generate markdown reports only |
| Coordinator latency | Use deterministic classification in MVP |
| Profile overgrowth | Start with `soul.md` and `config.yaml` only |
| Provider/model churn | Resolve provider/model from runtime config, not versioned profiles |
| Parallelism rewrite | Use phase graph and phase-scoped runner API from MVP |
| Lease/state confusion | Treat leases as liveness hints only |
| Migration breakage | Keep `flow pipeline` unchanged until `team-run` is proven |

## Implementation Notes

- Existing docs that mention `.omc/state`, `.omc/events`, or wiki YAML task
  records should be updated after this plan is accepted.
- Existing runtime code may continue to exist during migration, but new Flow
  task runtime code should target `flow-task/`.
- Use explicit names: `taskId`, `phaseId`, and `materializeTask`, not `jobId`
  or `materializeJob`, for the v2 task runtime.
