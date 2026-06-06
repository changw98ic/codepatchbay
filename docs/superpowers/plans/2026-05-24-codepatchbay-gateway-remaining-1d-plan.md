# CodePatchBay Gateway Remaining Implementation Plan

> **旧执行内核注释（2026-06-02）：** 本文中提到的 `server/services/phase-runner.js`
> 属于已删除的旧执行内核。本文仅作历史方案参考；当前执行入口是
> `cpb hub-orch start`，执行内核是 Hub queue worker 调用 `runJob` / `runJobWithServices`。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Break the remaining CodePatchBay gateway roadmap into independently shippable one-person-day work packages.

**Architecture:** Build outward from the existing setup gateway slice: local setup and agent readiness first, then local verified patch workflow, then GitHub issue-to-PR, then Slack/Discord control, then extensible catalog and team controls. Each task must leave the product in a runnable state and must not silently install third-party agents or copy provider tokens.

**Tech Stack:** Node.js ESM CLI and services, Fastify Hub routes, existing job-store/event-store/runtime services, git worktrees, GitHub App/webhook APIs, Slack/Discord app APIs, existing web UI workspace.

---

## Baseline Already Done

- `cpb setup` detects local prerequisites and known coding-agent binaries.
- `cpb agents list|detect|install|test` exposes the first gateway command surface.
- Agent setup catalog exists for Codex, Claude Code, OpenCode, and Cursor Agent.
- Install plans are transparent and default to `executed: false`; `--yes` is required to run a third-party install command.
- Full Node test suite passed after this slice.

## One-Person-Day Rule

Each task below is scoped to one focused developer day:

- One main behavior change.
- One small set of related files.
- Tests or a documented manual verification path.
- No unrelated refactors.
- No new dependency unless the task explicitly says dependency approval is part of that day.
- A task can be shipped, reverted, or re-run independently.

## File Map By Area

- Setup and agents: `core/setup/*`, `core/agents/*`, `cli/commands/setup.js`, `cli/commands/agents.js`, `server/routes/agents.js`, `server/services/readiness-checks.js`.
- Auth and secrets: `server/services/secret-policy.js`, new `core/auth/*`, new `cli/commands/auth.js`, future secure local setup routes under `server/routes/*`.
- Local runtime: `bridges/run-pipeline.mjs`, `server/services/job-store.js`, `server/services/event-store.js`, `server/services/phase-runner.js`, `server/services/artifact-locator.js`, `server/services/job-run-report.js`.
- GitHub gateway: `server/services/github-issues.js`, `server/services/event-source.js`, new `server/services/github-app.js`, new `server/routes/github.js`, new `cli/commands/github.js`.
- Channels: `server/routes/channels.js`, `server/services/notification/*`, new `server/services/channel-slack.js`, new `server/services/channel-discord.js`, new `cli/commands/channel.js`.
- Web UI: `web/`, `server/routes/agents.js`, `server/routes/events.js`, `server/routes/projects.js`, `server/routes/tasks.js`.
- Docs and release: `README.md`, `docs/demo.md`, `docs/security/*`, `tests/*`, package/release scripts.

## Milestone A: Setup And Agent Gateway Hardening

### D01: Setup Snapshot Contract

**Scope:** Stabilize the JSON shape emitted by `cpb setup --json` and `cpb agents detect --json`.

**Files:**
- Modify: `core/setup/detect.js`
- Modify: `cli/commands/setup.js`
- Modify: `cli/commands/agents.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- JSON includes `system`, `tools`, `agents`, `generatedAt`, and `schemaVersion`.
- Missing binaries are represented as structured records, not thrown errors.
- Tests cover installed, missing, and command-timeout probes.

**Dependencies:** Current setup gateway slice.

### D02: Agent Manifest Schema Validation

**Scope:** Add strict validation for setup agent manifests.

**Files:**
- Modify: `core/setup/agent-catalog.js`
- Create: `core/setup/manifest-schema.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Invalid manifests fail with actionable messages.
- Required fields include `id`, `displayName`, `binary`, `roles`, `capabilities`, `install`, and `sourceUrl`.
- Existing Codex, Claude, OpenCode, and Cursor entries pass validation.

