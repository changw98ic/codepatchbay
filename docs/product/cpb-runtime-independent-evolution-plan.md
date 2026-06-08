# CPB Runtime Independent Evolution Plan

Date: 2026-06-07

## Purpose

CPB Runtime is the execution engine for project work. It turns approved work
requests into plans, agent runs, artifacts, verification results, and delivery
metadata.

In the OPC product architecture, CPB must stay independent from the user-facing
board and from tokenAgent billing. CPB owns execution truth, not product UI and
not money.

## Position In The System

```text
OPC Board  ->  CPB Runtime  ->  Coding Agents
     |              |
     v              v
tokenAgent <--------+
```

CPB depends on tokenAgent only through a stable execution API. tokenAgent must
not import CPB code or depend on CPB storage.

## Authority Boundary

CPB is authoritative for:

- job execution state
- phase state
- agent assignment
- worktree and workspace execution context
- artifacts
- diff, patch, PR, and preview metadata
- verification and review results
- execution retries, cancellation, and resume behavior

CPB is not authoritative for:

- user balance
- paid credit ledger
- provider key ownership
- provider model cost rules
- billing usage
- payment or refund state
- user-facing approval decisions

CPB may store tokenAgent usage references as execution telemetry, but tokenAgent
remains the billing source of truth.

## Product Mode

CPB should support an OPC product mode without becoming OPC-specific. In this
mode, CPB accepts externally approved jobs from OPC Board and executes them with
tokenAgent-scoped model access.

The same CPB runtime should still work in local-only or self-managed modes where
the operator provides their own agent/provider credentials.

## External Contracts

### Board To CPB Job API

OPC Board calls CPB to create and control work.

Required operations:

```text
createJob(input)
getJob(jobId)
listJobEvents(jobId, cursor)
listArtifacts(jobId)
cancelJob(jobId, reason)
retryJob(jobId, options)
```

Minimum `createJob` input:

```json
{
  "workspaceId": "ws_123",
  "projectId": "proj_123",
  "threadId": "thread_123",
  "requestId": "req_123",
  "taskType": "research|build|quick_fix|review|maintenance",
  "description": "User-visible task description",
  "approvedScope": {
    "summary": "What the user approved",
    "budgetReservationId": "br_123",
    "maxCredits": 100
  },
  "tokenAgent": {
    "baseUrl": "https://gateway.example.com",
    "executionKey": "ta_exec_...",
    "usageContext": {
      "userId": "user_123",
      "projectId": "proj_123",
      "threadId": "thread_123"
    }
  }
}
```

### CPB To tokenAgent Execution API

CPB should request or receive a scoped execution key before launching any agent
that uses managed model access.

The execution context must include:

- user id
- project id
- thread id
- job id
- phase
- agent name
- budget reservation id
- model/routing profile if selected by the product layer

CPB must not receive provider keys.

### Agent To tokenAgent Model API

Coding agents should see tokenAgent as their model provider through existing
OpenAI, Anthropic, Gemini, or tool-specific configuration. CPB injects only
scoped environment/config values needed for the agent process.

Typical injected values:

```text
TOKEN_AGENT_BASE_URL
TOKEN_AGENT_EXECUTION_KEY
TOKEN_AGENT_JOB_ID
TOKEN_AGENT_PHASE
TOKEN_AGENT_AGENT
```

## Event Model

CPB should emit product-readable events. The board can transform these into
cards, thread messages, progress indicators, and approval prompts.

Core event families:

- `job.created`
- `job.started`
- `phase.started`
- `phase.agent_selected`
- `phase.progress`
- `artifact.created`
- `phase.completed`
- `phase.failed`
- `job.waiting_for_budget`
- `job.waiting_for_user`
- `job.cancelled`
- `job.completed`

Events should be append-only and safe to replay.

## Artifact Contract

CPB should expose artifacts in a user-readable shape. Internal raw logs may
exist, but OPC Board should not need to parse them.

Required artifact types:

- `research_report`
- `build_brief`
- `execution_plan`
- `change_summary`
- `diff`
- `patch`
- `test_result`
- `verification_report`
- `preview_link`
- `pr_link`
- `risk_summary`

Every artifact should include:

```json
{
  "artifactId": "art_123",
  "jobId": "job_123",
  "phase": "verify",
  "type": "verification_report",
  "title": "Verification Result",
  "summary": "Human-readable summary",
  "uri": "file or service URI",
  "createdAt": "2026-06-07T00:00:00Z",
  "producerAgent": "codex"
}
```

## Usage Handling

CPB no longer owns billing usage in OPC mode.

Allowed CPB usage fields:

```json
{
  "usageAuthority": "tokenAgent",
  "usageId": "usage_123",
  "budgetReservationId": "br_123",
  "creditsSnapshot": 42,
  "modelSnapshot": "codex-pro",
  "providerModelSnapshot": "gpt-4.1"
}
```

Disallowed in CPB:

- balance mutation
- credit debit
- paid ledger rows
- provider cost table
- final billing invoices

Existing CPB provider usage and quota surfaces should become local telemetry or
self-managed-mode compatibility. They must not be used as paid billing truth in
OPC mode.

## Milestones

### M0: External Job API

Goal: allow OPC Board or any external product shell to submit and observe CPB
jobs without coupling to internal files.

Deliverables:

- stable `createJob`
- stable `getJob`
- stable `listJobEvents`
- stable `listArtifacts`
- cancel/retry commands
- documented event schema

Exit criteria:

- a mock board can create a job and render status from events only
- no board code imports CPB internals
- CPB can still run from CLI without OPC Board

### M1: tokenAgent Execution Context

Goal: make CPB launch agents with tokenAgent-managed model access.

Deliverables:

- scoped execution key support
- per-job and per-phase metadata propagation
- budget exhaustion handling
- tokenAgent usage reference attached to phase/job telemetry

Exit criteria:

- CPB never receives provider keys
- budget exhaustion pauses the job instead of silently switching to unmanaged
  credentials
- tokenAgent can attribute usage to user/project/thread/job/phase/agent

### M2: Artifact Contract

Goal: make CPB outputs product-readable.

Deliverables:

- normalized artifact index
- research report artifact
- build brief artifact
- change summary artifact
- verification artifact
- preview/PR link artifacts

Exit criteria:

- OPC Board can render a task detail view without scraping logs
- artifacts have stable type names and summaries

### M3: Human-Readable Execution

Goal: convert technical execution into non-coder friendly status.

Deliverables:

- progress summaries
- failure summaries
- risk summaries
- next-action recommendations
- user-action required states

Exit criteria:

- a non-coding user can understand why a task is blocked and what button to
  press next

### M4: Reliability And Resume

Goal: make CPB reliable enough for long-running OPC work.

Deliverables:

- resumable jobs
- phase retry policy
- verifier lane
- agent fallback policy
- durable event recovery
- explicit stuck-job recovery

Exit criteria:

- interrupted jobs recover without losing artifacts
- retries do not double-bill unless tokenAgent receives a new approved budget
  reservation

## Independent Test Strategy

CPB tests should use fake tokenAgent and fake ACP agents.

Required test classes:

- job API contract tests
- event replay tests
- artifact schema tests
- budget exhaustion tests
- scoped key propagation tests
- no-provider-key boundary tests
- self-managed-mode compatibility tests

## Non-Goals

- CPB will not become the customer billing system.
- CPB will not host provider credentials.
- CPB will not implement the OPC Board UI.
- CPB will not decide user-facing product pricing.
- CPB will not require tokenAgent for all modes.

## Design Rule

CPB is the work execution authority. It may know that a budget exists, but it
does not own the money.
