import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodePatchBayPrBody } from "../server/services/pr-body.js";

test("PR body includes required CodePatchBay sections and run fields", () => {
  const body = buildCodePatchBayPrBody({
    job: {
      jobId: "job-001",
      project: "flow",
      workflow: "standard",
      retryCount: 2,
      sourceContext: { repo: "owner/repo", issueNumber: 42 },
    },
    agents: { planner: "codex", executor: "claude", verifier: "codex" },
  });
  for (const section of ["## CodePatchBay Run", "## Plan", "## Tests", "## Verification", "## Audit"]) {
    assert.ok(body.includes(section), `missing ${section}`);
  }
  assert.match(body, /- Job: job-001/);
  assert.match(body, /- Repository: owner\/repo/);
  assert.match(body, /- Issue: #42/);
  assert.match(body, /- Executor: claude/);
  assert.ok(body.endsWith("\n\nCloses #42"));
});

test("PR body includes artifacts verdict tests and audit refs", () => {
  const body = buildCodePatchBayPrBody({
    artifacts: {
      plan: { id: "p-001", path: "inbox/plan-001.md" },
      deliverable: { id: "d-001", path: "outputs/deliverable-001.md" },
      verdict: { id: "v-001", path: "outputs/verdict-001.md" },
      diff: { id: "diff-001", path: "outputs/diff-001.patch" },
    },
    verdict: { status: "pass", confidence: 0.95, blockingCount: 0, reason: "clean" },
    tests: ["node --test tests/pr-body.test.mjs"],
    audit: { eventLog: "events/job-001.jsonl", artifactIndex: "artifact-index.json" },
  });
  assert.match(body, /- Plan: p-001 \(inbox\/plan-001\.md\)/);
  assert.match(body, /- Verdict: v-001 \(outputs\/verdict-001\.md\)/);
  assert.match(body, /- Status: pass/);
  assert.match(body, /node --test tests\/pr-body\.test\.mjs/);
  assert.match(body, /- Artifact index: artifact-index\.json/);
});

test("PR body is deterministic and uses unavailable placeholders", () => {
  const first = buildCodePatchBayPrBody();
  const second = buildCodePatchBayPrBody();
  assert.equal(first, second);
  assert.match(first, /- Job: unavailable/);
  assert.match(first, /- Plan: unavailable/);
  assert.match(first, /- Tests: unavailable/);
});
