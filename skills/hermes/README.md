# CPB Hermes Skill

CodePatchbay pipeline orchestration skill for Hermes agents. Provides real-time streaming access to plan-execute-verify pipelines over SSE.

## What CPB Provides

CPB runs multi-agent coding pipelines: a planner (Codex) designs the approach, an executor (Claude Code) implements it, and a verifier (Codex) checks the result. Hermes agents can enqueue tasks, monitor progress through streaming events, and retrieve deliverables.

## Connection

CPB exposes an HTTP streaming server on `127.0.0.1:9741`.

```
GET  /stream?project=<name>     SSE event stream (project-filtered)
GET  /stream                    SSE event stream (all projects)
```

Connect to `/stream` for server-sent events. Each line is a JSON object prefixed with `data: `. The server sends `ping` events to keep the connection alive.

## Pipeline Execution

```bash
cpb pipeline <project> "<task description>"
```

Returns a `jobId`. Phases execute in order: plan, execute, verify. Each phase transition emits an event. Failed phases retry automatically up to the configured limit.

## Data Access

| Endpoint | Returns |
|---|---|
| `GET /jobs` | Active jobs (JSON array) |
| `GET /jobs/:project/:jobId` | Full materialized job state |
| `GET /wiki/:project/outputs/deliverable-<id>.md` | Executor output |
| `GET /wiki/:project/outputs/verdict-<id>.md` | Verifier result |

## Workflow

1. Start the stream server: `cpb stream --port 9741`
2. Connect to the SSE endpoint
3. Enqueue a pipeline: `cpb pipeline my-project "Add dark mode"`
4. Receive `phase_started`, `phase_completed`, `phase_failed` events as the job progresses
5. On `job_completed`, fetch the deliverable from the wiki endpoint
6. Check the verdict for PASS/FAIL/PARTIAL

## Event Types

- `job_created`, `job_started`, `job_completed`, `job_failed`, `job_blocked`, `job_cancelled`
- `phase_started`, `phase_completed`, `phase_failed`, `phase_retry`, `phase_activity`, `phase_result`
- `job_approved`, `job_panic`

## Triggering Pipeline Runs
