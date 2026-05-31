#!/usr/bin/env node
// codegraph-mcp-server — Self-contained MCP server backed by built-in code intelligence.
// Transport: stdio (default) or SSE (--sse --port <N>).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..", "..", "server");

// --- CLI arg parsing ---

function parseArgs(argv) {
  const args = { codebaseRoot: process.cwd(), cpbRoot: null, sse: false, port: 3100 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--codebase-root" && argv[i + 1]) args.codebaseRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--cpb-root" && argv[i + 1]) args.cpbRoot = path.resolve(argv[++i]);
    else if (argv[i] === "--sse") args.sse = true;
    else if (argv[i] === "--port" && argv[i + 1]) args.port = parseInt(argv[++i], 10);
  }
  return args;
}

// --- Project context ---

function buildProjectContext(codebaseRoot, cpbRoot) {
  const runtimeRoot = cpbRoot
    ? path.join(cpbRoot, "cpb-task")
    : path.join(tmpdir(), "cpb-codegraph", createHash("md5").update(codebaseRoot).digest("hex").slice(0, 12));
  return {
    id: path.basename(codebaseRoot),
    sourcePath: codebaseRoot,
    projectRuntimeRoot: runtimeRoot,
  };
}

// --- MCP handler ---

class CodegraphMcpServer {
  constructor(codebaseRoot, cpbRoot) {
    this.project = buildProjectContext(codebaseRoot, cpbRoot);
    this._codeIndex = null;
    this._repoGraph = null;
  }

  async _loadCodeIndex() {
    if (!this._codeIndex) this._codeIndex = await import(path.join(SERVER_ROOT, "services", "project-code-index.js"));
    return this._codeIndex;
  }

  async _loadRepoGraph() {
    if (!this._repoGraph) this._repoGraph = await import(path.join(SERVER_ROOT, "services", "repo-graph.js"));
    return this._repoGraph;
  }

