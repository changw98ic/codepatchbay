import assert from "node:assert/strict";
import test from "node:test";

import {
  assertKnowledgeWriteAllowed,
  classifyKnowledgeKind,
  knowledgePolicySummary,
  resolveKnowledgePath,
} from "../server/services/knowledge-policy.js";

test("knowledge policy rejects runtime state markdown writes", () => {
  assert.equal(classifyKnowledgeKind("queue"), "machine-state");
  assert.throws(
    () => assertKnowledgeWriteAllowed("rate-limit", { markdown: true }),
    /runtime state/,
  );
});

test("knowledge policy separates session, project memory, and ADR paths", () => {
  const session = resolveKnowledgePath({ hubRoot: "/hub", sourcePath: "/repo", kind: "session", sessionId: "s1", name: "memory" });
  const memory = resolveKnowledgePath({ hubRoot: "/hub", sourcePath: "/repo", kind: "project-memory" });
  const adr = resolveKnowledgePath({ hubRoot: "/hub", sourcePath: "/repo", kind: "adr", name: "ADR-0001" });

  assert.equal(session, "/repo/cpb-task/sessions/s1/memory.md");
  assert.equal(memory, "/repo/.cpb/memory.md");
  assert.equal(adr, "/repo/.cpb/wiki/decisions/ADR-0001.md");
});

test("knowledge policy requires explicit global writes", () => {
  assert.throws(
    () => assertKnowledgeWriteAllowed("global-memory", { automatic: true }),
    /explicit confirmation/,
  );
  assert.ok(knowledgePolicySummary().promptCompositionOrder.includes("project-memory"));
});
