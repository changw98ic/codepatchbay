# CodePatchBay

[![npm version](https://img.shields.io/npm/v/codepatchbay.svg)](https://www.npmjs.com/package/codepatchbay) [中文](README.md)

**Local delivery runtime for coding agents.**

Give it a task or GitHub issue. CodePatchBay uses ACP or a CLI gateway to run Codex, Claude Code, OpenCode, or another supported agent through planning, execution, evidence capture, verification, and an inspectable local delivery or draft PR.

```text
Issue / Task → CodePatchBay Runtime → Coding Agents → Evidence-backed Delivery
```

CodePatchBay does not replace Claude Code, Codex, or other coding agents. It manages their handoffs, state, evidence, and artifacts.

## Current stabilization cycle

CodePatchBay is currently focused on execution-kernel and release-gate stability.
This cycle does not add new agent types, workflow families, scheduler features,
or provider integrations. Release criteria are recorded in
[`docs/product/cpb-stabilization-baseline-2026-06-22.md`](docs/product/cpb-stabilization-baseline-2026-06-22.md)
and [`docs/product/cpb-flagship-validation-gate.md`](docs/product/cpb-flagship-validation-gate.md).

## Why coding agents need a runtime

Coding agents are good at writing code, but real engineering delivery needs more than code generation. An inspectable coding workflow also needs:

- **Task intake** — understand requirements, break down work
- **Planning** — determine scope, affected files, and risks
- **Delegation** — assign work to the right agent
- **Tracking** — collect artifacts, record progress
- **Verification** — judge changes against evidence
- **Delivery** — produce local artifacts or a draft PR for human review

CodePatchBay provides that local runtime and audit layer.

## How it works

```text
Task or GitHub Issue
        ↓
CodePatchBay Runtime
        ↓
  Plan → Delegate to agent → Record events and artifacts → Verify evidence → Deliver reviewable result
        ↓
  Codex · Claude Code · Other coding agents
        ↓
  Human review and merge
```

Each step produces local artifacts (Markdown, JSONL, checklist, evidence ledger) you can inspect before trusting the final change.

## Quick Start

### Install from npm (recommended)

npm package: [`codepatchbay`](https://www.npmjs.com/package/codepatchbay)

```bash
npm install -g codepatchbay
cpb setup --recommended        # detect tools, install agents, run health checks
cd your-project
cpb quickstart --demo --project-path . --project-name your-project  # initialize local demo, no API keys needed
cpb run "fix failing tests" --project your-project                # enqueue the full workflow
```

Try without installing:

```bash
npx codepatchbay quickstart --demo --project-path . --project-name cpb-demo
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
cpb init . myproj

# Submit a task
cpb run "add dark mode toggle to the settings page" --project myproj
```

CodePatchBay will:

1. Analyze the task and create an implementation plan
2. Delegate execution to a coding agent
3. Collect changes and artifacts
4. Verify the result is correct
5. Produce local delivery artifacts or a draft PR for review

```bash
# Check progress
cpb status myproj

# Inspect deliverables and verification verdict (under the registered runtime's wiki/outputs)
cpb outputs myproj
```

## GitHub issue to draft PR

Configure the GitHub transport and webhook, then label an issue with `cpb` to enter the plan, execute, and verify flow. The default path first produces a draft PR dry-run preview:

```bash
cpb github bind myproj owner/repo
cpb github connect --app-id 123 --webhook-secret-ref env:CPB_GITHUB_WEBHOOK_SECRET
cpb github doctor                # verify connectivity
cpb hub start                    # start Hub scheduler
```

Note: `cpb hub start` does not by itself expose a generic GitHub webhook route. An already-wired transport or external webhook entrypoint is required before issue labels can trigger the flow above.

The Hub binds to loopback by default, but loopback is not an identity boundary. Startup always requires
`CPB_HUB_BEARER_TOKEN`, `CPB_HUB_SERVICE_TOKENS_FILE`, or `CPB_HUB_OIDC_CONFIG_FILE`.
Local development may explicitly set `CPB_HUB_ALLOW_ANONYMOUS_DEV=1`; that mode is loopback-only and never enterprise-ready.
A non-loopback `CPB_HOST` should be deployed behind a TLS reverse proxy.
Only explicitly secured networks should combine a non-loopback bind with `CPB_HUB_ALLOW_INSECURE_HTTP=1`.
GitHub comment-triggered `/cpb run` is accepted only from repository owners,
members, or collaborators.

Enterprise deployments can set the absolute `CPB_HUB_SERVICE_TOKENS_FILE` path
to use named service tokens stored only as SHA-256 digests and authorize them by
`hub:health`, `hub:read`, or `hub:admin` scope plus project allowlists. The old
`CPB_HUB_BEARER_TOKEN` remains a global `legacy-admin` compatibility credential.
The authorization file must be a private, non-symlink file (`0600` on POSIX),
and Hub reloads an atomically replaced file on the next request without a
restart. The legacy bearer environment token still requires a restart to change.
See
[`docs/security/cpb-hub-service-tokens.md`](docs/security/cpb-hub-service-tokens.md)
for the schema, error contract, and rotation guidance.

Before responding, the Hub durably writes the request id, principal, path
without query parameters, status, scope decision, and machine error code to a
SHA-256 hash-chain access audit. Integrity or write failure returns
`503 HUB_ACCESS_AUDIT_UNAVAILABLE` instead of silently dropping the record. The
log is bounded to 256 MiB by default, `cpb doctor` warns before capacity is
exhausted, and `cpb hub verify-access-audit` verifies the chain. The local chain
can be archived while the Hub is stopped with
`cpb hub archive-access-audit --output PATH`; the archive is published before
the live log is reset, interrupted transactions recover from a durable journal,
and `CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY` enables HMAC-SHA256 manifests.
This local mechanism does not replace a separately controlled SIEM or WORM store; see
[`docs/security/cpb-hub-access-audit.md`](docs/security/cpb-hub-access-audit.md).

All production project-registry writes use a cross-process transaction with a
monotonic `revision`; a stale snapshot returns `HUB_REGISTRY_CONFLICT` instead
of overwriting another process's commit. The owner-token lock is renewed,
recovers dead owners, and is revalidated before publish, while registry and
lock metadata reads reject symlinks and enforce byte limits. This guarantee is
for competing processes on one host, not multi-host consensus. See
[`docs/architecture/cpb-hub-registry-consistency.md`](docs/architecture/cpb-hub-registry-consistency.md).

For multi-host deployments, the project registry, queue, leases, assignments,
and worker inbox can use the private `CPB_HUB_STATE_REDIS_CONFIG_FILE` backend.
Remote connections require `rediss://`; the current release still reports
`activeActiveSafe: false`, so multiple active schedulers are not supported.

The Hub root contains both control-plane state and every registered project's runtime state.
Backup and restore are offline operations. Snapshots carry a SHA-256 manifest, restore verifies
all data before mutation, replacing existing state requires `--force`, and the previous root is
retained as a `*.pre-restore-*` rollback directory:

```bash
cpb hub stop
cpb hub backup --output /secure/backups/cpb-2026-07-11
cpb hub verify-backup --input /secure/backups/cpb-2026-07-11
cpb hub restore --input /secure/backups/cpb-2026-07-11 --force
cpb hub recover-restore       # inspect and recover an interrupted restore transaction
```

Backups require `CPB_HUB_BACKUP_SIGNING_KEY` with at least 32 non-whitespace bytes by default.
They include an HMAC-SHA256 signature, and verification and restore reject unsigned snapshots by default.
Only local development compatibility may use `--allow-unsigned-dev` to create, verify, or restore an
unsigned snapshot. Store the key separately from snapshots
and include it in enterprise key rotation and disaster-recovery procedures.

Backup and restore hold a token-owned maintenance lease beside the Hub root. Hub, orchestrator,
worker, queue, project-registry, and quota-delegate write entry points reject concurrent writes.
Restore uses a durable three-phase journal and fsyncs the parent directory after renames. After a
process or host interruption, the next Hub start automatically rolls back an uncommitted state or
verifies the committed replacement; `cpb hub recover-restore` runs the same recovery explicitly.

Command and test acceptance probes no longer execute model-generated
`expectedEvidence` text. Repositories that need these probes must commit a
maintainer-reviewed `.cpb/verification-probes.json` policy at `HEAD`, binding a
`predicateId` to structured `executable` and `args` fields. Missing policy
produces an auditable failed claim and never falls back to shell execution. See
[`docs/security/cpb-agent-secret-boundary.md`](docs/security/cpb-agent-secret-boundary.md).

Before copying, backup and restore check free space on the destination filesystem and reserve
256 MiB after the operation by default. Set `CPB_HUB_MIN_FREE_BYTES` to another non-negative byte
count. Backup stages carry an ownership marker bound to the Hub and output path; later runs reclaim
only stages proven to belong to that transaction and refuse to delete unmarked or mismatched directories.

In a configured GitHub transport, an issue label can trigger auto plan → delegate → verify → draft PR dry-run preview; live draft PR creation requires explicit opt-in.

## Supported coding agents

CodePatchBay connects coding agents through ACP or a CLI gateway. ACP agents such as Claude Code and Codex, plus CLI agents such as OpenCode, can be connected through their respective gateways. The workflow exposes 5 semantic roles; regular agent routing covers planner, executor, verifier, and reviewer, while remediator is handled by the remediation phase:

| Semantic role | Responsibility | Artifact |
|---------------|----------------|----------|
| `planner` | Analyze task, produce implementation plan | `inbox/plan-*` |
| `executor` | Execute code changes, fix bugs | `outputs/deliverable-*` |
| `verifier` | Verify result, produce verdict | `outputs/verdict-*` |
| `reviewer` | Review deliverable | review artifact |
| `remediator` | Remediate failures (debug/lint/tdd/test) | remediation artifact |

Planner, executor, verifier, and reviewer are mapped to phases via `core/agents/routing.ts`; remediator is handled by the remediation phase. You specify which agent + model handles which phase when you submit a task:

```bash
# Use per-phase agents; all phases share one model profile
cpb run "add unit tests for auth" \
  --plan-agent claude --execute-agent claude \
  --verify-agent claude --model mimo
```

## Features

- **Task intake** — accept tasks from CLI or GitHub issues, break down work
- **Role routing** — assign planning, execution, verification, review, and remediation to the right agent
- **Evidence tracking** — each step produces inspectable local artifacts and an evidence ledger
- **Completion gate** — checklist, verdict, and runtime evidence must pass before delivery
- **GitHub transport** — issue labels trigger workflow, draft PRs, webhook connectivity
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
cpb pipeline <project> "<task>" [--retries <n>]  # Full workflow (explicit project)
                                  #   add --plan-agent/--execute-agent/--verify-agent
                                  #   and --model
cpb review <project> [id]          # Review deliverable
cpb retry <project> <job-id> [--agent <name>]  # Retry a failed job

# Job management
cpb jobs report [--json]           # Job run report (reconcile/cleanup/gc removed)
cpb jobs worktrees                # List task-level git worktrees
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
cpb agents [list|detect|install|upgrade|test]
cpb stream [args]                  # Streaming data server
cpb doctor [--json]
cpb health-check                   # health check via the quickstart alias entry
cpb version
```

## Design principles

1. **Delivery runtime** — CodePatchBay doesn't replace coding agents; it manages their handoffs, state, and acceptance checks
2. **Human in the loop** — all changes require human review before merging, even after verification
3. **Local-first** — everything runs on your machine; no hosted service required
4. **Inspectable evidence** — each step produces local files you can inspect at any point
5. **Composable agents** — supported ACP or CLI coding agents can be plugged in

## Security

CodePatchBay uses each agent's native auth, never stores provider tokens, and blocks secrets in task input and artifacts. See [docs/security/](docs/security/) for the full security model covering install safety, secret redaction, webhook signature verification, worktree isolation, and draft PR policy.

- **Provider authentication** — API keys and OAuth tokens stay in the agent process; CPB does not write them to disk.
- **Webhook verification** — the current live path explicitly supports GitHub HMAC-SHA256; Slack/Discord ingress is not registered in the current Hub HTTP routes.
- **Draft PR policy** — the flagship finalizer's live PR path creates drafts and never auto-merges; the default path produces a dry-run preview.
- **Worktree isolation** — tasks run in separate git worktrees rather than modifying the main branch.

## Requirements

- **Node.js 20+**
- **npm and git** (`gh` or a configured GitHub transport is also needed for GitHub integration)
- At least one supported coding agent (Claude Code, Codex, OpenCode, or another supported agent)

## Development and verification

```bash
npm ci
npm run typecheck:node
npm test
npm run verify:release-gate
```

## License

[AGPL-3.0](LICENSE) — free to use and modify, but derivative works must be open-sourced. Commercial licensing available on request.
