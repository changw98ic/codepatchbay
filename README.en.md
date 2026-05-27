# CodePatchBay - the local gateway for coding agents

[中文](README.md)

> Route coding tasks to Codex and Claude Code through a single local CLI. No hosted CodePatchBay service required.

## Quick Start

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
sh scripts/install.sh
cpb demo
cpb init .
cpb run "fix failing tests"
```

`scripts/install.sh` checks for `node`, `npm`, `git`, and `gh`, installs missing tools through a supported local package manager when possible, installs the current checkout as the global `cpb` CLI, verifies `gh auth status`, prompts for `gh auth login` when needed, then runs `cpb setup --recommended`.

Connect GitHub for unattended issue-driven workflow:

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # verify transport before starting daemon
cpb daemon start
```

Then add the label `cpb` to a GitHub issue. CodePatchBay picks it up, plans, executes, verifies, and opens a draft PR.

`cpb github doctor` runs nine layered checks: app config, webhook secret, installation, private key, transport mode, repo bindings, branch-push readiness, PR creation, and gh CLI auth. Use `--json` for machine-readable output.

Manual install from a checkout or release tarball:

```bash
npm ci
npm install -g .
cpb setup --recommended
```

Use `sh scripts/install.sh --skip-setup` to install only the `cpb` CLI, or `sh scripts/install.sh --setup-json` to inspect the setup plan without executing recommended agent installs.

## What it does

CodePatchBay orchestrates coding agents on your machine:

1. **`cpb setup --recommended`** - detect tools, install agents, run health checks, auth loop, write setup profile.
2. **`cpb init .`** - register the current project (name inferred from `package.json` or directory).
3. **`cpb github bind`** / **`cpb github connect`** - bind a project to a GitHub repo and configure the GitHub App.
4. **`cpb run "task"`** - run a task through the full plan -> execute -> verify pipeline.
5. **`cpb daemon start`** - start the queue worker for unattended issue-driven work.

## Workflow

```text
Codex plan
  -> inbox/plan-{id}.md
  -> Claude Code execute
  -> outputs/deliverable-{id}.md
  -> Codex verify
  -> outputs/verdict-{id}.md

On FAIL, review-{id}.md returns to inbox/ for retry or human review.
```

## Commands

```bash
cpb init <path> [name]             # Initialize project (name inferred if omitted)
cpb run "<task>" [--project <id>]  # Run task through full pipeline
cpb pipeline <project> "<task>"    # Full pipeline (explicit project)
cpb plan <project> "<task>"        # Codex planning only
cpb execute <project> <plan-id>    # Claude execution only
cpb verify <project> <id>          # Codex verification only
cpb demo [--json]                  # Local mock demo (no keys needed)
cpb setup [--recommended|--interactive|--json]  # Setup wizard
cpb agents [list|detect|install]   # Agent gateway management
cpb auth [status]                  # Provider auth checks
cpb github bind <proj> <owner/repo> # Bind project to GitHub repo
cpb github connect [options]       # Configure GitHub App credentials
cpb github doctor [--json]         # Check GitHub integration health
cpb daemon [start|status|stop]      # Queue worker daemon
cpb status <project>               # Project status
cpb list                           # List projects
cpb jobs [reconcile|cleanup]       # Job management
cpb artifacts <job-id>             # List job artifacts
cpb verdict <job-id>               # Show job verdict
cpb doctor [--json]                # Health check
cpb ui [--port] [--host]           # Start Web UI
cpb version                        # Show version
```

## Architecture

```text
cpb (CLI entry, Node.js)
|-- bridges/                # ACP bridges + runtime
|   |-- acp-client.mjs      # ACP stdio JSON-RPC client
|   |-- run-phase.mjs       # Single-phase runner (plan/execute/verify)
|   |-- run-pipeline.mjs    # Full pipeline orchestrator
|   |-- job-runner.mjs      # Durable job executor (lease heartbeat)
|   `-- supervisor-loop.mjs # Unattended supervisor
|-- cli/commands/           # CLI command modules
|-- server/                 # Fastify REST + WebSocket backend
|-- web/                    # React 19 + Vite frontend
`-- wiki/                   # Shared memory filesystem
    `-- projects/{name}/
        |-- inbox/          # Codex writes (plans, reviews)
        `-- outputs/        # Claude writes (deliverables, verdicts)
```

## ACP Connection

Agents connect via ACP stdio (JSON-RPC). Default adapters:

- Codex: `codex-acp` or `npx -y @zed-industries/codex-acp`
- Claude Code: `claude-agent-acp` or `npx -y @agentclientprotocol/claude-agent-acp`

Override with environment variables:

```bash
CPB_ACP_CODEX_COMMAND=codex-acp
CPB_ACP_CODEX_ARGS='["--some-arg"]'
CPB_ACP_CLAUDE_COMMAND=claude-agent-acp
CPB_ACP_CLAUDE_ARGS='["--some-arg"]'
CPB_ACP_TIMEOUT_MS=1800000   # idle timeout (activity-based), 0 to disable
```

## Light Plan Validation

Light plans are constrained to 80 lines and must include `Affected Files`, `Tests`, and `Risk` sections.

- **Default**: violations log a warning and execution continues.
- **Strict mode** (`CPB_LIGHT_PLAN_STRICT=1`): violations fail the job.

```bash
CPB_LIGHT_PLAN_STRICT=1   # fail on light plan constraint violations
```

## Durable Jobs

The unattended mode uses durable jobs with event logs, lease heartbeats, task worktrees, and supervisor recovery.

```bash
cpb jobs                     # List durable jobs
cpb jobs reconcile           # Mark stale jobs as failed
cpb gc                       # Clean stale jobs + orphan leases
```

## Requirements

- **Node.js 20+**: runtime for CLI and bridges
- **Codex ACP adapter**: `codex-acp` or `npx -y @zed-industries/codex-acp`
- **Claude ACP adapter**: `claude-agent-acp` or `npx -y @agentclientprotocol/claude-agent-acp`
- **Agent login / API key**: handled by each adapter

## Design Principles

1. **Local-first** - everything runs on your machine; provider adapters keep their own auth.
2. **Role separation** - Codex plans and verifies, Claude executes.
3. **Wiki isolation** - inbox/outputs boundaries separate unverified from verified content.
4. **File-based communication** - both sides read and write inspectable local files.
5. **ACP reuse** - no custom agent runtime, overlay CPB instructions on existing adapters.

## Security

CPB uses provider-native auth, never stores provider tokens, and blocks secrets in task input and artifacts. See [docs/security/codepatchbay-gateway-security.md](docs/security/codepatchbay-gateway-security.md) for the full security model covering install safety, secret redaction, IM key prohibition, webhook signature verification, worktree isolation, verifier constraints, and draft PR policy.