**Dependencies:** D01.

### D03: Merge Setup Catalog With Runtime Agent Registry

**Scope:** Connect setup manifests to the existing runtime registry without replacing ACP descriptors.

**Files:**
- Modify: `core/agents/registry.js`
- Modify: `core/setup/agent-catalog.js`
- Test: `tests/agent-registry.test.mjs`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Runtime registry can expose setup metadata for known agents.
- Existing descriptor loading and auto-discovery tests keep passing.
- Built-in ACP command resolution remains unchanged.

**Dependencies:** D02.

### D04: Installer Plan Safety Metadata

**Scope:** Enrich install plans with source, method, command, risk notes, rollback guidance, and shell-use flag.

**Files:**
- Modify: `core/setup/install-plan.js`
- Modify: `cli/commands/agents.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Every plan includes `sourceUrl`, `displayCommand`, `requiresExplicitConfirmation`, `rollback`, and `supplyChainNotes`.
- Shell-script install commands are visibly marked as `shell: true`.
- Non-`--yes` install command never spawns child processes.

**Dependencies:** D02.

### D05: Installer Execution Event Log

**Scope:** When `cpb agents install <agent> --yes` runs, record local install attempt metadata.

**Files:**
- Modify: `cli/commands/agents.js`
- Create: `server/services/setup-events.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Event log records agent id, method, command hash, startedAt, finishedAt, exit code, and result.
- Event log redacts secrets and does not store stdout by default.
- Failed install returns non-zero and preserves the event.

**Dependencies:** D04.

### D06: Agent Health Check Contract

**Scope:** Add a lightweight health check per setup agent.

