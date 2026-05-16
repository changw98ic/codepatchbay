# 24h Unattended Fixed-Role Agents Implementation Plan

> Plan for combining CodePatchbay's durable 24h supervisor with profile-defined fixed agent roles.

## Goal

Make CodePatchbay capable of running project tasks for 24 hours or more with a stable team structure:

- `coordinator` remains the single entry router.
- Role identity and permissions come from `profiles/{role}/`.
- Long-running reliability comes from durable jobs, event logs, leases, worktrees, and supervisor recovery.
- ACP remains the runtime boundary for Codex, Claude Code, and provider variants.

The important distinction:

```text
fixed role = durable profile contract
agent process = disposable ACP invocation for one phase
supervisor = long-running recovery engine
```

## Non-Goals

- Do not keep one coordinator process alive for 24 hours.
- Do not push code to remotes automatically.
- Do not auto-resolve merge conflicts silently.
- Do not store API keys, tokens, or service credentials inside profiles or wiki files.
- Do not bypass `blocked` states for missing credentials, destructive actions, or irreversible operations.

## Current Baseline

CodePatchbay already has:

- ACP client and Codex/Claude adapter launch path.
- Plan -> execute -> verify bridge scripts.
- Durable job/event foundations.
- Lease heartbeat and supervisor recovery.
- Task-level git worktree manager.
- Draft team PRD and team architecture docs.

The next step is to generalize the current provider-specific phases into role/profile-driven phases.

## Target Runtime Shape

```text
user request
  -> coordinator classify
  -> workflow planner expands phases
  -> durable job created
  -> supervisor claims next phase lease
  -> profile loader resolves role + variant
  -> ACP launcher starts disposable agent process
  -> agent writes artifact + event log
  -> supervisor schedules next phase
  -> verifier/writer/final summary
```

For recovery:

```text
server restart or child process exit
  -> supervisor reads .omc/events/{project}/{jobId}.jsonl
  -> materializes job state
  -> checks active leases
  -> resumes from the next missing or failed phase
```

## Required Roles

| Role | Owns | Must Not Do |
| --- | --- | --- |
| `coordinator` | classification, workflow selection, role assignment, escalation | production code changes |
| `researcher` | project scan, evidence, dependency/context summary | final architecture decision |
| `planner` | implementation plan, acceptance criteria, risk model | production code changes |
| `builder` | implementation, local tests, deliverable report | final approval |
| `reviewer` | correctness and maintainability review | unreviewed direct merge |
| `verifier` | final PASS/FAIL/PARTIAL verdict | implementation |
| `writer` | README, migration notes, release notes, summaries | implementation |
| `security` | secrets, auth, filesystem, command, network risk review | product implementation |

## Profile Contract

Each role should support:

```text
profiles/{role}/
  soul.md
  user.md
  memory.md
  config.yaml
  env.schema
  skills/
  variants/
    {variant}.yaml
```

### Profile Semantics

- `soul.md`: who the role is, what it owns, what it refuses.
- `user.md`: user preferences from this role's perspective.
- `memory.md`: reusable long-term role experience, never current project state.
- `config.yaml`: runtime, model defaults, directories, permissions, forbidden paths.
- `env.schema`: names of required env vars only, no raw values.
- `skills/`: reusable role procedures.
- `variants/*.yaml`: provider/model/env overlays.

Secrets are resolved from shell env or ignored local secret files at launch time.

## Provider Variants

Claude Code based roles must support temporary environment overlays:

| Variant | Provider | Intended Use |
| --- | --- | --- |
| `glm5.1` | z.ai | general builder, broad coding tasks |
| `kimi-k2.6` | OllamaCloud | long context, repo scanning, implementation |
| `mimo-v2.5pro` | Xiaomi | alternate coding/review route |

Variant overlays map provider env into Claude Code compatible env:

```yaml
variant: kimi-k2.6
provider: ollamacloud
model: kimi-k2.6
env:
  ANTHROPIC_BASE_URL: ${OLLAMACLOUD_BASE_URL}
  ANTHROPIC_AUTH_TOKEN: ${OLLAMACLOUD_API_KEY}
  ANTHROPIC_MODEL: kimi-k2.6
  ANTHROPIC_CUSTOM_MODEL_OPTION: kimi-k2.6
```

## Durable State Model

### Event Log

Append-only event log:

```text
.omc/events/{project}/{jobId}.jsonl
```

Required event types:

```text
job_created
task_classified
workflow_planned
worktree_created
phase_started
phase_activity
phase_completed
phase_failed
phase_blocked
verification_completed
job_completed
job_blocked
```

