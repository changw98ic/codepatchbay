#!/usr/bin/env node
// cpb-mcp-server.ts — MCP server exposing CPB tools to Claude Code
// Run with: CPB_ROOT=/path/to/codepatchbay node skills/claude-code/cpb-mcp-server.ts

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// ── CPB service imports ────────────────────────────────────────────────────
const CPB_ROOT = process.env.CPB_ROOT || process.cwd();

// Import from compiled dist/ — CPB ships pre-compiled JS under dist/.
const {
  listProjects,
  getProject,
  resolveHubRoot,
} = await import("../../dist/server/services/hub/hub-registry.js");

const {
  enqueue,
  listQueue,
} = await import("../../dist/server/services/hub/hub-queue.js");

const {
  readEvents,
  materializeJob,
  listEventFiles,
} = await import("../../dist/server/services/event/event-store.js");

// ── Minimal MCP SDK (inline to avoid dependency) ───────────────────────────
// MCP stdio transport: read JSON-RPC from stdin, write to stdout.
// We implement just enough of the protocol for Claude Code.

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

function reply(res: JsonRpcResponse) {
  process.stdout.write(JSON.stringify(res) + "\n");
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "cpb_pipeline",
    description:
      "Enqueue a CPB pipeline task. Returns the jobId. The pipeline runs plan -> execute -> verify automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Project ID (registered via `cpb init`)",
        },
        task: {
          type: "string",
          description: "Natural language task description",
        },
        priority: {
          type: "string",
          enum: ["P0", "P1", "P2", "P3"],
          description: "Priority level (default P3)",
        },
      },
      required: ["project", "task"],
    },
  },
  {
    name: "cpb_status",
    description:
      "Get the materialized state of a job. Includes phase, status, artifacts, retries, and failure info.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID" },
        jobId: { type: "string", description: "Job ID" },
      },
      required: ["project", "jobId"],
    },
  },
  {
    name: "cpb_list",
    description: "List registered CPB projects with their status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        enabledOnly: {
          type: "boolean",
          description: "Only return enabled projects (default false)",
        },
      },
    },
  },
  {
    name: "cpb_stream_subscribe",
    description:
      "Fetch recent events from the CPB streaming server (SSE). Requires `cpb stream` to be running.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description: "Filter events to this project (optional)",
        },
        limit: {
          type: "number",
          description: "Max events to return (default 20)",
        },
      },
    },
  },
  {
    name: "cpb_wiki_read",
    description: "Read a wiki file for a CPB project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID" },
        path: {
          type: "string",
          description: "Wiki file path relative to project wiki root (e.g. 'inbox/plan-abc.md')",
        },
      },
      required: ["project", "path"],
    },
  },
  {
    name: "cpb_wiki_list",
    description: "List wiki files for a CPB project.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: { type: "string", description: "Project ID" },
        subdir: {
          type: "string",
          description: "Subdirectory to list (e.g. 'inbox', 'outputs'). Default: root.",
        },
      },
      required: ["project"],
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────────────────

async function handleCpbPipeline(params: Record<string, any>) {
  const hubRoot = resolveHubRoot(CPB_ROOT);
  const entry = await enqueue(hubRoot, {
    projectId: params.project,
    description: params.task,
    priority: params.priority || "P3",
  });
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          jobId: entry.id,
          status: entry.status,
          project: params.project,
          task: params.task,
        }),
      },
    ],
  };
}

async function handleCpbStatus(params: Record<string, any>) {
  const events = await readEvents(CPB_ROOT, params.project, params.jobId);
  if (!events || events.length === 0) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Job not found", jobId: params.jobId }) }],
    };
  }
  const state = materializeJob(events);
  return {
    content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
  };
}