**Files:**
- Modify: `core/setup/agent-catalog.js`
- Create: `core/setup/health-check.js`
- Modify: `cli/commands/agents.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- `cpb agents test codex --json` returns binary, version probe, auth probe status, and adapter probe status.
- Missing optional checks are reported as `skipped`, not `pass`.
- Command timeouts return structured `timeout` evidence.

**Dependencies:** D01, D03.

### D07: Doctor Includes Setup And Agent Readiness

**Scope:** Extend `cpb doctor` to include setup catalog and agent readiness levels.

**Files:**
- Modify: `server/services/readiness-checks.js`
- Modify: `cli/commands/doctor.js`
- Test: `tests/readiness-json-contract.test.mjs`

**Acceptance:**
- Doctor JSON includes a `setup` section with core tools and recommended agents.
- Stable required failures are errors; optional agent failures are warnings.
- Human doctor output gives exact next commands.

**Dependencies:** D06.

## Milestone B: Auth And Secret Boundary

### D08: Auth Status CLI

**Scope:** Add `cpb auth status` that reports provider-native auth availability without reading tokens.

**Files:**
- Create: `cli/commands/auth.js`
- Create: `core/auth/status.js`
- Modify: `cli/cpb.mjs`
- Test: `tests/cli-entrypoints.test.mjs`
- Test: `tests/auth-status.test.mjs`

**Acceptance:**
- `cpb auth status --json` lists Codex, Claude, OpenCode, GitHub as `connected`, `missing`, `unknown`, or `skipped`.
- Output never includes API keys, OAuth tokens, or provider cache paths containing secret material.
- Unknown provider commands do not fail the whole command.

**Dependencies:** D06.

### D09: Auth Connect Command Surface

**Scope:** Add `cpb auth connect <provider>` with local-only instructions and a secure local setup URL for Hub-driven flows.

**Files:**
- Modify: `cli/commands/auth.js`
- Create: `core/auth/connect.js`
- Test: `tests/auth-status.test.mjs`

**Acceptance:**
- Codex and Claude connect commands point users to provider-native login commands.
- GitHub connect points to `cpb github connect`.
- IM-style key submission is explicitly rejected in parser tests.

**Dependencies:** D08.

### D10: Secret Policy Enforcement For Inputs

**Scope:** Prevent CLI/channel command handlers from accepting raw API keys.

**Files:**
- Modify: `server/services/secret-policy.js`
- Modify: `cli/commands/auth.js`
- Test: `tests/event-store-hardening.test.mjs`
- Test: `tests/auth-status.test.mjs`

**Acceptance:**
- Inputs matching common API key patterns are rejected with safe guidance.
- Rejection event stores redacted evidence.
- Existing event-store secret tests still pass.

**Dependencies:** D09.

## Milestone C: Local Verified Patch Workflow

### D11: Default Worktree Policy

**Scope:** Make job worktrees default for new local jobs while preserving an explicit opt-out.

**Files:**
- Modify: `bridges/run-pipeline.mjs`
- Modify: `server/services/job-store.js`
- Test: `tests/pipeline-contract.test.mjs`

**Acceptance:**
- New jobs use isolated worktrees unless project policy disables them.
- Job metadata records worktree path and base branch.
- Existing jobs without worktree metadata remain readable.

**Dependencies:** Current runtime tests green.

### D12: Worktree Cleanup And Retention

**Scope:** Add safe retention rules for completed and failed worktrees.

**Files:**
- Create: `server/services/worktree-retention.js`
- Modify: `cli/commands/jobs.js`
- Test: `tests/job-recovery-hardening.test.mjs`

**Acceptance:**
- Completed job worktrees can be archived or deleted by policy.
- Failed and blocked job worktrees are retained by default.
- Cleanup dry-run lists exact paths and reasons.

**Dependencies:** D11.

### D13: Artifact Index Contract

**Scope:** Normalize plan, deliverable, review, verdict, diff, and PR artifacts into one index.

**Files:**
- Modify: `server/services/artifact-locator.js`
- Create: `server/services/artifact-index.js`
- Test: `tests/phase-locator-contract.test.mjs`

**Acceptance:**
- Artifact index includes kind, phase, path, sha256, createdAt, and producer agent.
- Missing artifact files are reported as broken references.
- Existing locator packet tests keep passing.

**Dependencies:** Existing event-store and artifact locator.

### D14: Artifact CLI Viewer

**Scope:** Add `cpb artifacts <job>` and `cpb verdict <job>` read-only commands.

**Files:**
- Create: `cli/commands/artifacts.js`
- Create: `cli/commands/verdict.js`
- Modify: `cli/cpb.mjs`
- Test: `tests/cli-entrypoints.test.mjs`

**Acceptance:**
- Commands resolve Hub and legacy runtime roots.
- JSON and human output are both supported.
- Missing job returns non-zero with no stack trace.

**Dependencies:** D13.

### D15: Retry Reason Normalization

**Scope:** Normalize verifier failure reasons into executor retry input.

**Files:**
- Modify: `bridges/run-pipeline.mjs`
- Modify: `core/workflow/verdict.js`
- Test: `tests/pipeline-contract.test.mjs`

**Acceptance:**
- Retry prompt includes concise failing checks and expected retry scope.
- Retry count and previous verdict id are recorded.
- PASS verdict never triggers retry.

**Dependencies:** D13.

### D16: Local Demo Command

**Scope:** Add `cpb demo` for mock plan-execute-verify in a toy repo.

**Files:**
- Create: `cli/commands/demo.js`
- Create: `server/services/demo-runner.js`
- Modify: `cli/cpb.mjs`
- Test: `tests/fake-acp-smoke.test.mjs`
- Docs: `docs/demo.md`

**Acceptance:**
- `cpb demo --json` creates a temporary toy repo and completes mock plan, execute, verify.
- Demo leaves event log and artifacts under a temp CPB root.
- Fresh run completes without real API keys.

**Dependencies:** D14, D15.

## Milestone D: Web UI Productization

### D17: Agents Page Uses Setup Readiness

**Scope:** Show installed/missing/auth/adapter status in the Web UI Agents page.

**Files:**
- Modify: `server/routes/agents.js`
- Modify: `web/`
- Test: `tests/hub-runtime.test.mjs`
- Test: Web build or focused UI test.

**Acceptance:**
- Agents page lists catalog agents with install method and status.
- Missing recommended agents show the safe install-plan command.
- No install action runs from UI in this task.

**Dependencies:** D06.

### D18: Job Detail Artifact Panel

**Scope:** Add artifact, diff, and verdict panels to job detail.

**Files:**
- Modify: `server/routes/events.js`
- Modify: `server/routes/tasks.js`
- Modify: `web/`
- Test: `tests/hub-runtime.test.mjs`

**Acceptance:**
- Job detail displays artifact index from D13.
- Verdict status is visible without opening raw logs.
- Broken artifact references render as warnings.

**Dependencies:** D13.

### D19: Queue Dashboard Readiness

**Scope:** Make queue/job list show source, workflow, current phase, retry count, and next required human action.

**Files:**
- Modify: `server/services/job-projection.js`
- Modify: `web/`
- Test: `tests/pipeline-contract.test.mjs`

**Acceptance:**
- Queue rows distinguish queued, running, blocked, failed, passed, and PR-opened states.
- Projection works from event log only.
- Existing projection tests keep passing.

**Dependencies:** D15.

## Milestone E: GitHub Gateway

### D20: GitHub Project Binding CLI

**Scope:** Add `cpb github bind <project> <owner/repo>` using existing project registry.

**Files:**
- Create: `cli/commands/github.js`
- Modify: `cli/cpb.mjs`
- Modify: `server/services/project-loader.js` or Hub registry service
- Test: `tests/cli-entrypoints.test.mjs`

**Acceptance:**
- Binding persists owner, repo, and default trigger rules.
- Invalid repo names are rejected.
- Existing project registration remains compatible.

**Dependencies:** Existing project registry.

### D21: GitHub App Config Model

**Scope:** Store GitHub App id, installation id, webhook secret reference, and repo permissions metadata.

**Files:**
- Create: `server/services/github-app.js`
- Modify: `server/services/secret-policy.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Config can be loaded, validated, and redacted.
- Webhook secret value is never serialized in JSON output.
- Missing installation id produces actionable readiness warning.

