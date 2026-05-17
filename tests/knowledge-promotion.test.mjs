import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { findPromotionCandidates, classifyKnowledgeKind } from "../server/services/knowledge-policy.js";

let tmpDir;
let sourcePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join("/tmp", "cpb-promo-test-"));
  sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(sourcePath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("findPromotionCandidates returns empty for project with no sessions", async () => {
  const candidates = await findPromotionCandidates(sourcePath);
  assert.equal(candidates.length, 0);
});

test("findPromotionCandidates finds session memory eligible for promotion", async () => {
  const sessionId = "sess-001";
  const sessionDir = path.join(sourcePath, "cpb-task", "sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "memory.md"), "discovered pattern X useful", "utf8");

  const candidates = await findPromotionCandidates(sourcePath, { sessionId });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, "session-memory");
  assert.equal(candidates[0].targetKind, "project-memory");
  assert.ok(candidates[0].from.includes("sess-001"));
  assert.ok(candidates[0].targetPath.endsWith(".cpb/memory.md"));
  assert.ok(candidates[0].size > 0);
});

test("findPromotionCandidates finds multiple sessions", async () => {
  for (const sid of ["sess-a", "sess-b"]) {
    const sessionDir = path.join(sourcePath, "cpb-task", "sessions", sid);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "memory.md"), `notes from ${sid}`, "utf8");
  }

  const candidates = await findPromotionCandidates(sourcePath);
  assert.equal(candidates.length, 2);
  const sessions = candidates.map((c) => c.session).sort();
  assert.deepEqual(sessions, ["sess-a", "sess-b"]);
});

test("findPromotionCandidates skips empty session memory", async () => {
  const sessionDir = path.join(sourcePath, "cpb-task", "sessions", "sess-empty");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "memory.md"), "", "utf8");

  const candidates = await findPromotionCandidates(sourcePath);
  assert.equal(candidates.length, 0);
});

test("findPromotionCandidates never returns machine-state kinds", async () => {
  const sessionId = "sess-001";
  const sessionDir = path.join(sourcePath, "cpb-task", "sessions", sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "memory.md"), "some content", "utf8");

  const candidates = await findPromotionCandidates(sourcePath, { sessionId });
  for (const c of candidates) {
    assert.notEqual(classifyKnowledgeKind(c.kind), "machine-state");
  }
});
