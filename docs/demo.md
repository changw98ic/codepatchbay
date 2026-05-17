# CodePatchbay demo path

This document keeps the demo honest: no stub demo, no hosted mock, and no claim of 24-hour unattended operation.

CodePatchbay's initial public shape is a real local pairing of Codex plus Claude Code. The minimum demo should show Codex planning, Claude Code executing, Codex verifying, and the handoff files written to disk.

## Clean clone verification

The repository has been clean-clone validated once from GitHub on macOS with Node.js 24.4.1.

```bash
git clone https://github.com/changw98ic/codepatchbay.git
cd codepatchbay
npm ci
./cpb help
npm test
npm run build:web
```

Expected result:

- `npm ci` installs root, server, and web workspace dependencies.
- `./cpb help` prints the CodePatchbay CLI help.
- `npm test` runs Node and shell integration tests.
- `npm run build:web` builds the Vite UI.

Known boundary: this proves one macOS clean checkout path only. Linux, Windows, GitHub Actions, real adapter auth, and long-running operation still need separate evidence.

## Real agent handoff demo

Prerequisites:

- Codex CLI / ACP adapter is installed and authenticated.
- Claude Code CLI / ACP adapter is installed and authenticated.
- The target project is a disposable repo you control.

Example adapter environment, adjust to your local setup:

```bash
export CPB_ACP_CODEX_COMMAND=codex-acp
export CPB_ACP_CODEX_ARGS='[]'
export CPB_ACP_CLAUDE_COMMAND=claude-agent-acp
export CPB_ACP_CLAUDE_ARGS='[]'
export CPB_ACP_TIMEOUT_MS=1800000
```

Run a small, low-risk task:

```bash
./cpb init /absolute/path/to/target-project target-demo
./cpb plan target-demo "Make a tiny documentation-only change"
./cpb execute target-demo 001
./cpb verify target-demo 001
```

Inspect the handoff artifacts:

```bash
ls wiki/projects/target-demo/inbox
ls wiki/projects/target-demo/outputs
find cpb-task/events/target-demo -name 'job-*.jsonl' -print
```

The useful demo moment is not just that agents ran. It is that each handoff remains inspectable as local files:

- `wiki/projects/target-demo/inbox/plan-001.md`
- `wiki/projects/target-demo/outputs/deliverable-001.md`
- `wiki/projects/target-demo/outputs/verdict-001.md`
- `cpb-task/events/target-demo/job-*.jsonl`

## Demo script for a short video

1. Show the target repo before the task.
2. Run `./cpb plan` and open the generated plan.
3. Run `./cpb execute` and show the target repo diff.
4. Run `./cpb verify` and open the verdict.
5. Show the event log file and explain that CodePatchbay is local-first and inspectable.
6. End with the boundary: alpha, non-commercial, Codex + Claude Code only for now.

## What not to claim yet

Do not claim these until there is evidence:

- Production-ready orchestration.
- 24-hour unattended operation.
- Cross-platform setup.
- Compatibility with arbitrary agent frameworks.
- Enterprise governance, auth, or hosted multi-tenant use.
