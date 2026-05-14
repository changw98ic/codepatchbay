# CodePatchbay

> Experimental local handoff runner for Codex and Claude Code.

CodePatchbay is a source-available alpha prototype that explores a simple idea: Codex and Claude Code can coordinate through local files instead of relying only on one long chat session.

Current experiment:

1. Codex drafts a plan.
2. Claude Code attempts the implementation.
3. Codex checks the result.
4. CodePatchbay stores plans, deliverables, verdicts, and runtime events on disk for inspection.

**License:** personal and non-commercial use only. See [License](#license).

## Current status

CodePatchbay is **not production-ready**.

It has only been developed in the original local environment so far. Clean-machine setup, cross-platform behavior, long-running recovery, and real unattended operation still need to be proven.

Use it as an experimental local tool, not as infrastructure you rely on for important repositories.

## What this project is trying to explore

CodePatchbay is not a general multi-agent framework and is not an autonomous software engineer. The current scope is intentionally narrow:

- Codex is used for planning and checking.
- Claude Code is used for execution.
- ACP is the transport between CodePatchbay and those tools.
- Markdown files are used for handoffs.
- JSONL event files are used to inspect runtime state.
- A supervisor prototype exists, but long-running recovery is still experimental.

## Why the name?

A patchbay is a place where separate tools are connected intentionally. CodePatchbay applies that idea to AI coding tools: it experiments with connecting planning, execution, review, and handoff files into one local workflow.

## What exists today

The primary CLI command is `cpb`.

Available commands include:

```bash
cpb init <path> <name>
cpb plan <project> "<task>"
cpb execute <project> <plan-id>
cpb verify <project> <deliverable-id>
cpb pipeline <project> "<task>" [max-retries] [timeout-minutes]
cpb cancel <project> <jobId> [reason]
cpb redirect <project> <jobId> "<instructions>" [reason]
cpb status <project>
cpb list
cpb jobs
cpb supervisor
cpb ui [--port PORT] [--host HOST]
```

The repository currently includes:

- Bash and Node bridge scripts for `plan -> execute -> verify`.
- A Fastify API server.
- A React/Vite local operator UI.
- Markdown-based project wiki folders.
- JSONL event storage for job state inspection.
- Lease and supervisor code paths under active development.
- Review session and approve/reject dispatch code paths.
- Feishu and DingTalk notification/channel experiments.

These pieces should be treated as an alpha implementation, not a compatibility guarantee.

## Architecture sketch

```text
User task
  |
  v
Codex ACP
  -> wiki/projects/{project}/inbox/plan-001.md
  |
  v
Claude Code ACP
  -> wiki/projects/{project}/outputs/deliverable-001.md
  |
  v
Codex ACP
  -> wiki/projects/{project}/outputs/verdict-001.md
```

Runtime files are written under `cpb-task/` during local runs:

```text
cpb-task/events/      append-only job event files
cpb-task/leases/      phase lease files used by the supervisor prototype
cpb-task/state/       compatibility state for status/UI views
cpb-task/worktrees/   reserved for CodePatchbay-managed worktrees
cpb-task/reviews/     review session state
```

## Quick start

This quick start has not yet been validated on a clean machine. Expect setup issues and adapter-specific failures.

### Prerequisites

- Node.js 20+
- npm / npx
- Codex ACP adapter: `codex-acp` or `npx -y @zed-industries/codex-acp`
- Claude Code ACP adapter: `claude-agent-acp` or `npx -y @agentclientprotocol/claude-agent-acp`
- Valid login/API configuration for the chosen Codex and Claude Code adapters

### Try a local run

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay

./cpb init /path/to/your-project my-project
./cpb plan my-project "Describe a small change"
./cpb ui
```

The full pipeline command exists, but treat it as experimental:

```bash
./cpb pipeline my-project "Add unit tests for a small module" 3
```

The UI starts a local backend and Vite dev server:

```bash
./cpb ui
```

Then open:

```text
http://localhost:5173
```

## Web UI

The local UI currently includes:

- Dashboard with projects and job state.
- Project detail pages for context, tasks, inbox, outputs, logs, and decisions.
- New task submission for plan-only or pipeline runs.
- Review sessions with approve/reject controls.
- Self-evolve controls, currently experimental and high risk.

The UI is an alpha operator console.

## Configuration

CodePatchbay uses environment variables for ACP commands, timeouts, and provider variants.

```bash
CPB_ACP_CODEX_COMMAND=codex-acp
CPB_ACP_CODEX_ARGS='[]'
CPB_ACP_CLAUDE_COMMAND=claude-agent-acp
CPB_ACP_CLAUDE_ARGS='[]'
CPB_ACP_CWD=/path/to/project
CPB_ACP_TIMEOUT_MS=1800000
CPB_CLAUDE_VARIANT=none
```

Claude provider variants are supported through temporary environment overlays, but this is still an advanced path. Read the bridge scripts before using custom provider settings.

## Safety notes

CodePatchbay starts coding agents that may read files, write files, and request terminal actions through ACP. Treat every run as code execution against the target project.

Safe operating rules:

- Run it only against projects you control.
- Do not point it at directories containing secrets unless you understand the risk.
- Keep credentials in environment variables or ignored local files.
- Review generated plans before execution.
- Avoid `--dangerous` unless you explicitly accept unrestricted ACP permissions.
- Do not expose the local UI or webhook routes to untrusted networks.
- Read [SECURITY.md](SECURITY.md) before using channel webhooks or self-evolve.

## Known limitations

- Only Codex ACP and Claude Code ACP are supported as first-class backends.
- Clean environment setup has not been proven yet.
- Long-running and 24-hour recovery claims have not been proven yet.
- No authentication or RBAC is included in the local Web UI.
- The UI is not polished.
- Self-evolve is experimental and should be treated as unsafe until proven otherwise.
- Enterprise deployment, multi-tenant hosting, SSO, audit export, and centralized secret management are not included.
- Commercial use is not allowed without a separate written license.

## Near-term work before public launch

- Prove clean-machine setup outside the current development environment.
- Document the real minimum setup: local Codex CLI plus Claude Code CLI configured and reachable through their ACP/CLI bridges.
- Add a real long-running example only after it has been validated with actual Codex + Claude Code execution.
- Keep public claims aligned with verified behavior; do not describe 24h unattended operation as proven until it is demonstrated.

## Contributing

Contributions are welcome for personal and non-commercial collaboration under the project license. By contributing, you agree that your contribution may be distributed under the current non-commercial license and under separate commercial licenses offered by the project owner.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

CodePatchbay is released under the **PolyForm Noncommercial License 1.0.0**.

You may use, copy, modify, and share CodePatchbay for personal, educational, research, and other non-commercial purposes, subject to the license terms.

Commercial use is not permitted without a separate written commercial license. Commercial use includes, but is not limited to:

- using CodePatchbay inside a company or commercial organization
- offering CodePatchbay as a hosted service
- integrating CodePatchbay into a paid product
- using CodePatchbay to deliver paid consulting or development services
- redistributing CodePatchbay as part of a commercial product or service

For commercial licensing, contact the repository owner.
