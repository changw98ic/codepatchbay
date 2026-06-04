import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildPrEvidenceFromReviewBundle } from "../server/services/auto-finalizer.js";

test("buildPrEvidenceFromReviewBundle extracts artifact verdict test and audit refs", () => {
  const cpbRoot = path.join(process.cwd(), ".tmp-cpb-root");
  const bundle = {
    project: "flow",
    jobId: "job-123",
    evidence: {
      changedFiles: ["server/services/github-pr.js"],
      diffStat: " server/services/github-pr.js | 10 +++++-----",
      verdict: {
        status: "pass",
        confidence: 0.93,
        reason: "all checks passed",
        blocking: [],
        basis: {
          tests: "node --test tests/github-pr.test.mjs",
        },
        layers: {
          acceptance: { detail: "npm run verify:p0p1" },
        },
      },
    },
    links: {
      eventLog: "events/flow/job-123.jsonl",
      artifacts: [
        {
          kind: "plan",
          path: path.join(cpbRoot, "wiki/projects/flow/inbox/plan-job-123.md"),
          broken: false,
        },
        {
          kind: "deliverable",
          path: path.join(cpbRoot, "wiki/projects/flow/outputs/deliverable-job-123.md"),
          broken: false,
        },
        {
          kind: "verdict",
          path: path.join(cpbRoot, "wiki/projects/flow/outputs/verdict-job-123.md"),
          broken: false,
        },
      ],
    },
  };

  const evidence = buildPrEvidenceFromReviewBundle(bundle, { cpbRoot });

  assert.deepEqual(evidence.artifacts.plan, {
    id: "plan-job-123",
    path: "wiki/projects/flow/inbox/plan-job-123.md",
  });
  assert.deepEqual(evidence.artifacts.deliverable, {
    id: "deliverable-job-123",
    path: "wiki/projects/flow/outputs/deliverable-job-123.md",
  });
  assert.deepEqual(evidence.artifacts.verdict, {
    id: "verdict-job-123",
    path: "wiki/projects/flow/outputs/verdict-job-123.md",
  });
  assert.deepEqual(evidence.artifacts.diff, {
    id: "worktree-diff",
    path: "1 changed files",
  });
  assert.deepEqual(evidence.tests, [
    "node --test tests/github-pr.test.mjs",
    "acceptance: npm run verify:p0p1",
  ]);
  assert.equal(evidence.audit.eventLog, "events/flow/job-123.jsonl");
  assert.equal(evidence.audit.artifactIndex, "3 artifact references");
  assert.equal(evidence.verdictDetail.status, "pass");
  assert.equal(evidence.verdictDetail.reason, "all checks passed");
  assert.equal(evidence.verdictDetail.blockingCount, 0);
});
