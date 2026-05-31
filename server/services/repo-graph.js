import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  indexDirForProject,
  refreshProjectCodeIndex,
  readProjectCodeIndexStatus,
} from "./project-code-index.js";
import { projectRuntimeRoot } from "./runtime-root.js";

const SCHEMA_VERSION = 1;
const MAX_SOURCE_BYTES = 256 * 1024;
const DEFAULT_CONTEXT_FILE_LIMIT = 8;

const IMPORT_EXTENSIONS = [
  "",
  ".js", ".mjs", ".cjs", ".jsx",
  ".ts", ".mts", ".cts", ".tsx",
  ".json", ".css",
];

const IMPORT_INDEX_EXTENSIONS = [
  "index.js", "index.mjs", "index.cjs", "index.jsx",
  "index.ts", "index.mts", "index.cts", "index.tsx",
  "index.json", "index.css",
];

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function runtimeRootFor(project, hubRoot) {
  if (project.projectRuntimeRoot) return project.projectRuntimeRoot;
  if (hubRoot) return projectRuntimeRoot(hubRoot, project.id);
  throw new Error(`cannot resolve runtime root for project ${project.id}`);
}

export function repoGraphDirForProject(project, hubRoot) {
  return path.join(runtimeRootFor(project, hubRoot), "graph");
}

export function repoGraphPathForProject(project, hubRoot) {
  return path.join(repoGraphDirForProject(project, hubRoot), "repo-graph.json");
}

export function contextPackDirForProject(project, hubRoot) {
  return path.join(runtimeRootFor(project, hubRoot), "context-packs");
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeTarget(project, target) {
  const raw = String(target || "").trim();
  if (!raw) return "";
  const normalized = toPosix(path.normalize(raw));
  if (path.isAbsolute(raw) && project.sourcePath) {
    const rel = path.relative(project.sourcePath, raw);
    return toPosix(rel);
  }
  return normalized.replace(/^\.\//, "");
}

function isRelativeSpecifier(specifier) {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function importSpecifiers(content) {
  const specs = [];
  const pattern = /\bimport\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']|\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(content))) {
    specs.push(match[1] || match[2]);
  }
  return specs;
}

function resolveImport(fromPath, specifier, fileSet) {
  if (!isRelativeSpecifier(specifier)) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [];

  if (path.posix.extname(base)) {
    candidates.push(base);
  } else {
    for (const ext of IMPORT_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const indexFile of IMPORT_INDEX_EXTENSIONS) candidates.push(path.posix.join(base, indexFile));
  }

  return candidates.find((candidate) => fileSet.has(candidate)) || null;
}

function nodeForFile(file, symbolsByPath) {
  return {
    id: file.path,
    path: file.path,
    type: file.type || "other",
    language: file.language || null,
    size: file.size || 0,
    symbols: symbolsByPath.get(file.path) || [],
  };
}

async function extractImportEdges(project, files) {
  const fileSet = new Set(files.map((file) => file.path));
  const edges = [];
  const seen = new Set();
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (![".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"].includes(ext)) continue;
    let content;
    try {
      const buffer = await readFile(path.join(project.sourcePath, file.path));
      if (buffer.length > MAX_SOURCE_BYTES) continue;
      content = buffer.toString("utf8");
    } catch {
      continue;
    }

    for (const specifier of importSpecifiers(content)) {
      const target = resolveImport(file.path, specifier, fileSet);
      if (!target) continue;
      const key = `${file.path}\0${target}\0import`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: file.path, to: target, kind: "import", specifier });
    }
  }
  return edges.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
}

function symbolsByPath(symbols) {
  const grouped = new Map();
  for (const symbol of symbols || []) {
    if (!symbol?.path) continue;
    const current = grouped.get(symbol.path) || [];
    current.push({
      name: symbol.name,
      kind: symbol.kind || "symbol",
      line: symbol.line || null,
    });
    grouped.set(symbol.path, current);
  }
  return grouped;
}

function graphHash(nodes, edges) {
  return createHash("sha256")
    .update(JSON.stringify(nodes.map((node) => [node.path, node.type, node.language, node.size])))
    .update(JSON.stringify(edges.map((edge) => [edge.from, edge.to, edge.kind])))
    .digest("hex")
    .slice(0, 16);
}