**Dependencies:** D20.

### D22: Webhook Signature Verification

**Scope:** Add GitHub webhook route with HMAC signature verification.

**Files:**
- Create: `server/routes/github.js`
- Modify: `server/index.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Valid `X-Hub-Signature-256` is accepted.
- Invalid and missing signatures return 401.
- Raw request body is used for signature verification.

**Dependencies:** D21.

### D23: GitHub Event Normalization

**Scope:** Normalize `issues`, `issue_comment`, and `installation` webhook payloads.

**Files:**
- Modify: `server/services/github-issues.js`
- Create: `server/services/github-events.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Normalized event includes repo, project id, issue number, actor, action, command text, labels, and URL.
- Unsupported events return `ignored` with reason.
- Existing `githubIssueToCandidate` tests keep passing.

**Dependencies:** D22.

### D24: Trigger Rule Matcher

**Scope:** Match labels, comments, and assignment events to project workflow policy.

**Files:**
- Create: `server/services/github-triggers.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- `issues.labeled` with label `cpb` queues standard workflow.
- `issue_comment.created` with `/cpb run` queues standard workflow.
- Non-matching labels/comments do not queue jobs.

**Dependencies:** D23.

### D25: Issue Queue Entry Creation

**Scope:** Convert matched GitHub events into queue entries and jobs.

**Files:**
- Modify: `server/services/event-source.js`
- Modify: `server/services/job-store.js`
- Test: `tests/openclaw-proactive.test.mjs`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Queue entry preserves issue number, repo, title, body, source URL, actor, and workflow.
- Duplicate webhook deliveries are idempotent.
- Created job links back to queue entry.

**Dependencies:** D24.

### D26: GitHub Queued Status Comment

**Scope:** Post a queued comment back to the issue using GitHub App credentials or `gh` fallback.

**Files:**
- Create: `server/services/github-comments.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Comment body includes job id, workflow, and selected agents.
- Dry-run mode returns the comment body without network calls.
- Network failure marks notification as failed without failing job creation.

