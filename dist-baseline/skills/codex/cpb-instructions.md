# CPB Instructions for Codex

## What is CodePatchBay (CPB)?

CodePatchBay is a multi-agent workflow orchestration system. It connects planning agents (Codex) with execution agents (Claude Code) through a plan -> execute -> verify pipeline. The system uses file-based artifacts (JSONL event logs, JSON state, Markdown wiki) for durability and inspectability.

### Pipeline flow

```
Plan (Codex)     -> wiki/projects/{name}/inbox/plan-{id}.md
Execute (Claude)  -> wiki/projects/{name}/outputs/deliverable-{id}.md
Verify (Codex)    -> wiki/projects/{name}/outputs/verdict-{id}.md
```

Each pipeline run is a **job** tracked via an append-only JSONL event log. Jobs go through phases: `plan` -> `execute` -> `verify`. Each phase can succeed, fail, or be retried.

## When to use CPB vs direct coding

Use CPB when:
- The task involves multi-file changes that benefit from plan-then-execute discipline
- You want a verification step to catch issues before accepting changes
- You are working on a registered CPB project and want durable tracking
- The task needs retry logic or failure recovery

Use direct coding when:
- The change is trivial (single file, few lines)
- No verification step is needed
- You are prototyping or exploring

## Available MCP tools

### `cpb_pipeline` -- Enqueue a task

Starts a full plan->execute->verify pipeline.

Parameters:
- `project` (required): Project ID registered with `cpb init`
- `task` (required): Natural language description of what to do
- `priority` (optional): P1-P5, default P3

Returns: `{ jobId, status, project, task }`

Example:
```
cpb_pipeline({ project: "my-app", task: "Add dark mode toggle with CSS variables" })
```

### `cpb_status` -- Check job state

Returns the full materialized state of a job including current phase, status, artifacts, retries, and failure info.

Parameters:
- `project` (required): Project ID
- `jobId` (required): Job ID returned by cpb_pipeline

Example:
```
cpb_status({ project: "my-app", jobId: "job-abc123" })
```

### `cpb_list` -- List projects

Lists all registered CPB projects.

Parameters:
- `enabledOnly` (optional): Only return enabled projects (default false)

### `cpb_wiki_read` -- Read a wiki file

Reads a file from a project's wiki directory.

Parameters:
- `project` (required): Project ID
- `path` (required): Relative path within the project wiki (e.g. `inbox/plan-abc.md`)

### `cpb_wiki_list` -- List wiki files

Lists files in a project's wiki directory.

Parameters:
- `project` (required): Project ID
- `subdir` (optional): Subdirectory to list (e.g. `inbox`, `outputs`)

### `cpb_stream_subscribe` -- Subscribe to events

Fetches recent events from the CPB streaming server. Requires `cpb stream` to be running.

Parameters:
- `project` (optional): Filter to a specific project
- `limit` (optional): Max events to return (default 20)

## Streaming protocol (CPB Stream Protocol v1)

The streaming server runs as a standalone HTTP service. Start it with `cpb stream --port 9741`.

Default: `127.0.0.1:9741`

### HTTP endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Server info: `{version, clients, uptime, websocket}` |
| GET | `/stream?project=<name>` | SSE event stream (filtered to project(s), comma-separated) |
| GET | `/stream` | SSE event stream (all projects) |
| GET | `/jobs` | All active jobs (JSON array) |
| GET | `/jobs/:project/:jobId` | Full materialized job state |
| GET | `/wiki/:project/*path` | Wiki file content (markdown) |

### SSE format

Content-Type: `text/event-stream`

Each message is prefixed with `data: ` and terminated with two newlines:

```
data: {"type":"event","ts":"...","project":"...","jobId":"...","event":{...}}

data: {"type":"wiki","ts":"...","project":"...","path":"...","action":"create|update|delete"}

data: {"type":"state","ts":"...","project":"...","jobId":"...","state":{...}}

data: {"type":"ping","ts":"..."}
```

- `event` -- A job event was written to the JSONL log
- `wiki` -- A wiki file was created, updated, or deleted
- `state` -- Initial state snapshot sent on connection
- `ping` -- Keepalive (every 15 seconds)

