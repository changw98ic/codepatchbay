# CPB MCP Server for Claude Code

Expose CodePatchBay tools directly inside Claude Code via the Model Context Protocol (MCP).

## What it does

This MCP server lets Claude Code call CPB operations as native tools -- no shelling out to `cpb` CLI. Claude can enqueue pipelines, inspect job status, list projects, and read wiki files through structured tool calls.

## Tools provided

| Tool | Description |
|------|-------------|
| `cpb_pipeline` | Enqueue a pipeline task, returns jobId |
| `cpb_status` | Get materialized job state for a project/job |
| `cpb_list` | List registered projects |
| `cpb_stream_subscribe` | Fetch recent events from the streaming server |
| `cpb_wiki_read` | Read a wiki file for a project |
| `cpb_wiki_list` | List wiki files for a project |

## Installation

### Quick install

```bash
cd /path/to/codepatchbay
bash skills/claude-code/install.sh
```

This adds the MCP server entry to `~/.claude/settings.json`. Claude Code picks it up on next launch.

### Manual configuration

Add this to `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
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

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CPB_ROOT` | `process.cwd()` | Path to CodePatchBay checkout |
| `CPB_HUB_ROOT` | `~/.cpb` | Hub registry root |
| `CPB_STREAM_HOST` | `127.0.0.1` | Streaming server host |
| `CPB_STREAM_PORT` | `9741` | Streaming server port |

### Prerequisite

The MCP server imports from `dist/` (compiled JS). Make sure the project is built:

```bash
cd /path/to/codepatchbay
npm run build   # or however dist/ is generated
```

## Usage in Claude Code

Once configured, Claude Code can call the tools directly:

```
> Enqueue a pipeline for my-app: "Add dark mode toggle"
```

Claude will call `cpb_pipeline` with `{ project: "my-app", task: "Add dark mode toggle" }` and return the jobId.

```
> What's the status of job abc123 in my-app?
```

Claude will call `cpb_status` with `{ project: "my-app", jobId: "abc123" }`.

### Monitoring with streaming

Start the streaming server first:

```bash
cpb stream --port 9741
```

Then Claude can call `cpb_stream_subscribe` to pull recent events and show progress.

## Development

The server is a single TypeScript file using Node.js built-in fetch and MCP SDK stdio transport. No build step needed -- run it directly with `node`.

```bash
# Test the server manually
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}' | \
  CPB_ROOT=/path/to/codepatchbay node skills/claude-code/cpb-mcp-server.ts
```

## Architecture

```
Claude Code
  |
  | MCP stdio JSON-RPC
  v
cpb-mcp-server.ts
  |
  +-- server/services/hub/hub-registry.ts   (listProjects, getProject)
  +-- server/services/hub/hub-queue.ts      (enqueue, listQueue)
  +-- server/services/event/event-store.ts   (readEvents, materializeJob)
  +-- wiki/ filesystem                       (read wiki files)
  +-- HTTP to stream server                  (cpb_stream_subscribe)
```

All data access goes through CPB's existing Node.js APIs. The MCP server is a thin wrapper -- no duplication of business logic.