**Dependencies:** D25.

### D27: Issue Branch And Worktree Naming

**Scope:** Create deterministic branch/worktree names for GitHub issue jobs.

**Files:**
- Modify: `bridges/run-pipeline.mjs`
- Create: `server/services/branch-names.js`
- Test: `tests/pipeline-contract.test.mjs`

**Acceptance:**
- Branch uses prefix `cpb/issue-<number>-<slug>`.
- Slug is length-limited and path-safe.
- Collisions are resolved deterministically.

**Dependencies:** D11, D25.

### D28: Draft PR Creation

**Scope:** Open draft PR after PASS verdict.

**Files:**
- Create: `server/services/github-pr.js`
- Modify: `bridges/run-pipeline.mjs`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- PR creation requires PASS verdict and branch push readiness.
- Dry-run mode returns PR title/body/head/base without network calls.
- Failure to open PR leaves job in `passed` or `blocked.pr` with evidence.

**Dependencies:** D26, D27.

### D29: PR Body With Artifacts And Verdict

**Scope:** Generate CodePatchBay PR body from plan, deliverable, tests, verdict, retries, and audit links.

**Files:**
- Create: `server/services/pr-body.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Body includes CodePatchBay Run, Plan, Tests, Verification, and Audit sections.
- Missing optional artifacts are represented as unavailable, not omitted silently.
- Body is deterministic for the same job projection.

**Dependencies:** D13, D28.

### D30: Issue And PR Status Updates

**Scope:** Post status comments for blocked, failed, passed, and PR-opened states.

**Files:**
- Modify: `server/services/github-comments.js`
- Modify: `server/services/job-projection.js`
- Test: `tests/github-gateway.test.mjs`

**Acceptance:**
- Each terminal state has a concise GitHub comment template.
- Repeated projection does not spam duplicate comments.
- Comment events are recorded in audit log.

**Dependencies:** D28, D29.

## Milestone F: Channel Control Surface

### D31: Channel Command Parser

**Scope:** Parse `/cpb run`, `/cpb issue`, `/cpb status`, `/cpb approve`, and `/cpb cancel` independent of Slack/Discord transport.

**Files:**
- Create: `server/services/channel-commands.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- Parser returns typed commands with project, job, issue, task, and workflow fields.
- Secret-like input is rejected using D10.
- Unknown commands return help text.

**Dependencies:** D10.

### D32: Slack App Skeleton

**Scope:** Add Slack signature verification and slash-command endpoint.

**Files:**
- Create: `server/services/channel-slack.js`
- Modify: `server/routes/channels.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- Valid Slack request is parsed into channel command.
- Invalid signature is rejected.
- Endpoint supports dry-run tests without Slack network calls.

**Dependencies:** D31.

### D33: Slack Run And Status Commands

**Scope:** Wire Slack `/cpb run` and `/cpb status` to queue/job services.

**Files:**
- Modify: `server/services/channel-slack.js`
- Modify: `server/services/event-source.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- `/cpb run frontend "task"` creates queue entry and job.
- `/cpb status job-id` returns current projection.
- Slack response includes View Run and Cancel action metadata.

**Dependencies:** D32.

### D34: Slack Approval Buttons

**Scope:** Add signed interactive actions for approve, retry, and cancel.

**Files:**
- Modify: `server/services/channel-slack.js`
- Modify: `server/routes/channels.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- Button payload maps to job id and action.
- Approval action records actor and timestamp.
- Cancel action uses existing cancel path.

**Dependencies:** D33.

### D35: Discord Bot Skeleton

**Scope:** Add Discord interaction verification and command mapping.

**Files:**
- Create: `server/services/channel-discord.js`
- Modify: `server/routes/channels.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- Discord signature verification passes known test vector.
- `/cpb run` and `/cpb status` map to the shared command parser.
- No Discord token is stored in project directories.

**Dependencies:** D31.

### D36: Channel Permission Model