### Event types

These event types appear in the `event` field of SSE messages and in the JSONL event log:

| Event type | When it fires |
|------------|---------------|
| `job_created` | Job enqueued in the hub queue |
| `job_started` | Engine picks up the job and begins execution |
| `job_completed` | All phases finished successfully |
| `job_failed` | Job terminated with an unrecoverable error |
| `job_blocked` | Job waiting on external input or dependency |
| `job_cancelled` | Job cancelled by user |
| `job_panic` | Unexpected crash in job runner |
| `phase_started` | A phase (plan/execute/verify) begins |
| `phase_completed` | Phase finished successfully |
| `phase_failed` | Phase encountered an error |
| `phase_retry` | Phase is being retried |
| `phase_activity` | Progress/activity message from the phase |
| `phase_result` | Phase produced a result artifact |
| `phase_hook_diagnostic` | Diagnostic output from a phase hook |
| `job_approved` | Job approved after review |

## Interpreting results

### Job status values

A job's `status` field progresses through these states:

```
queued -> running -> completed | failed | blocked | cancelled
```

### Phase status

Each phase within a job has its own status:

```
pending -> running -> completed | failed | retrying
```

### Verdict format

The verify phase produces a verdict. There are two formats:

**Structured (v2)** -- JSON envelope:
```json
{
  "status": "pass|fail|inconclusive|infra_error",
  "layers": { ... },
  "blocking": [ ... ],
  "fix_scope": [ ... ],
  "summary": "..."
}
```

**Legacy (v1)** -- Text line in the verdict file:
```
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL
```

The engine normalizes `PARTIAL` to `fail`.

### Reading deliverables

After the execute phase completes, the deliverable is written to:
```
wiki/projects/{name}/outputs/deliverable-{id}.md
```

Use `cpb_wiki_read` to fetch it:
```
cpb_wiki_read({ project: "my-app", path: "outputs/deliverable-job-abc123.md" })
```

## Error handling

### Verdict: FAIL

The verify agent found problems. Check the verdict details:
1. Call `cpb_status` to see which phase failed and the error details
2. Read the verdict file via `cpb_wiki_read({ path: "outputs/verdict-{jobId}.md" })`
3. Check `blocking` array for specific issues that must be resolved
4. Re-enqueue with a refined task description addressing the blockers, or use `cpb retry`

### Verdict: PARTIAL (normalized to fail)

Some aspects passed but others did not. Same process as FAIL.

### Verdict: INCONCLUSIVE

The verifier could not determine pass or fail. Usually means:
- Tests were missing or inconclusive
- Build output was ambiguous
- Insufficient evidence to make a determination

Action: Review the execute phase output, then re-enqueue with more specific acceptance criteria.

### Verdict: INFRA_ERROR

Infrastructure failure (network, provider API, filesystem). Not a code quality issue.
Action: Check system health (`cpb doctor`), fix the infra issue, then retry.

### Job stuck in `blocked` state

The job is waiting for something. Check `cpb_status` for the block reason. Common causes:
- Waiting for human approval
- Dependency on another job
- Resource contention

### Phase retries

If a phase fails and retry logic is configured, you will see `phase_retry` events. The engine automatically retries with backoff. No action needed unless all retries are exhausted.

## Typical workflow

1. **Enqueue** a task:
   ```
   cpb_pipeline({ project: "my-app", task: "Add error handling to the auth module" })
   ```

2. **Monitor** progress (if stream server is running):
   ```
   cpb_stream_subscribe({ project: "my-app" })
   ```

3. **Check** status when done:
   ```
   cpb_status({ project: "my-app", jobId: "<from step 1>" })
   ```

4. **Read** the deliverable:
   ```
   cpb_wiki_read({ project: "my-app", path: "outputs/deliverable-<jobId>.md" })
   ```

5. **Review** the verdict:
   ```
   cpb_wiki_read({ project: "my-app", path: "outputs/verdict-<jobId>.md" })
   ```

6. **Handle** the result:
   - PASS: Accept the changes
   - FAIL: Address blockers and re-enqueue or retry
   - INCONCLUSIVE: Refine acceptance criteria
   - INFRA_ERROR: Fix infrastructure and retry