### Materialized State

Optional cache:

```text
.omc/state/{project}/{jobId}.json
```

The event log is the source of truth. State files are for UI speed and operator inspection.

### Wiki Task Record

Inspectable task state:

```text
wiki/projects/{project}/tasks/{task-id}/classification.yaml
wiki/projects/{project}/tasks/{task-id}/workflow.yaml
wiki/projects/{project}/tasks/{task-id}/status.yaml
```

Artifacts remain in existing handoff locations unless migrated later:

```text
wiki/projects/{project}/inbox/
wiki/projects/{project}/outputs/
```

## Liveness Rules

A phase is alive when any of these are true:

- ACP stdout/stderr produced recent output.
- ACP JSON-RPC session update arrived.
- The role process wrote a `phase_activity` event.
- The lease heartbeat is fresh.

`CPB_ACP_TIMEOUT_MS=0` disables idle timeout entirely.

For unattended runs, total wall-clock timeout should not kill the process. Budget exhaustion should mark the job `blocked` with a reason.

## Concurrency Model

### Project-Level Policy

- Multiple read-only phases may run concurrently.
- Code-writing phases must use task worktrees.
- Integration into the primary project directory requires a project-level merge lock.
- A single task should have one active writer worktree by default.

### Role-Level Policy

- `researcher`, `reviewer`, `security`, and `writer` may run in parallel when their inputs are stable.
- `builder` fix loops should be serialized per task worktree.
- `verifier` runs after builder/reviewer required artifacts exist.
- `coordinator` runs at routing, escalation, and final summary checkpoints.

### Provider-Level Policy

Add provider semaphores so one provider outage or rate limit does not freeze all work:

```text
provider:codex
provider:claude-code
provider:zai
provider:ollamacloud
provider:xiaomi
```

## Workflow Policies

### Simple

```text
coordinator -> selected role -> light verification -> result
```

Use for scans, explanations, tiny docs, or one-command checks.

### Standard

```text
coordinator -> builder -> verifier -> result
```

Use for focused implementation with clear acceptance criteria.

### Complex

```text
coordinator
  -> researcher
  -> planner
  -> builder
  -> reviewer
  -> builder fix loop
  -> verifier
  -> writer
  -> coordinator final summary
```

Use for features, refactors, unclear requirements, protocol changes, security risk, or multi-module edits.

### Blocked

```text
coordinator -> ask user
```

Use when credentials, destructive authority, missing project path, unclear irreversible decision, or unsafe baseline is required.

## Implementation Phases

### Phase 1: Profile Skeletons

- Create profiles for `coordinator`, `researcher`, `planner`, `builder`, `reviewer`, `verifier`, `writer`, and `security`.
- Add `config.yaml`, `env.schema`, and starter `skills/` files.
- Keep existing `profiles/codex` and `profiles/claude` as compatibility aliases until migration is complete.
- Add builder variants for `glm5.1`, `kimi-k2.6`, and `mimo-v2.5pro`.

Acceptance:

- Profile files contain no secrets.
- Role boundaries are explicit.
- Existing commands still work.

### Phase 2: Profile Loader

- Implement a loader that reads `profiles/{role}`.
- Merge base `config.yaml` with selected `variants/{variant}.yaml`.
- Resolve env placeholders from process env or ignored local env files.
- Reject missing required env vars with a `blocked` result.
- Expose a normalized runtime launch spec.

Acceptance:

- Loader test covers base profile loading.
- Variant env mapping is tested without printing secret values.
- Missing credential produces a typed blocked reason.

### Phase 3: Coordinator Classification

- Add a coordinator classification command/API.
- Persist classification to:

```text
wiki/projects/{project}/tasks/{task-id}/classification.yaml
```

- Emit `task_classified` event.
- Include `classification`, `workflow`, `roles`, `risk`, `variant_overrides`, `needs_user_input`, and `reasons`.

Acceptance:

- Simple, standard, complex, and blocked examples are tested.
- Coordinator does not launch implementation phases directly.

### Phase 4: Workflow Planner

- Convert classification into an ordered phase graph.
- Store workflow at:

```text
wiki/projects/{project}/tasks/{task-id}/workflow.yaml
```

- Emit `workflow_planned` event.
- Support phase dependencies and retry/fix-loop limits.

Acceptance:

- Simple tasks produce one role phase plus light verification.
- Standard tasks produce builder and verifier phases.
- Complex tasks produce the full team path.

### Phase 5: Role Phase Runner