**Scope:** Restrict channel commands by project, channel id, user id, and action.

**Files:**
- Create: `server/services/channel-policy.js`
- Modify: `server/services/channel-slack.js`
- Modify: `server/services/channel-discord.js`
- Test: `tests/channel-commands.test.mjs`

**Acceptance:**
- Unauthorized run/approve/cancel returns denied with reason.
- Read-only status can be allowed separately from write actions.
- Policy decisions are audit logged.

**Dependencies:** D34, D35.

## Milestone G: Routing, Catalog, And Scoring

### D37: Routing Rules Config

**Scope:** Add project-level routing rules for task category to planner/executor/verifier/workflow.

**Files:**
- Create: `core/agents/routing.js`
- Modify: `core/workflow/definition.js`
- Test: `tests/agent-registry.test.mjs`

**Acceptance:**
- Rules support bugfix, test, docs, security, frontend, backend, infra, research, review.
- Missing rules fall back to current default roles.
- Invalid agent names fail validation before job start.

**Dependencies:** D03.

### D38: Agent Metrics Score

**Scope:** Compute agent score from existing performance and verdict metrics.

**Files:**
- Modify: `server/services/agent-metrics.js`
- Create: `core/agents/scoring.js`
- Test: `tests/agent-registry.test.mjs`

**Acceptance:**
- Score includes success rate, duration, retry rate, verifier pass rate, timeout rate, and user rejection rate.
- Missing history produces neutral score with low confidence.
- Metrics output remains backward-compatible.

**Dependencies:** Existing `agent-metrics.js`.

### D39: Fallback Routing

**Scope:** Use routing rules and health status to choose fallback agents when preferred agent is unavailable.

**Files:**
- Modify: `core/agents/routing.js`
- Modify: `server/services/job-store.js`
- Test: `tests/pipeline-contract.test.mjs`

**Acceptance:**
- Unavailable preferred executor falls back to configured fallback agent.
- Fallback decision is recorded in job metadata and audit log.
- No fallback occurs when policy forbids it.

**Dependencies:** D37, D38.

### D40: Manifest Registry Layout

**Scope:** Move setup catalog toward a file-backed manifest registry while preserving current JS API.

