import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  initProjectWikiPaths,
  initSessionPaths,
  ensureKnowledgePaths,
  projectWikiPath,
  projectMemoryPath,
  sessionPath,
} from "../server/services/knowledge-paths.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = path.join(await fs.mkdtemp("/tmp/cpb-kpath-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- project wiki paths ---

test("initProjectWikiPaths creates .cpb/wiki with standard subdirs", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await initProjectWikiPaths(sourcePath);

  const expected = [
    ".cpb",
    ".cpb/wiki",
    ".cpb/wiki/decisions",
    ".cpb/wiki/incidents",
    ".cpb/wiki/features",
    ".cpb/wiki/agents",
  ];
  for (const sub of expected) {
    const stat = await fs.stat(path.join(sourcePath, sub));
    assert.ok(stat.isDirectory(), `${sub} should be a directory`);
  }
});

test("initProjectWikiPaths is idempotent", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await initProjectWikiPaths(sourcePath);
  await initProjectWikiPaths(sourcePath);

  const stat = await fs.stat(path.join(sourcePath, ".cpb", "wiki"));
  assert.ok(stat.isDirectory());
});

test("projectWikiPath returns wiki root under sourcePath", () => {
  const p = projectWikiPath("/repo/myproject");
  assert.equal(p, path.join("/repo/myproject", ".cpb", "wiki"));
});

test("projectMemoryPath returns .cpb/memory.md under sourcePath", () => {
  const p = projectMemoryPath("/repo/myproject");
  assert.equal(p, path.join("/repo/myproject", ".cpb", "memory.md"));
});

// --- session paths ---

test("initSessionPaths creates cpb-task/sessions/<sessionId>", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await initSessionPaths(sourcePath, "sess-001");

  const stat = await fs.stat(path.join(sourcePath, "cpb-task", "sessions", "sess-001"));
  assert.ok(stat.isDirectory());
});

test("initSessionPaths is idempotent", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await initSessionPaths(sourcePath, "sess-001");
  await initSessionPaths(sourcePath, "sess-001");

  const stat = await fs.stat(path.join(sourcePath, "cpb-task", "sessions", "sess-001"));
  assert.ok(stat.isDirectory());
});

test("sessionPath returns session dir under cpb-task/sessions", () => {
  const p = sessionPath("/repo/myproject", "sess-042");
  assert.equal(p, path.join("/repo/myproject", "cpb-task", "sessions", "sess-042"));
});

// --- ensureKnowledgePaths (all-in-one) ---

test("ensureKnowledgePaths creates both wiki and session paths", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await ensureKnowledgePaths(sourcePath, "sess-999");

  const wikiStat = await fs.stat(path.join(sourcePath, ".cpb", "wiki"));
  const sessStat = await fs.stat(path.join(sourcePath, "cpb-task", "sessions", "sess-999"));
  assert.ok(wikiStat.isDirectory());
  assert.ok(sessStat.isDirectory());
});

// --- path traversal safety ---

test("initProjectWikiPaths rejects path traversal in sourcePath", async () => {
  await assert.rejects(
    () => initProjectWikiPaths("/tmp/evil/../etc"),
    /traversal/,
  );
});

test("initSessionPaths rejects path traversal in sessionId", async () => {
  const sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath);

  await assert.rejects(
    () => initSessionPaths(sourcePath, "../escape"),
    /traversal/,
  );
});

test("initSessionPaths rejects path traversal in sourcePath", async () => {
  await assert.rejects(
    () => initSessionPaths("/tmp/evil/../etc", "sess-ok"),
    /traversal/,
  );
});