  async handleRequest(request) {
    const { method, params, id } = request;

    if (id === undefined && method?.startsWith("notifications/")) return null;

    try {
      let result;
      switch (method) {
        case "initialize": result = this._initialize(params); break;
        case "tools/list": result = this._toolsList(); break;
        case "tools/call": result = await this._toolsCall(params); break;
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      return { jsonrpc: "2.0", id, error: { code: -32000, message: err.message } };
    }
  }

  _initialize() {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "codegraph", title: "CodePatchbay CodeGraph", version: "1.0.0" },
    };
  }

  _toolsList() {
    return { tools: [
      {
        name: "list_files",
        description: "List project files with types, languages, and sizes",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Filter by file type (source, test, config, manifest, docs)" },
            language: { type: "string", description: "Filter by language" },
            limit: { type: "number", description: "Max files to return (default 50)" },
          },
        },
      },
      {
        name: "search_symbols",
        description: "Search for symbols (functions, classes) by name pattern",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Case-insensitive substring match" },
            kind: { type: "string", description: "Filter: function, class, struct, enum, trait" },
            limit: { type: "number", description: "Max results (default 30)" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_import_graph",
        description: "Get import dependency edges for the project or specific files",
        inputSchema: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: "Filter to edges involving these paths" },
          },
        },
      },
      {
        name: "impact_analysis",
        description: "Find files impacted by a change to a given file or module",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "File path or module name" },
            maxDepth: { type: "number", description: "Traversal depth (default 2)" },
          },
          required: ["target"],
        },
      },
      {
        name: "generate_context_pack",
        description: "Generate a context pack of relevant files for a task",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", description: "Task description" },
            target: { type: "string", description: "Optional file to focus on" },
            limit: { type: "number", description: "Max files (default 8)" },
          },
          required: ["task"],
        },
      },
    ] };
  }

  async _toolsCall(params) {
    const { name, arguments: args = {} } = params;
    switch (name) {
      case "list_files": return this._toolListFiles(args);
      case "search_symbols": return this._toolSearchSymbols(args);
      case "get_import_graph": return this._toolGetImportGraph(args);
      case "impact_analysis": return this._toolImpactAnalysis(args);
      case "generate_context_pack": return this._toolContextPack(args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }

  async _ensureIndex() {
    const ci = await this._loadCodeIndex();
    await ci.refreshProjectCodeIndex(this.project);
    const idxDir = ci.indexDirForProject(this.project);
    return idxDir;
  }

  async _toolListFiles(args) {
    const idxDir = await this._ensureIndex();
    const raw = JSON.parse(await readFile(path.join(idxDir, "files.json"), "utf8"));
    let files = raw.files || [];
    if (args.type) files = files.filter((f) => f.type === args.type);
    if (args.language) files = files.filter((f) => f.language === args.language);
    const limit = args.limit || 50;
    files = files.slice(0, limit);
    return { content: [{ type: "text", text: JSON.stringify({ files, total: raw.files?.length || 0, showing: files.length }, null, 2) }] };
  }

  async _toolSearchSymbols(args) {
    const query = (args.query || "").toLowerCase();
    if (!query) throw new Error("query is required");
    const idxDir = await this._ensureIndex();
    const raw = JSON.parse(await readFile(path.join(idxDir, "symbols.json"), "utf8"));
    let symbols = (raw.symbols || []).filter((s) => {
      if (!s.name?.toLowerCase().includes(query)) return false;
      if (args.kind && s.kind !== args.kind) return false;
      return true;
    });
    symbols = symbols.slice(0, args.limit || 30);
    return { content: [{ type: "text", text: JSON.stringify({ symbols }, null, 2) }] };
  }

  async _toolGetImportGraph(args) {
    const rg = await this._loadRepoGraph();
    const graph = await rg.buildRepoGraph(this.project);
    let edges = graph.edges || [];
    if (args.files?.length > 0) {
      const fileSet = new Set(args.files);
      edges = edges.filter((e) => fileSet.has(e.from) || fileSet.has(e.to));
    }
    return { content: [{ type: "text", text: JSON.stringify({ nodes: graph.stats.nodeCount, totalEdges: graph.stats.edgeCount, edges }, null, 2) }] };
  }

  async _toolImpactAnalysis(args) {
    if (!args.target) throw new Error("target is required");
    const rg = await this._loadRepoGraph();
    const graph = await rg.buildRepoGraph(this.project);
    const result = rg.queryRepoImpact(graph, this.project, args.target, { maxDepth: args.maxDepth || 2 });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  async _toolContextPack(args) {
    if (!args.task) throw new Error("task is required");
    const rg = await this._loadRepoGraph();
    const result = await rg.generateContextPack(this.project, { task: args.task, target: args.target || null, limit: args.limit || 8 });
    let content;
    try { content = await readFile(result.contextPack.path, "utf8"); } catch { content = JSON.stringify(result, null, 2); }
    return { content: [{ type: "text", text: content }] };
  }
}

// --- Stdio transport ---

function runStdio(server) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); } catch { return; }
    const response = await server.handleRequest(request);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
  rl.on("close", () => process.exit(0));
}

// --- SSE transport ---

function runSse(server, port) {
  const clients = new Map();
  let nextClientId = 0;

  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/sse" || req.url === "/sse/")) {
      const clientId = ++nextClientId;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const messageUrl = `http://localhost:${port}/message`;
      res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);
      clients.set(clientId, res);
      req.on("close", () => clients.delete(clientId));
    } else if (req.method === "POST" && (req.url === "/message" || req.url === "/message/")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const request = JSON.parse(body);
          const response = await server.handleRequest(request);
          if (response) {
            const payload = JSON.stringify(response);
            for (const [, client] of clients) {
              try { client.write(`event: message\ndata: ${payload}\n\n`); } catch {}
            }
          }
          res.writeHead(202, { "Content-Type": "text/plain" });
          res.end("accepted");
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(err.message);
        }
      });
    } else if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(port, () => {
    process.stderr.write(`[codegraph-mcp] SSE listening on http://localhost:${port}/sse\n`);
  });
  return httpServer;
}

// --- Entry ---

const args = parseArgs(process.argv);
const server = new CodegraphMcpServer(args.codebaseRoot, args.cpbRoot);

if (args.sse) {
  runSse(server, args.port);
} else {
  runStdio(server);
}
