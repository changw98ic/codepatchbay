import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCodePatchBayPrBody } from "../server/services/pr-body.js";

test("buildCodePatchBayPrBody renders completion report fields", () => {
  const body = buildCodePatchBayPrBody({
    job: {
      jobId: "job-1",
      project: "flow",
      workflow: "standard",
      retryCount: 0,
      completionReport: {
        changedFileCount: 2,
        changedFiles: ["server/routes/status.ts", "tests/status.test.ts"],
        realActors: ["StatusRoute"],
        realEntrypoints: ["/status"],
        bypassCandidates: ["text output path"],
        evidenceClasses: ["real_path_probe"],
        evidenceOrigins: ["user_required"],
        commands: ["npm test -- status"],
        evidenceCounts: { passed: 1, failed: 0, total: 1 },
        residualRisk: { notes: ["manual browser check omitted"] },
      },
    },
    agents: { planner: "codex", executor: "codex", verifier: "codex" },
    artifacts: {},
    tests: ["npm test -- status"],
    verdict: { status: "pass", confidence: "high", reason: "ok", blockingCount: 0 },
    completionGate: { outcome: "complete", reason: "All required completion gates passed" },
    audit: { eventLog: "events.jsonl", artifactIndex: "artifacts.json" },
  });

  assert.match(body, /## Completion Report/);
  assert.match(body, /Changed Files: 2 \(server\/routes\/status\.ts, tests\/status\.test\.ts\)/);
  assert.match(body, /Real Actors: StatusRoute/);
  assert.match(body, /Real Entrypoints: \/status/);
  assert.match(body, /Bypass Candidates: text output path/);
  assert.match(body, /Evidence Classes: real_path_probe/);
  assert.match(body, /Evidence Origins: user_required/);
  assert.match(body, /Commands: npm test -- status/);
  assert.match(body, /Evidence Counts: 1 passed \/ 0 failed \/ 1 total/);
  assert.match(body, /Residual Risk: manual browser check omitted/);
});

test("buildCodePatchBayPrBody omits completion report section when absent", () => {
  const body = buildCodePatchBayPrBody({
    job: { jobId: "job-1", project: "flow" },
    verdict: { status: "pass" },
  });

  assert.doesNotMatch(body, /## Completion Report/);
});
