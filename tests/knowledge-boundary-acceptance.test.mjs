import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  PROMPT_COMPOSITION_ORDER,
  assertKnowledgeWriteAllowed,
  classifyKnowledgeKind,
  knowledgePolicySummary,
  resolveKnowledgePath,
  scanKnowledgeContamination,
} from "../server/services/knowledge-policy.js";

import { composePromptContext } from "../server/services/knowledge-compose.js";

import {
  projectWikiPath,
  projectMemoryPath,
  sessionPath,
} from "../server/services/knowledge-paths.js";

import { promoteKnowledge, writePromotionCandidate } from "../server/services/knowledge-promotion.js";

let tmpDir;
let hubRoot;
let sourcePath;

beforeEach(async () => {
  tmpDir = path.join(await fs.mkdtemp("/tmp/cpb-kba-test-"));
  hubRoot = path.join(tmpDir, "hub");
  sourcePath = path.join(tmpDir, "myrepo");
  await fs.mkdir(hubRoot, { recursive: true });
  await fs.mkdir(sourcePath, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// -------------------------------------------------------
// Acceptance 1: Runtime state never writes to wiki/memory
// -------------------------------------------------------

test("every RUNTIME_STATE_KIND is classified as machine-state", () => {
  const summary = knowledgePolicySummary();
  for (const kind of summary.forbiddenMarkdownState) {
    assert.equal(classifyKnowledgeKind(kind), "machine-state", `${kind} should be machine-state`);
  }
});

test("every RUNTIME_STATE_KIND is rejected from markdown writes", () => {
  const summary = knowledgePolicySummary();
  for (const kind of summary.forbiddenMarkdownState) {
    assert.throws(
      () => assertKnowledgeWriteAllowed(kind, { markdown: true }),
      /runtime state/,
      `${kind} should be rejected from markdown writes`,
    );
  }
});

test("every RUNTIME_STATE_KIND is rejected from knowledge path resolution", () => {
  const summary = knowledgePolicySummary();
  for (const kind of summary.forbiddenMarkdownState) {
    assert.throws(
      () => resolveKnowledgePath({ hubRoot, sourcePath, kind }),
      /runtime state storage/,
      `${kind} should not resolve to a knowledge path`,
    );
  }
});

// -------------------------------------------------------
// Acceptance 2: Runtime write paths never overlap knowledge paths
// -------------------------------------------------------

test("wiki and memory paths are disjoint from machine state paths", () => {
  const src = sourcePath;

  const machineStatePaths = [
    path.join(src, "cpb-task", "state", "pipeline-test.json"),
    path.join(src, "cpb-task", "events", "test", "job-001.jsonl"),
    path.join(src, "cpb-task", "leases", "lease-001.json"),
    path.join(src, "cpb-task", "backlog.json"),
  ];

  const knowledgePaths = [
    projectWikiPath(src),
    projectMemoryPath(src),
    path.join(src, ".cpb", "wiki", "decisions", "ADR-001.md"),
    path.join(src, ".cpb", "context.md"),
  ];

  for (const rp of machineStatePaths) {
    for (const kp of knowledgePaths) {
      assert.ok(
        !rp.startsWith(kp) && !kp.startsWith(rp),
        `machine-state path ${rp} must not overlap knowledge path ${kp}`,
      );
    }
  }
});

// -------------------------------------------------------
// Acceptance 3: Transient task logs stay under session artifacts
// -------------------------------------------------------

test("session artifacts resolve under cpb-task/sessions, not .cpb", () => {
  const sp = sessionPath(sourcePath, "sess-042");
  assert.ok(sp.includes("cpb-task"), `session path ${sp} should be under cpb-task`);
  assert.ok(!sp.includes(".cpb"), `session path ${sp} must not be under .cpb`);
});

test("session knowledge writes go to session dir, not wiki", () => {
  const p = resolveKnowledgePath({ hubRoot, sourcePath, kind: "session-log", sessionId: "s1", name: "transcript" });
  assert.ok(p.includes("cpb-task/sessions"), `session log ${p} should be under sessions`);
  assert.ok(!p.includes(".cpb/wiki"), `session log ${p} must not be under wiki`);
});

// -------------------------------------------------------
// Acceptance 4: Durable decisions go into wiki ADRs
// -------------------------------------------------------

test("ADR kind resolves to wiki decisions directory", () => {
  const p = resolveKnowledgePath({ hubRoot, sourcePath, kind: "adr", name: "ADR-0001" });
  assert.ok(p.includes(".cpb/wiki/decisions"), `ADR path ${p} should be in wiki/decisions`);
});

test("incident kind resolves to wiki incidents directory", () => {
  const p = resolveKnowledgePath({ hubRoot, sourcePath, kind: "incident", name: "inc-001" });
  assert.ok(p.includes(".cpb/wiki/incidents"), `incident path ${p} should be in wiki/incidents`);
});

test("runbook kind resolves to wiki runbooks directory", () => {
  const p = resolveKnowledgePath({ hubRoot, sourcePath, kind: "runbook", name: "rb-001" });
  assert.ok(p.includes(".cpb/wiki/runbooks"), `runbook path ${p} should be in wiki/runbooks`);
});

// -------------------------------------------------------
// Acceptance 5: Project lessons can be promoted session → memory
// -------------------------------------------------------

test("promotion requires explicit approval", async () => {
  await assert.rejects(
    () => promoteKnowledge({ sourcePath, sessionId: "s1", candidateId: "c1", targetKind: "project-memory" }),
    /explicit approval/,
  );
});

test("promotion to machine-state target is rejected", async () => {
  await assert.rejects(
    () => promoteKnowledge({
      sourcePath, sessionId: "s1", candidateId: "c1",
      targetKind: "queue", approved: true,
    }),
    /cannot be promoted into markdown knowledge/,
  );
});

test("successful promotion writes to project memory", async () => {
  await writePromotionCandidate({
    sourcePath, sessionId: "s1",
    title: "Vite Config Pattern",
    content: "Use vitest for testing",
  });

  const record = await promoteKnowledge({
    hubRoot, sourcePath, sessionId: "s1",
    candidateId: "vite-config-pattern",
    targetKind: "project-memory",
    approved: true,
  });

  assert.equal(record.targetKind, "project-memory");
  assert.ok(record.targetPath.endsWith(".cpb/memory.md"));

  const content = await fs.readFile(record.targetPath, "utf8");
  assert.ok(content.includes("Vite Config Pattern"));
  assert.ok(content.includes("vitest"));
});

// -------------------------------------------------------
// Acceptance 6: Global memory/profile writes require confirmation
// -------------------------------------------------------

test("global-memory automatic write is rejected", () => {
  assert.throws(
    () => assertKnowledgeWriteAllowed("global-memory", { automatic: true }),
    /explicit confirmation/,
  );
});

test("global-profile automatic write is rejected", () => {
  assert.throws(
    () => assertKnowledgeWriteAllowed("global-profile", { automatic: true }),
    /explicit confirmation/,
  );
});

test("global-soul automatic write is rejected", () => {
  assert.throws(
    () => assertKnowledgeWriteAllowed("global-soul", { automatic: true }),
    /explicit confirmation/,
  );
});

// -------------------------------------------------------
// Contamination scanner
// -------------------------------------------------------

test("scanKnowledgeContamination returns clean for valid project", async () => {
  await fs.mkdir(path.join(sourcePath, ".cpb", "wiki", "decisions"), { recursive: true });
  await fs.writeFile(path.join(sourcePath, ".cpb", "wiki", "decisions", "ADR-001.md"), "# ADR", "utf8");
  await fs.writeFile(path.join(sourcePath, ".cpb", "memory.md"), "prefer fast tests", "utf8");

  const issues = await scanKnowledgeContamination(sourcePath);
  assert.equal(issues.length, 0);
});

test("scanKnowledgeContamination detects JSON state files in wiki", async () => {
  const decisionsDir = path.join(sourcePath, ".cpb", "wiki", "decisions");
  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(path.join(decisionsDir, "queue-dump.json"), "[]", "utf8");

  const issues = await scanKnowledgeContamination(sourcePath);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].path.includes("queue-dump.json"));
  assert.ok(issues[0].reason.includes("non-markdown state file"));
});

test("scanKnowledgeContamination detects machine-state patterns in memory.md", async () => {
  await fs.mkdir(path.join(sourcePath, ".cpb"), { recursive: true });
  await fs.writeFile(
    path.join(sourcePath, ".cpb", "memory.md"),
    '{"leaseId":"abc-123","status":"expired"}',
    "utf8",
  );

  const issues = await scanKnowledgeContamination(sourcePath);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].reason.includes("machine-state pattern"));
});

// -------------------------------------------------------
// Prompt composition order invariants
// -------------------------------------------------------

test("prompt composition order is frozen and immutable", () => {
  assert.ok(Array.isArray(PROMPT_COMPOSITION_ORDER));
  assert.throws(() => { PROMPT_COMPOSITION_ORDER.push("extra"); }, /not extensible|frozen/);
});

test("compose layers expose correct write policies for each tier", async () => {
  const result = await composePromptContext({ hubRoot, sourcePath, sessionId: "s1", task: "test" });

  const explicit = result.layers.filter((l) => l.writePolicy === "explicit-confirmation");
  const semi = result.layers.filter((l) => l.writePolicy === "semi-automatic");
  const auto = result.layers.filter((l) => l.writePolicy === "automatic");

  assert.ok(explicit.length >= 2, "at least global-soul and global-provider should be explicit");
  assert.ok(semi.length >= 1, "project layers should be semi-automatic");
  assert.ok(auto.length >= 2, "session and task should be automatic");
});