export async function buildRepoGraph(project, { hubRoot } = {}) {
  if (!project?.sourcePath) throw new Error(`project ${project?.id || "(unknown)"} has no sourcePath`);

  const indexStatus = await refreshProjectCodeIndex(project, { hubRoot });
  const idxDir = indexDirForProject(project, hubRoot);
  const filesArtifact = await readJson(path.join(idxDir, "files.json"), { files: [] });
  const symbolsArtifact = await readJson(path.join(idxDir, "symbols.json"), { symbols: [] });
  const files = Array.isArray(filesArtifact.files) ? filesArtifact.files : [];
  const symbols = Array.isArray(symbolsArtifact.symbols) ? symbolsArtifact.symbols : [];
  const groupedSymbols = symbolsByPath(symbols);
  const nodes = files.map((file) => nodeForFile(file, groupedSymbols));
  const edges = await extractImportEdges(project, files);
  const builtAt = new Date().toISOString();
  const graphPath = repoGraphPathForProject(project, hubRoot);
  const graph = {
    schemaVersion: SCHEMA_VERSION,
    projectId: project.id,
    sourcePath: project.sourcePath,
    graphPath,
    builtAt,
    index: indexStatus,
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      symbolCount: symbols.length,
    },
    contentHash: graphHash(nodes, edges),
  };

  await writeAtomic(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  return graph;
}

export async function readRepoGraph(project, { hubRoot } = {}) {
  return readJson(repoGraphPathForProject(project, hubRoot));
}

export async function ensureRepoGraph(project, { hubRoot, refresh = false } = {}) {
  if (refresh) return buildRepoGraph(project, { hubRoot });
  const existing = await readRepoGraph(project, { hubRoot });
  if (existing?.schemaVersion === SCHEMA_VERSION && Array.isArray(existing.nodes) && Array.isArray(existing.edges)) {
    const status = await readProjectCodeIndexStatus(project, { hubRoot });
    if (status.status === "ready" && status.contentHash === existing.index?.contentHash) return existing;
  }
  return buildRepoGraph(project, { hubRoot });
}

function selectSeedFiles(graph, project, target) {
  const normalized = normalizeTarget(project, target);
  if (!normalized) return [];
  const nodes = graph.nodes || [];
  const exact = nodes.find((node) => node.path === normalized);
  if (exact) return [exact.path];

  const lower = normalized.toLowerCase();
  const pathMatches = nodes
    .filter((node) => node.path.toLowerCase().includes(lower))
    .map((node) => node.path);
  if (pathMatches.length > 0) return pathMatches.slice(0, 5);

  const symbolMatches = [];
  for (const node of nodes) {
    if ((node.symbols || []).some((symbol) => String(symbol.name || "").toLowerCase().includes(lower))) {
      symbolMatches.push(node.path);
    }
  }
  return [...new Set(symbolMatches)].slice(0, 5);
}

export function queryRepoImpact(graph, project, target, { maxDepth = 2 } = {}) {
  const seeds = selectSeedFiles(graph, project, target);
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of graph.edges || []) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  const impacted = new Set(seeds);
  const reasons = seeds.map((file) => ({ file, kind: "target", via: null, depth: 0 }));
  const queue = seeds.map((file) => ({ file, depth: 0 }));
  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth >= maxDepth) continue;

    for (const edge of outgoing.get(current.file) || []) {
      if (!impacted.has(edge.to)) {
        impacted.add(edge.to);
        reasons.push({ file: edge.to, kind: "dependency", via: edge.from, depth: current.depth + 1 });
        queue.push({ file: edge.to, depth: current.depth + 1 });
      }
    }

    for (const edge of incoming.get(current.file) || []) {
      if (!impacted.has(edge.from)) {
        impacted.add(edge.from);
        reasons.push({ file: edge.from, kind: "dependent", via: edge.to, depth: current.depth + 1 });
        queue.push({ file: edge.from, depth: current.depth + 1 });
      }
    }
  }

  return {
    target: normalizeTarget(project, target),
    seeds,
    impactedFiles: [...impacted].sort(),
    reasons: reasons.sort((a, b) => a.file.localeCompare(b.file) || a.kind.localeCompare(b.kind)),
  };
}

