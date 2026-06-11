import fs from "node:fs/promises";
import path from "node:path";

const WIKI_SUBDIRS = ["decisions", "incidents", "features", "agents"];
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function assertNoTraversal(raw: string) {
  if (typeof raw === "string" && raw.includes("..")) {
    throw new Error(`path traversal detected in: ${raw}`);
  }
}

export function projectWikiPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "wiki");
}

export function projectMemoryPath(sourcePath: string) {
  return path.join(path.resolve(sourcePath), ".cpb", "memory.md");
}

export function assertSafeSessionId(sessionId: string) {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
}

export function resolveKnowledgeDataRoot({ projectRuntimeRoot, dataRoot }: Record<string, any> = {}) {
  const root = projectRuntimeRoot || dataRoot;
  if (!root || !String(root).trim()) {
    throw new Error("projectRuntimeRoot or dataRoot is required");
  }
  return path.resolve(String(root));
}

export function sessionPath(sourcePath: string, sessionId: string, options: Record<string, any> = {}) {
  assertNoTraversal(sourcePath);
  assertSafeSessionId(sessionId);
  return path.join(resolveKnowledgeDataRoot(options), "sessions", sessionId);
}

export async function initProjectWikiPaths(sourcePath: string) {
  assertNoTraversal(sourcePath);
  const wikiRoot = projectWikiPath(sourcePath);
  await fs.mkdir(wikiRoot, { recursive: true });
  for (const sub of WIKI_SUBDIRS) {
    await fs.mkdir(path.join(wikiRoot, sub), { recursive: true });
  }
}

export async function initSessionPaths(sourcePath: string, sessionId: string, options: Record<string, any> = {}) {
  const sessDir = sessionPath(sourcePath, sessionId, options);
  await fs.mkdir(sessDir, { recursive: true });
}

export async function ensureKnowledgePaths(sourcePath: string, sessionId: string, options: Record<string, any> = {}) {
  await initProjectWikiPaths(sourcePath);
  await initSessionPaths(sourcePath, sessionId, options);
}