- Replace hard-coded provider phases with role phases.
- Launch ACP using the normalized profile runtime spec.
- Pass role instructions from `soul.md`, `user.md`, `memory.md`, selected skills, and task context.
- Enforce profile filesystem and terminal permissions in the ACP client layer.

Acceptance:

- `builder` can run through Claude Code ACP with a selected variant.
- `verifier` can run through Codex ACP.
- Phase artifacts are tied to role and task id.

### Phase 6: Supervisor Integration

- Teach supervisor to resume role phase graphs, not only plan/execute/verify.
- Keep leases phase-scoped:

```text
leaseId = {project}:{jobId}:{phaseId}:{role}
```

- Treat recent ACP activity as lease activity.
- Mark stale phases resumable, not automatically failed.

Acceptance:

- Killing a child process leaves a recoverable job.
- Restarting supervisor resumes from the next incomplete phase.
- Activity-based phases do not time out while progress is visible.

### Phase 7: Worktree and Merge Gate

- Ensure every code-writing task has a task branch and worktree.
- Initialize git for non-git projects with a safe baseline commit.
- Use the worktree cwd for builder, reviewer, verifier, and fix loops.
- Add a project-level merge lock for integration.

Acceptance:

- Non-git project gets safe local baseline and task worktree.
- Two builder tasks do not write to the same primary project directory.
- Failed worktree remains available for inspection.

### Phase 8: Parallelism and Scheduling

- Add role/provider/project semaphores.
- Allow parallel read-only phases after stable inputs exist.
- Serialize task-local builder fix loops.
- Block integration on merge lock conflicts.

Acceptance:

- Two independent read-only scans can run concurrently.
- Two write tasks use separate worktrees.
- One project integration lock prevents concurrent merges.

### Phase 9: UI and CLI

- Add CLI commands:

```bash
cpb classify <project> "<task>"
cpb team-run <project> "<task>"
cpb jobs
cpb supervisor
```

- Add UI display for:

```text
classification
workflow phases
current role
current provider variant
lease heartbeat
last activity
blocked reason
worktree path
```

Acceptance:

- Operator can see what role is active and why.
- Operator can distinguish waiting, running, blocked, failed, and completed.

### Phase 10: Tests and Failure Drills

Add tests for:

- profile loader and variant overlays;
- coordinator classification;
- workflow expansion;
- role phase runner with fake ACP agents;
- stale lease recovery;
- activity-based no-timeout behavior;
- worktree bootstrap for non-git projects;
- merge lock behavior;
- blocked credential handling;
- server restart recovery from event log.

Run manual drills:

```text
kill ACP child process
restart supervisor
simulate missing provider env
simulate stale lease
simulate failed verification
simulate merge conflict
simulate 24h heartbeat with fake active ACP agent
```

## Migration Strategy

1. Keep existing `cpb plan`, `cpb execute`, `cpb verify`, and `cpb pipeline` stable.
2. Introduce role/profile path behind a new `cpb team-run` command.
3. Map old phases to new roles:

```text
codex-plan.sh      -> planner
claude-execute.sh  -> builder
codex-verify.sh    -> verifier
```

4. Once stable, make `cpb pipeline` call the coordinator/workflow planner internally.
5. Keep compatibility aliases for old profile names until docs and tests are updated.

## Risks

| Risk | Mitigation |
| --- | --- |
| Coordinator becomes too heavy | Keep classification cheap and bounded. |
| Profiles leak secrets | Only env names in profiles; validate and redact resolved values. |
| Long tasks silently stall | Lease heartbeat, ACP activity events, and visible last-activity state. |
| Parallel builders conflict | Mandatory task worktrees and merge lock. |
| Provider outage blocks all tasks | Provider semaphores and variant fallback policy. |
| Event/state divergence | Event log remains source of truth; state is cache. |
| Over-complex workflow for small tasks | Use lightest safe workflow and auto-escalate only on failure/risk. |

## Open Decisions

- Should final user-facing summaries be written by `coordinator` or `writer`?
- Should `researcher` default to Claude Code ACP or Codex ACP?
- Which provider variant should be default for `builder`?
- Should variant fallback be automatic or require coordinator approval?
- How much parallel review should complex tasks enable by default?

## Definition of Done

- A complex task can run through fixed roles without hard-coded provider names.
- The same task can survive server restart or child process death.
- A writing task runs in a task worktree by default.
- The operator can inspect classification, workflow, active role, active lease, last activity, and artifacts.
- Missing credentials or unsafe operations produce `blocked`, not partial silent failure.
- Existing plan/execute/verify commands remain compatible during migration.
