#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  promoteKnowledge,
  writePromotionCandidate,
} from "../server/services/knowledge-promotion.js";

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

test("writePromotionCandidate writes candidates under explicit project runtime root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-promotion-"));
  const sourcePath = path.join(root, "source");
  const dataRoot = path.join(root, "runtime");
  await mkdir(sourcePath, { recursive: true });

  const result = await writePromotionCandidate({
    sourcePath,
    dataRoot,
    sessionId: "sess-001",
    title: "Useful Insight",
    content: "Keep this around.",
  });

  const expected = path.join(dataRoot, "sessions", "sess-001", "promotion-candidates", "useful-insight.md");
  assert.equal(result.filePath, expected);
  assert.equal((result as Record<string, any>).dataRoot, path.resolve(dataRoot));
  assert.equal(await pathExists(expected), true);
  assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);
});

test("writePromotionCandidate fails closed without a project runtime root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-promotion-"));
  const sourcePath = path.join(root, "source");
  await mkdir(sourcePath, { recursive: true });

  await assert.rejects(
    writePromotionCandidate({
      sourcePath,
      sessionId: "sess-001",
      title: "Useful Insight",
      content: "Keep this around.",
    }),
    /projectRuntimeRoot or dataRoot is required/,
  );
  assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);
});

test("promoteKnowledge records promotions under runtime root and rejects unsafe session ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-promotion-"));
  const sourcePath = path.join(root, "source");
  const projectRuntimeRoot = path.join(root, "runtime");
  await mkdir(sourcePath, { recursive: true });

  await assert.rejects(
    promoteKnowledge({
      sourcePath,
      projectRuntimeRoot,
      sessionId: "../escape",
      targetKind: "project-memory",
      title: "Unsafe Session",
      content: "must not record",
      approved: true,
    }),
    /invalid sessionId/,
  );

  const record = await promoteKnowledge({
    sourcePath,
    projectRuntimeRoot,
    sessionId: "sess-001",
    targetKind: "project-memory",
    title: "Useful Insight",
    content: "Keep this around.",
    approved: true,
  });

  const promotionsFile = path.join(projectRuntimeRoot, "sessions", "sess-001", "promotions.jsonl");
  assert.equal(await pathExists(promotionsFile), true);
  assert.equal(await pathExists(path.join(sourcePath, "cpb-task")), false);

  const records = (await readFile(promotionsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "Useful Insight");
  assert.equal(records[0].targetPath, record.targetPath);
});
