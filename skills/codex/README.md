# CPB Skill for Codex CLI

Use CodePatchBay's plan-execute-verify pipeline from within Codex sessions via MCP tools.

## What it does

This skill lets Codex (Zed's AI coding agent) call CPB operations as native MCP tools. Codex can enqueue pipelines, inspect job status, list projects, read wiki files, and subscribe to streaming events -- all through structured tool calls without shelling out.

## MCP Tools provided

The MCP server (`skills/claude-code/cpb-mcp-server.ts`) is shared between Claude Code and Codex. It exposes these tools:

| Tool | Description |
|------|-------------|
| `cpb_pipeline` | Enqueue a pipeline task, returns jobId |
| `cpb_status` | Get materialized job state for a project/job |
| `cpb_list` | List registered CPB projects |
| `cpb_stream_subscribe` | Fetch recent events from the streaming server |
| `cpb_wiki_read` | Read a wiki file for a project |
| `cpb_wiki_list` | List wiki files for a project |

## Configuration

### Option A: Project-level instructions + MCP

Add to your Codex project config (`.codex/config.json` or equivalent):

```json
{
  "instructions": "skills/codex/cpb-instructions.md",
  "mcpServers": {
    "cpb": {
      "command": "node",
      "args": ["/absolute/path/to/codepatchbay/skills/claude-code/cpb-mcp-server.ts"],
      "env": {
        "CPB_ROOT": "/absolute/path/to/codepatchbay"
      }
    }
  }
}
```

### Option B: Global settings

Copy `cpb-mcp-config.json` into your Codex MCP server settings directory and adjust the `CPB_ROOT` path.

### Option C: `--instructions` flag

```bash
codex --instructions skills/codex/cpb-instructions.md "Run a CPB pipeline for my-app: Add dark mode"
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CPB_ROOT` | `process.cwd()` | Path to CodePatchBay checkout |
| `CPB_HUB_ROOT` | `~/.cpb` | Hub registry root |
| `CPB_STREAM_HOST` | `127.0.0.1` | Streaming server host |
| `CPB_STREAM_PORT` | `9741` | Streaming server port |

## Streaming server

The streaming server must be running separately for `cpb_stream_subscribe` to work:

```bash
cpb stream --port 9741
```

See `cpb-instructions.md` for the full streaming protocol reference.

## Prerequisites

- Node.js 20+ (for ESM dynamic imports and `fetch`)
- CodePatchBay checkout with dependencies installed (`npm install`)
- `cpb stream` running for real-time event subscription

## Architecture

```
Codex CLI
  |
  | MCP stdio JSON-RPC
  v
cpb-mcp-server.ts  (shared with claude-code skill)
  |
  +-- server/services/hub/hub-registry.ts   (listProjects, getProject)
  +-- server/services/hub/hub-queue.ts      (enqueue, listQueue)
  +-- server/services/event/event-store.ts   (readEvents, materializeJob)
  +-- wiki/ filesystem                       (read wiki files)
  +-- HTTP to stream server                  (cpb_stream_subscribe)
```

All data access goes through CPB's existing Node.js APIs. The MCP server is a thin wrapper -- no duplication of business logic.
