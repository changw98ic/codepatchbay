---
name: codepatchbay
description: Use CodePatchBay, the published npm package and `cpb` CLI for local-first verified AI coding workflows. Trigger when the user asks to install or run CodePatchBay/CPB, route a coding task through plan -> execute -> verify, inspect CPB artifacts or verdicts, set up CPB agents, run CPB demo/doctor/status/repair/cancel, or configure CPB GitHub issue-to-PR automation.
---

# CodePatchBay

## Overview

Use the published npm package `codepatchbay` to run local, inspectable agent workflows. Prefer the installed `cpb` command when available, and fall back to `npx -y codepatchbay@latest` for one-off use.

## Command Selection

Use this wrapper pattern:

```bash
cpb <command>
```

If `cpb` is unavailable and the user has not asked for a permanent install:

```bash
npx -y codepatchbay@latest <command>
```

For recurring use or setup work:

```bash
npm install -g codepatchbay
cpb setup --recommended
```

Only use a local checkout command such as `node cli/cpb.mjs` when the user is developing CodePatchBay itself or explicitly points at a source tree.

## First Run

1. Confirm the runtime:

```bash
cpb version
cpb doctor --json
```

2. If this is a new machine or missing adapter setup:

```bash
cpb setup --recommended
cpb agents detect --json
cpb auth status
```

3. For a safe smoke test with no provider keys:

```bash
cpb demo
```

## Project Workflow

For a workspace task:

```bash
cd <project>
cpb init .
cpb run "<task>"
```

For an already registered project:

```bash
cpb run "<task>" --project <project-id>
```

After launch, inspect evidence before reporting success:

```bash
cpb status <project-id>
cpb artifacts <job-id> --json
cpb verdict <job-id> --json
```

Use single-stage commands only when the user asks for that boundary:

```bash
cpb plan <project-id> "<task>"
cpb execute <project-id> <plan-id>
cpb verify <project-id> <deliverable-id>
```

## Operational Tasks

- Use `cpb repair <project-id> <job-id>` to retry a failed phase.
- Use `cpb cancel <project-id> <job-id> [reason]` when the user asks to stop a running job.
- Use `cpb redirect <project-id> <job-id> "<message>" [reason]` when the job needs new instructions.
- Use `cpb diff <project-id>` and `cpb audit <project-id> <job-id> --json` to review changes and export evidence.
- Use `cpb ui [--port <port>]` when the user wants the local web interface.

## GitHub Automation

For issue-driven unattended work:

```bash
cpb github bind <project-id> <owner/repo>
cpb github connect --app-id <id> --webhook-secret-ref env:<SECRET_ENV>
cpb github doctor --json
cpb daemon start
```

Do not paste secrets into task text or artifacts. Prefer secret references such as `env:NAME`.

## Safety Rules

- Do not use `--dangerous` unless the user explicitly asks for that mode.
- Do not claim a CPB task is complete until `cpb verdict` or equivalent artifacts show the result.
- Prefer `--json` for outputs you need to parse.
- Preserve local user changes in the target project; CodePatchBay artifacts are evidence, not permission to overwrite unrelated work.
- If setup, auth, or adapter checks fail, run the narrow diagnostic command (`cpb doctor --json`, `cpb agents test <agent> --json`, or `cpb github doctor --json`) and report the concrete blocker.