async function handleCpbList(params: Record<string, any>) {
  const hubRoot = resolveHubRoot(CPB_ROOT);
  const projects = await listProjects(hubRoot, {
    enabledOnly: params.enabledOnly || false,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
  };
}

async function handleCpbStreamSubscribe(params: Record<string, any>) {
  const host = process.env.CPB_STREAM_HOST || "127.0.0.1";
  const port = process.env.CPB_STREAM_PORT || "9741";
  const limit = params.limit || 20;
  const url = `http://${host}:${port}/jobs`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Stream server returned ${res.status}`, hint: "Is `cpb stream` running?" }) }],
      };
    }
    const jobs = await res.json() as any[];
    const filtered = params.project
      ? jobs.filter((j) => j.project === params.project)
      : jobs;
    return {
      content: [{ type: "text", text: JSON.stringify(filtered.slice(0, limit), null, 2) }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message, hint: "Start with `cpb stream --port 9741`" }) }],
    };
  }
}

async function handleCpbWikiRead(params: Record<string, any>) {
  const hubRoot = resolveHubRoot(CPB_ROOT);
  const proj = await getProject(hubRoot, params.project);
  if (!proj || !proj.sourcePath) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Project not found", project: params.project }) }],
    };
  }
  const wikiRoot = path.join(CPB_ROOT, "wiki", "projects", params.project);
  const filePath = path.resolve(wikiRoot, params.path);
  // Prevent path traversal (must check with path.sep to block sibling dirs like wiki-backup/)
  if (!filePath.startsWith(wikiRoot + path.sep) && filePath !== wikiRoot) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Path traversal denied" }) }],
    };
  }
  try {
    const content = await readFile(filePath, "utf8");
    return { content: [{ type: "text", text: content }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message, path: params.path }) }],
    };
  }
}

async function handleCpbWikiList(params: Record<string, any>) {
  const hubRoot = resolveHubRoot(CPB_ROOT);
  const proj = await getProject(hubRoot, params.project);
  if (!proj || !proj.sourcePath) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Project not found", project: params.project }) }],
    };
  }
  const wikiRoot = path.join(CPB_ROOT, "wiki", "projects", params.project);
  const targetDir = params.subdir ? path.resolve(wikiRoot, params.subdir) : wikiRoot;
  if (!targetDir.startsWith(wikiRoot + path.sep) && targetDir !== wikiRoot) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: "Path traversal denied" }) }],
    };
  }
  try {
    const entries = await readdir(targetDir, { withFileTypes: true });
    const files = entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "directory" : "file",
    }));
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
    };
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────

const HANDLERS: Record<string, (params: any) => Promise<any>> = {
  cpb_pipeline: handleCpbPipeline,
  cpb_status: handleCpbStatus,
  cpb_list: handleCpbList,
  cpb_stream_subscribe: handleCpbStreamSubscribe,
  cpb_wiki_read: handleCpbWikiRead,
  cpb_wiki_list: handleCpbWikiList,
};

// ── MCP protocol handler (stdio) ──────────────────────────────────────────

const SERVER_INFO = {
  name: "cpb",
  version: "0.1.0",
};

const CAPABILITIES = {
  tools: {},
};

let initialized = false;

// Serialize requests so stdin-end waits for in-flight handlers.
let inflight: Promise<void> = Promise.resolve();

// Read JSON-RPC lines from stdin
const decoder = new TextDecoder();
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    // Chain onto inflight so requests are processed sequentially.
    inflight = inflight.then(() => handleRequest(req)).catch((err) => {
      reply({
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32603, message: String(err?.message || err) },
      });
    });
  }
});

async function handleRequest(req: JsonRpcRequest) {
  const { method, params, id } = req;

  if (method === "initialize") {
    initialized = true;
    return reply({
      jsonrpc: "2.0",
      id: id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: CAPABILITIES,
        serverInfo: SERVER_INFO,
      },
    });
  }

  if (method === "notifications/initialized") {
    // Client ack of initialize -- no response needed for notifications
    return;
  }

  if (method === "tools/list") {
    return reply({
      jsonrpc: "2.0",
      id: id ?? null,
      result: { tools: TOOLS },
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolParams = params?.arguments || {};
    const handler = HANDLERS[toolName];
    if (!handler) {
      return reply({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      });
    }
    const result = await handler(toolParams);
    return reply({ jsonrpc: "2.0", id: id ?? null, result });
  }

  // Method not found
  return reply({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

process.stdin.on("end", () => {
  // Wait for any in-flight request to finish before exiting.
  inflight.then(() => process.exit(0), () => process.exit(1));
});
