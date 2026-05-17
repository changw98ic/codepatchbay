import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  promoteKnowledge,
  promotionCandidatePath,
  writePromotionCandidate,
} from "../server/services/knowledge-promotion.js";

test("knowledge promotion writes automatic candidates only to session artifacts", async () => {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-project-"));
  const candidate = await writePromotionCandidate({
    sourcePath,
    sessionId: "sess-001",
    title: "Prefer Runtime Locks",
    content: "Use mkdir locks around shared JSON registry writes.",
    sourceLinks: ["tests/hub-registry.test.mjs"],
  });

  assert.equal(candidate.candidateId, "prefer-runtime-locks");
  assert.equal(
    candidate.filePath,
    promotionCandidatePath(sourcePath, "sess-001", "prefer-runtime-locks"),
  );
  assert.match(await readFile(candidate.filePath, "utf8"), /Use mkdir locks/);
});

test("knowledge promotion requires explicit approval before project memory writes", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-project-"));
  const candidate = await writePromotionCandidate({
    sourcePath,
    sessionId: "sess-002",
    title: "Project Memory Lesson",
    content: "Keep automatic repair opt-in until soak evidence exists.",
  });

  await assert.rejects(
    () => promoteKnowledge({
      hubRoot,
      sourcePath,
      sessionId: "sess-002",
      candidateId: candidate.candidateId,
      targetKind: "project-memory",
    }),
    /explicit approval/,
  );

  const promotion = await promoteKnowledge({
    hubRoot,
    sourcePath,
    sessionId: "sess-002",
    candidateId: candidate.candidateId,
    targetKind: "project-memory",
    approved: true,
  });

  assert.equal(promotion.targetPath, path.join(sourcePath, ".cpb", "memory.md"));
  assert.match(await readFile(promotion.targetPath, "utf8"), /Keep automatic repair opt-in/);
  assert.match(
    await readFile(path.join(sourcePath, "cpb-task", "sessions", "sess-002", "promotions.jsonl"), "utf8"),
    /project-memory/,
  );
});

test("knowledge promotion rejects runtime state targets", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-knowledge-project-"));

  await assert.rejects(
    () => promoteKnowledge({
      hubRoot,
      sourcePath,
      sessionId: "sess-003",
      targetKind: "queue",
      content: "runtime state should not become wiki text",
      approved: true,
    }),
    /cannot be promoted/,
  );
});
