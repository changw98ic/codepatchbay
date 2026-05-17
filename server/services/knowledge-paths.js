import fs from "node:fs/promises";
import path from "node:path";

const WIKI_SUBDIRS = ["decisions", "incidents", "features", "agents"];

function assertNoTraversal(raw) {
  if (typeof raw === "string" && raw.includes("..")) {
    throw new Error(`path traversal detected in: ${raw}`);
  }
}

export function projectWikiPath(sourcePath) {
  return path.join(path.resolve(sourcePath), ".cpb", "wiki");
}

export function projectMemoryPath(sourcePath) {
  return path.join(path.resolve(sourcePath), ".cpb", "memory.md");
}

export function sessionPath(sourcePath, sessionId) {
  return path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId);
}

export async function initProjectWikiPaths(sourcePath) {
  assertNoTraversal(sourcePath);
  const wikiRoot = projectWikiPath(sourcePath);
  await fs.mkdir(wikiRoot, { recursive: true });
  for (const sub of WIKI_SUBDIRS) {
    await fs.mkdir(path.join(wikiRoot, sub), { recursive: true });
  }
}

export async function initSessionPaths(sourcePath, sessionId) {
  assertNoTraversal(sourcePath);
  assertNoTraversal(sessionId);
  if (sessionId.includes("/") || sessionId.includes(path.sep)) {
    throw new Error(`path traversal detected in sessionId: ${sessionId}`);
  }
  const sessDir = sessionPath(sourcePath, sessionId);
  await fs.mkdir(sessDir, { recursive: true });
}

export async function ensureKnowledgePaths(sourcePath, sessionId) {
  await initProjectWikiPaths(sourcePath);
  await initSessionPaths(sourcePath, sessionId);
}
