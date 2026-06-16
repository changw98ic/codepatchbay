# CPB OpenClaw Skill

CodePatchbay (CPB) integration for OpenClaw agents. Provides real-time
streaming access to CPB's multi-agent pipeline orchestration system.

## What CPB Provides

CPB runs plan -> execute -> verify pipelines for coding tasks. Each pipeline
produces durable events (JSONL event log) and wiki artifacts (markdown files
in `inbox/`, `outputs/`). OpenClaw agents can:

- **Trigger pipelines** by enqueuing tasks via the `cpb_pipeline` tool.
- **Monitor progress** through the SSE streaming interface at `:9741/stream`.
- **Read wiki content** (plans, deliverables, verdicts) via the HTTP wiki
  endpoint at `:9741/wiki/:project/*path`.

## Connecting to the Streaming Interface

1. Ensure the CPB stream server is running:

   ```bash
   cpb stream --port 9741
   ```

2. Connect an SSE client to `http://127.0.0.1:9741/stream` (all projects) or
   `http://127.0.0.1:9741/stream?project=my-app` (filtered).

3. Use the `adapter.py` module in this directory for a ready-made Python
   client that handles reconnection and structured event parsing.

### SSE Event Format

Each server-sent event is a single `data:` line containing JSON:

```
data: {"type":"event","ts":"2026-06-12T10:00:00Z","project":"my-app","jobId":"job-abc123","event":{...}}
data: {"type":"wiki","ts":"2026-06-12T10:00:05Z","project":"my-app","path":"outputs/verdict-42.md","action":"create"}
data: {"type":"ping","ts":"2026-06-12T10:00:30Z"}
```

## Triggering Pipeline Runs

Use the `cpb_pipeline` tool or call the CLI directly:

```bash
cpb pipeline my-project "Add dark mode toggle" 3
cpb run "Fix login bug" --project my-project
```

The command enqueues a job and returns a `jobId`. Track it via the stream or
poll `GET /jobs/:project/:jobId`.

## Reading Wiki Content

Wiki files are served over HTTP:

```
GET /wiki/my-app/inbox/plan-42.md
GET /wiki/my-app/outputs/deliverable-42.md
GET /wiki/my-app/outputs/verdict-42.md
```

Verdict files contain a machine-parseable line:

```
VERDICT: PASS
```

Read this line to determine pipeline outcome without parsing the full markdown.
