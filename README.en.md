# CodePatchBay

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [中文](README.md)

**Project-manager agent for coding agents.**

Give it a task or GitHub issue. It plans the work, coordinates coding agents, verifies the result, and prepares a reviewable pull request.

```text
Issue / Task → CodePatchBay PM Agent → Coding Agents → Verified PR
```

CodePatchBay does not replace Claude Code, Codex, or other coding agents. It manages them.

## Why coding agents need a PM

Coding agents are good at writing code, but real engineering work needs more than code generation. A complete coding workflow also needs:

- **Task intake** — understand requirements, break down work
- **Planning** — determine scope, affected files, and risks
- **Delegation** — assign work to the right agent
- **Tracking** — collect artifacts, record progress
- **Verification** — review whether changes are correct
- **Delivery** — prepare a PR for human review

CodePatchBay provides that coordination layer.

## How it works

```text
Task or GitHub Issue
        ↓
CodePatchBay PM Agent
        ↓
  Plan → Delegate to coding agent → Collect changes → Verify → Prepare PR
        ↓
  Codex · Claude Code · Other coding agents
        ↓
  Human review and merge
```

Each step produces local artifacts (Markdown files) you can inspect before trusting the final change.

## Quick Start

### Install from npm (recommended)

npm package: [`codepatchbay`](https://www.npmjs.com/package/codepatchbay)

```bash
npm install -g codepatchbay
cpb setup --recommended        # detect tools, install agents, run health checks
cpb quickstart --demo          # local demo, no API keys needed
cd your-project
cpb init .                     # register project
cpb run "fix failing tests"    # submit a task, CodePatchBay handles the rest
```

Try without installing:

```bash
npx codepatchbay quickstart --demo
```

### Install from source

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
sh scripts/install.sh
```

## Give CodePatchBay a task

```bash
# Register your project
cpb init .

# Submit a task
cpb run "add dark mode toggle to the settings page"
```

CodePatchBay will:

1. Analyze the task and create an implementation plan
2. Delegate execution to a coding agent
3. Collect changes and artifacts
4. Verify the result is correct
5. Prepare a PR for review

```bash
# Check progress
cpb status myproj

# Inspect deliverables and verification verdict (in the project outputs dir)
cpb outputs myproj
```

## GitHub issue to PR

Connect GitHub, label an issue with `cpb`, and CodePatchBay takes over:

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # verify connectivity
cpb hub start                    # start Hub scheduler
```

Label an issue `cpb` → auto plan → delegate → verify → open draft PR.

## Supported coding agents

CodePatchBay connects coding agents neutrally via the ACP protocol. Any ACP-compatible agent (Claude Code, Codex, OpenCode, or custom) can be plugged in. It decomposes the engineering workflow into 5 semantic roles, mapped by agent routing:

| Semantic role | Responsibility | Artifact |
|---------------|----------------|----------|
| `planner` | Analyze task, produce implementation plan | `inbox/plan-*` |
| `executor` | Execute code changes, fix bugs | `outputs/deliverable-*` |
| `verifier` | Verify result, produce verdict | `outputs/verdict-*` |
| `reviewer` | Review deliverable | review artifact |
| `remediator` | Remediate failures (debug/lint/tdd/test) | remediation artifact |

Any agent is mapped to these roles via `core/agents/routing.ts`. You specify which agent + model handles which phase when you submit a task:

```bash
# Use mimo model for plan, Claude for execute and verify
cpb run "add unit tests for auth" \
  --plan-agent claude --plan-model mimo \
  --execute-agent claude \
  --verify-agent claude
```

## Features

- **Task management** — accept tasks from CLI or GitHub issues, break down work
- **Smart delegation** — assign planning, execution, and verification to the best agent
- **Artifact tracking** — each step produces inspectable local artifacts
- **Result verification** — changes must pass verification before reaching PR
- **GitHub integration** — issue labels trigger workflow, draft PRs, webhook connectivity
- **Multi-agent support** — Codex, Claude Code, OpenCode, and custom agents
- **Durable jobs** — event log + checkpoint recovery, multi-worker scheduling, unattended execution

## Commands

```bash
# Project management
cpb init <path> [name]             # Initialize project (auto-registers with Hub)
cpb list                           # List projects
cpb status <project>               # Project status

# Submit tasks
cpb run "<task>" [--project <id>]  # Submit task (full workflow)
cpb pipeline <project> "<task>" [retries]  # Full workflow (explicit project)
                                  #   add --plan-agent/--execute-agent/--verify-agent
                                  #   and --plan-model/--execute-model/--verify-model
cpb review <project> [id]          # Review deliverable
cpb retry <project> <job-id>       # Retry a failed job

# Job management
cpb jobs report [--json]           # Job run report (reconcile/cleanup/gc removed)
cpb jobs worktrees                # List task-level git worktrees
cpb retry <project> <job-id> [--agent <name>]
cpb cancel <project> <jobId> [reason]
cpb redirect <project> <jobId> "<msg>" [reason]

# Changes
cpb diff <project>
cpb inbox <project>                # List inbox files
cpb outputs <project>              # List outputs files

# GitHub
cpb github bind <proj> <owner/repo>
cpb github connect [options]
cpb github doctor [--json]

# Hub & scheduling
cpb hub [status|start|stop|projects|...]

# Setup & diagnostics
cpb setup [--recommended|--interactive|--json]
cpb agents [list|detect|install|test]
cpb stream [args]                  # Streaming data server
cpb doctor [--json]
cpb health-check                   # health check via the quickstart alias entry
cpb version
```

## Design principles

1. **PM role** — CodePatchBay doesn't replace coding agents; it coordinates them through a complete engineering workflow
2. **Human in the loop** — all changes require human review before merging, even after verification
3. **Local-first** — everything runs on your machine; no hosted service required
4. **Inspectable artifacts** — each step produces local files you can inspect at any point
5. **Composable agents** — any ACP-compatible coding agent can be plugged in

## Security

CodePatchBay uses each agent's native auth, never stores provider tokens, and blocks secrets in task input and artifacts. See [docs/security/](docs/security/) for the full security model covering install safety, secret redaction, webhook signature verification, worktree isolation, and draft PR policy.

## Requirements

- **Node.js 20+**
- At least one coding agent (Claude Code, Codex, or other ACP-compatible agent)

## License

[AGPL-3.0](LICENSE) — free to use and modify, but derivative works must be open-sourced. Commercial licensing available on request.
