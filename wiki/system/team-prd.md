# Flow Team Profile PRD

> Product requirements for evolving Flow from a two-agent ACP pipeline into a profile-driven AI project team.

## Status

- **State**: Draft
- **Owner**: Flow Coordinator
- **Audience**: users, maintainers, profile authors, bridge/runtime implementers
- **Updated**: 2026-05-13

## Problem

Flow can currently run a useful Codex -> Claude Code -> Codex loop, but the team model is still bound to provider names. Codex acts as planner/verifier, Claude Code acts as executor, and the bridge scripts hard-code those responsibilities.

That is enough for a first ACP workflow, but it does not scale cleanly to real project work:

- A role is not the same thing as an agent provider.
- Claude Code can switch model providers through temporary environment variables.
- Different task shapes need different workflows.
- The system needs a coordinator that decides whether a request is simple, standard, complex, or blocked.
- Role identity, user preferences, long-term role memory, permissions, and model variants need a stable profile format.

## Product Goal

Flow should become a small AI project team runtime where:

1. Users describe project goals in natural language.
2. A coordinator classifies the task and selects the lightest safe workflow.
3. Roles are loaded from `profiles/{role}/`, not hard-coded as `codex` or `claude`.
4. Runtime providers and model variants are selected by profile config.
5. Agents communicate through ACP and persist handoffs through the Flow wiki.
6. Simple tasks stay fast, while complex tasks get research, planning, implementation, review, verification, and documentation.
7. Code-writing tasks run in isolated git worktrees by default, not directly in the primary project directory.

## Users

### Primary User

The project owner who wants to ship code with an AI team while keeping control over scope, safety, and final decisions.

### Maintainer

The person evolving Flow itself: profile schemas, bridge scripts, UI, ACP permissions, and runtime behavior.

### Profile Author

The person creating or tuning roles such as coordinator, researcher, builder, reviewer, verifier, writer, or security.

## Core Concepts

| Concept | Meaning |
| --- | --- |
| Profile | A role contract: identity, responsibilities, boundaries, preferences, memory, config, and skills. |
| Variant | A model/provider overlay for a profile, such as `glm5.1`, `kimi-k2.6`, or `mimo-v2.5pro`. |
| Runtime | The execution backend, usually Codex ACP or Claude Code ACP. |
| ACP | The transport and tool protocol between Flow and the agent runtime. |
| Wiki | Shared project memory and handoff storage. |
| State | Machine-readable task and pipeline status. |
| Worktree | A per-task git worktree used to isolate code-writing agents. |

## Required Team Roles

| Role | Purpose | Default Runtime | Notes |
| --- | --- | --- | --- |
| `coordinator` | Classify tasks, select workflow, assign roles, track state. | Codex ACP | Does not write production code. |
| `researcher` | Scan projects, read docs, gather context, summarize evidence. | Claude Code ACP or Codex ACP | Does not make final architecture decisions. |
| `planner` | Create plans, architecture decisions, acceptance criteria. | Codex ACP | Does not implement production code. |
| `builder` | Implement changes, run tests, produce deliverables. | Claude Code ACP | Can use provider variants. |
| `reviewer` | Review implementation for correctness and maintainability. | Codex ACP | Produces actionable feedback. |
| `verifier` | Decide `PASS`, `FAIL`, or `PARTIAL` against acceptance criteria. | Codex ACP | Final quality gate. |
| `writer` | Update README, release notes, decisions, user docs. | Claude Code ACP or Codex ACP | Does not alter implementation. |
| `security` | Review auth, secrets, filesystem, command, and network risks. | Codex ACP | Used when task risk is high. |

## Profile File Requirements

Every role profile should support this structure:

```text
profiles/{role}/
  soul.md
  user.md
  memory.md
  config.yaml
  skills/
  variants/
    {variant}.yaml
  env.schema
```

### File Semantics

| File | Purpose | Must Not Contain |
| --- | --- | --- |
| `soul.md` | Who the role is, what it owns, what it refuses to do. | Project status or secrets. |
| `user.md` | User preferences as seen by this role. | Credentials or transient task data. |
| `memory.md` | Long-term reusable role experience. | Current project state. |
| `config.yaml` | Runtime, default variant, directories, permissions, forbidden paths. | API keys or tokens. |
| `skills/` | Role-specific task procedures. | Hidden credentials. |
| `variants/*.yaml` | Provider/model/env overlay names. | Raw secrets. |
| `env.schema` | Required environment variable names. | Raw secrets. |

Real credentials should live outside profiles in ignored secret files or the user's shell environment.

## Task Classification

All user requests should enter through the coordinator. The coordinator should emit a short classification record before dispatching work.

```yaml
classification: simple | standard | complex | blocked
confidence: high | medium | low
workflow: one_agent | builder_then_verifier | full_team | ask_user
roles:
  - coordinator
risk: low | medium | high
needs_user_input: false
reasons:
  - clear_scope
```

### Classification Rules

| Signal | Simple | Standard | Complex | Blocked |
| --- | --- | --- | --- | --- |
| Files touched | 0-3 | 1-6 | Multi-module | Unknown or destructive |
| Requirements | Clear | Mostly clear | Need research/design | Missing critical decision |
| Risk | Low | Low/medium | Architecture/security/data | Irreversible or externally visible |
| Verification | One light check | Tests/build | Multi-stage review | Cannot verify safely |
| Dependencies | None | Existing only | New service or protocol | Requires credentials/approval |
| Workflow | Single role | Builder + verifier | Full team | Ask user |

