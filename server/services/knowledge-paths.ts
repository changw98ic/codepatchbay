import fs from "node:fs/promises";
import path from "node:path";

const WIKI_SUBDIRS = ["decisions", "incidents", "features", "agents"];

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

export function sessionPath(sourcePath: string, sessionId: string) {
  return path.join(path.resolve(sourcePath), "cpb-task", "sessions", sessionId);
}

export async function initProjectWikiPaths(sourcePath: string) {
  assertNoTraversal(sourcePath);
  const wikiRoot = projectWikiPath(sourcePath);
  await fs.mkdir(wikiRoot, { recursive: true });
  for (const sub of WIKI_SUBDIRS) {
    await fs.mkdir(path.join(wikiRoot, sub), { recursive: true });
  }
}

export async function initSessionPaths(sourcePath: string, sessionId: string) {
  assertNoTraversal(sourcePath);
  assertNoTraversal(sessionId);
  if (sessionId.includes("/") || sessionId.includes(path.sep)) {
    throw new Error(`path traversal detected in sessionId: ${sessionId}`);
  }
  const sessDir = sessionPath(sourcePath, sessionId);
  await fs.mkdir(sessDir, { recursive: true });
}

export async function ensureKnowledgePaths(sourcePath: string, sessionId: string) {
  await initProjectWikiPaths(sourcePath);
  await initSessionPaths(sourcePath, sessionId);
}