function taskKeywords(task) {
  return [...new Set(String(task || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.\/-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3))];
}

function scoreNode(node, keywords) {
  const haystack = [
    node.path,
    node.type,
    node.language,
    ...(node.symbols || []).map((symbol) => symbol.name),
  ].join(" ").toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += keyword.includes("/") ? 4 : 2;
  }
  if (node.type === "source") score += 1;
  if (node.type === "manifest") score += 1;
  if (node.path.toLowerCase().includes("readme")) score += 1;
  return score;
}

function selectContextFiles(graph, project, { task, target, limit = DEFAULT_CONTEXT_FILE_LIMIT } = {}) {
  if (target) {
    return queryRepoImpact(graph, project, target, { maxDepth: 2 }).impactedFiles.slice(0, limit);
  }

  const keywords = taskKeywords(task);
  const scored = (graph.nodes || [])
    .map((node) => ({ node, score: scoreNode(node, keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path));

  if (scored.length > 0) {
    const primary = scored[0].node.path;
    return queryRepoImpact(graph, project, primary, { maxDepth: 1 }).impactedFiles.slice(0, limit);
  }

  return (graph.nodes || [])
    .filter((node) => ["manifest", "docs", "source", "test"].includes(node.type))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((node) => node.path);
}

function renderContextPack({ project, graph, task, target, files }) {
  const lines = [];
  lines.push("# Context Pack");
  lines.push("");
  lines.push(`- Project: ${project.id}`);
  if (task) lines.push(`- Task: ${task}`);
  if (target) lines.push(`- Target: ${target}`);
  lines.push(`- RepoGraph: ${graph.graphPath}`);
  lines.push(`- Graph nodes: ${graph.stats?.nodeCount || 0}`);
  lines.push(`- Graph edges: ${graph.stats?.edgeCount || 0}`);
  lines.push("");
  lines.push("## Files");
  for (const filePath of files) {
    const node = graph.nodes.find((entry) => entry.path === filePath);
    const detail = [node?.type, node?.language].filter(Boolean).join(", ");
    lines.push(`- \`${filePath}\`${detail ? ` (${detail})` : ""}`);
  }
  lines.push("");
  lines.push("## Impact Edges");
  const fileSet = new Set(files);
  const relevantEdges = (graph.edges || []).filter((edge) => fileSet.has(edge.from) || fileSet.has(edge.to));
  if (relevantEdges.length === 0) {
    lines.push("- No local import edges found for selected files.");
  } else {
    for (const edge of relevantEdges.slice(0, 30)) {
      lines.push(`- \`${edge.from}\` -> \`${edge.to}\` (${edge.kind})`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function generateContextPack(project, { hubRoot, task = "", target = null, limit = DEFAULT_CONTEXT_FILE_LIMIT, jobId = null, producerAgent = null } = {}) {
  const graph = await ensureRepoGraph(project, { hubRoot, refresh: true });
  const files = selectContextFiles(graph, project, { task, target, limit });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const contextDir = contextPackDirForProject(project, hubRoot);
  const contextPath = path.join(contextDir, `context-pack-${ts}.md`);
  const content = renderContextPack({ project, graph, task, target, files });
  await writeAtomic(contextPath, content);

  const fileSet = new Set(files);
  const relevantEdges = (graph.edges || []).filter((edge) => fileSet.has(edge.from) || fileSet.has(edge.to));

  return {
    status: "ready",
    projectId: project.id,
    graphPath: graph.graphPath,
    stats: graph.stats,
    contextPack: {
      schemaVersion: 2,
      kind: "context-pack",
      id: ts,
      name: `context-pack-${ts}`,
      path: contextPath,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      project: project.id,
      jobId,
      phase: null,
      producerAgent,
      createdAt: new Date().toISOString(),
      task,
      target,
      files,
      edges: relevantEdges.slice(0, 30).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
      graphStats: graph.stats || null,
      graphPath: graph.graphPath,
    },
  };
}