**Files:**
- Create: `core/setup/manifests/*.json`
- Modify: `core/setup/agent-catalog.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Built-in manifests load from JSON files.
- `listSetupAgents()` output remains stable.
- Invalid JSON manifests are skipped or fail according to strict mode.

**Dependencies:** D02.

### D41: Version Pin And Upgrade Plan

**Scope:** Add manifest fields and CLI output for version pinning, upgrade, and rollback commands.

**Files:**
- Modify: `core/setup/manifests/*.json`
- Modify: `core/setup/install-plan.js`
- Test: `tests/setup-gateway.test.mjs`

**Acceptance:**
- Install plan can include a pinned version command when manifest provides it.
- Upgrade plan and rollback guidance are visible.
- No upgrade command executes without `--yes`.

**Dependencies:** D40.

## Milestone H: Release, Docs, And Demo

### D42: README Product Repositioning

**Scope:** Rewrite README around “local gateway for coding agents” and current runnable commands.

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`

**Acceptance:**
- First screen states gateway positioning.
- Quickstart installs from a trusted checkout or release tarball, then includes `cpb setup`, `cpb demo`, `cpb init .`, `cpb run`.
- Unimplemented commands are not presented as ready paths.

**Dependencies:** D16.

### D43: Package Smoke Test

**Scope:** Ensure packed npm package contains setup, agents, demo, web dist, core runtime, and docs needed for quickstart.

**Files:**
- Modify: `tests/release-package.test.mjs`
- Modify: `package.json`

**Acceptance:**
- `npm pack` install smoke can run `cpb setup --json`.
- Missing packaged files fail the test.
- Package files list includes `core/setup/`.

**Dependencies:** D16, D42.

### D44: CI Quickstart Smoke

**Scope:** Add CI smoke path for setup and mock demo.

**Files:**
- Modify: `.github/workflows/*` if present
- Create or modify: `scripts/ci-smoke.mjs`
- Test: Local `node scripts/ci-smoke.mjs`

**Acceptance:**
- CI runs setup JSON validation and demo smoke without real provider keys.
- Failure logs include command and exit code.
- Existing `npm test` remains the main regression gate.

**Dependencies:** D16, D43.

### D45: Security Model Documentation

**Scope:** Document install, auth, secret, IM, webhook, worktree, verifier, and PR safety model.

**Files:**
- Create: `docs/security/codepatchbay-gateway-security.md`
- Modify: `README.md`

**Acceptance:**
- Document explicitly says CPB does not copy provider tokens.
- IM key submission is forbidden.
- GitHub webhook signatures and draft PR policy are described.

**Dependencies:** D10, D22, D28, D36.

## Milestone I: Team Controls And Enterprise Readiness

### D46: Team Policy File

**Scope:** Add project/team policy schema for approvals, routing, channels, and protected operations.

**Files:**
- Create: `core/policy/team-policy.js`
- Test: `tests/permission-react.test.mjs`

**Acceptance:**
- Policy validates approval before write, shell, network, push, PR, and merge.
- Default policy matches current local-first behavior.
- Invalid policies fail before job creation.

**Dependencies:** D36, D37.

### D47: Audit Export

**Scope:** Export job audit package with event log, artifacts index, verifier verdict, and PR metadata.

**Files:**
- Create: `server/services/audit-export.js`
- Create: `cli/commands/audit.js`
- Modify: `cli/cpb.mjs`
- Test: `tests/event-store-hardening.test.mjs`

**Acceptance:**
- Export is read-only and deterministic.
- Secret redaction is applied before writing export.
- Missing artifacts are listed as broken references.

**Dependencies:** D13, D30.

### D48: Remote Runner Boundary Contract

**Scope:** Define the local/container/remote runner interface without implementing a cloud runner.

**Files:**
- Create: `docs/architecture/runner-boundary.md`
- Create: `core/workflow/runner-contract.js`
- Test: `tests/architecture-boundaries.test.mjs`

**Acceptance:**
- Contract defines job input, artifact output, event stream, secret boundary, and cancellation semantics.
- Current local runner conforms through an adapter object.
- No network runner is added in this task.

**Dependencies:** D11, D47.

## Recommended Execution Order

1. Setup hardening: D01-D07.
2. Auth and secret boundary: D08-D10.
3. Local verified patch quality: D11-D16.
4. Web UI visibility: D17-D19.
5. GitHub issue-to-PR: D20-D30.
6. Slack/Discord control: D31-D36.
7. Routing/catalog/scoring: D37-D41.
8. Release/docs/security: D42-D45.
9. Team and enterprise foundation: D46-D48.

## Parallelization Guidance

- One engineer can run D01-D07 sequentially because they touch the same setup surface.
- GitHub tasks D20-D24 can be planned together, then implemented sequentially to preserve event semantics.
- Slack and Discord can split after D31 because they share the parser but have different transports.
- Web UI tasks D17-D19 can run after backend contracts are stable.
- Docs tasks D42 and D45 can run in parallel with late implementation once command behavior is stable.

## Stop Conditions

- A task requires provider tokens in project files.
- A task needs a new dependency and no dependency review has been performed.
- A task changes event log format without migration or compatibility tests.
- A task silently executes third-party installers.
- A task opens, pushes, or merges GitHub changes without explicit policy and dry-run coverage.

## Verification Gates

- After each task: run the focused test file named in that task.
- After each milestone: run `npm test`.
- Before release docs are updated: run packaged smoke from D43.
- Before claiming GitHub issue-to-PR complete: run a dry-run webhook-to-PR flow that proves queued job, branch, PR body, and status comment generation without network calls.

## Completion Definition

This plan is complete when a fresh user can install CodePatchBay, run setup, connect provider-native auth, bind a local repo, queue a GitHub issue or channel command, get a worktree patch, see independent verification, and receive a draft PR or a documented blocking verdict with audit artifacts.