### Escalation Rules

- `simple` fails once -> upgrade to `standard`.
- `standard` verification fails once -> upgrade to `complex`.
- Any architecture, security, credential, filesystem boundary, or destructive operation risk -> upgrade to `complex` or `blocked`.
- Missing project path, missing credential, or irreversible action -> `blocked`.

## Workflows

### Simple Workflow

Used for explanation, small docs, project scans, tiny fixes, and low-risk checks.

```text
coordinator -> selected role -> light verification -> result
```

Examples:

- Explain a file.
- Scan a project and summarize it.
- Update a short README section.
- Run a known test command.

### Standard Workflow

Used for small implementation tasks that still need independent verification.

```text
coordinator -> builder -> verifier -> result
```

Examples:

- Fix a clear bug.
- Add a focused test.
- Make a local UI or CLI adjustment.

### Complex Workflow

Used for new features, refactors, multi-module changes, unclear tasks, or higher-risk work.

```text
coordinator
  -> researcher
  -> planner
  -> builder
  -> reviewer
  -> builder fix loop
  -> verifier
  -> writer
  -> archive
```

### Blocked Workflow

Used only when safe autonomous progress is impossible.

```text
coordinator -> ask user for the missing decision or authority
```

## Git and Worktree Requirements

Flow should use git worktrees as the default isolation mechanism for any task that writes code.

### Default Policy

| Project State | Flow Behavior |
| --- | --- |
| Existing git repo with commits | Create a task branch and task worktree. |
| Existing git repo without commits | Create a protected baseline commit, then create a task worktree. |
| Not a git repo | Run `git init`, create a protected baseline commit, then create a task worktree. |
| Git unavailable or unsafe baseline detected | Classify as `blocked`. |

### Baseline Commit Requirements

When Flow initializes git or finds a repository without commits, it must create a local baseline commit before worktree creation. The baseline step must:

- avoid staging `.env`, secrets, credentials, caches, dependency folders, and build artifacts;
- respect existing `.gitignore`;
- add common ignore rules when no useful ignore coverage exists;
- record that the baseline was created by Flow;
- stop as `blocked` if safe staging cannot be determined.

The baseline commit is local. Flow must not push to remotes.

### Worktree Requirements

Each writing task should receive:

- one task branch;
- one task worktree;
- one task-scoped cwd for builder, reviewer, verifier, and fix loops;
- one deliverable tied to that branch/worktree state.

The primary project directory should be treated as the integration target, not the normal place where builder agents write files.

## Model Provider Requirements

Claude Code based roles must support temporary environment overlays so the same role can run against different providers.

Known Claude Code variants:

| Variant | Provider | Intended Use |
| --- | --- | --- |
| `glm5.1` | z.ai | General builder/researcher work. |
| `kimi-k2.6` | OllamaCloud | Larger context implementation and writing. |
| `mimo-v2.5pro` | Xiaomi | Builder and UI/product writing experiments. |

The role remains stable. The variant changes the backend model and environment for that invocation only.

## Functional Requirements

### P0

- Define profile schema and required role set.
- Add coordinator classification as the first logical step of every workflow.
- Support simple, standard, complex, and blocked workflows.
- Separate role identity from runtime provider.
- Support Claude Code provider/model switching via temporary environment overlays.
- Keep secrets out of profile files.
- Persist handoffs in the existing wiki structure.
- Use git worktree isolation for code-writing tasks.
- Initialize git by default when a target project is not already a git repository.

### P1

- Add profile loader that merges base profile config and selected variant.
- Add role-aware ACP launch that injects only the selected invocation's env vars.
- Add permission boundaries per profile and phase.
- Persist classification records in task state.
- Add UI affordances for workflow class, roles, variants, and current phase.
- Add a worktree manager for branch naming, creation, cleanup, and merge locking.

### P2

- Add reusable role skills under `profiles/{role}/skills/`.
- Add profile validation and linting.
- Add team templates for common project types.
- Add historical performance metrics by role and variant.

## Non-Goals

- Build a new agent protocol. Flow uses ACP.
- Replace Codex or Claude Code. Flow orchestrates them.
- Store API keys in profiles or wiki files.
- Make every task run through the full team.
- Let one role plan, implement, and approve the same task without separation.
- Push commits to a remote repository without explicit user request.

## Acceptance Criteria

- A maintainer can explain the full team model from these docs without reading bridge code.
- A future implementation can add `coordinator`, `researcher`, `builder`, and `writer` profiles without changing the conceptual model.
- The distinction between role, runtime, provider, and model variant is explicit.
- Simple and complex workflows have clear entry, exit, and escalation rules.
- Secret handling is explicitly separated from profile configuration.
- Code-writing concurrency is based on git worktrees, with automatic git initialization for non-git projects.

## Open Questions

- Which role should own final user-facing summaries: `coordinator` or `writer`?
- Should `reviewer` and `verifier` always be separate invocations, or can low-risk tasks collapse them?
- Should Flow keep classification records as markdown, JSON, or both?
- Should provider variants be globally reusable or role-local only?
