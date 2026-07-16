import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { runVerify } from "../core/phases/verify.js";
import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import { recordValue } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCb);

function jsonEnvelope(data: Record<string, unknown>) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

test("light planMode verifies execute output without a plan artifact", async () => {
  const cpbRoot = await tempRoot("cpb-verify-light-no-plan");
  let callCount = 0;
  let capturedPrompt = "";

  const pool = {
    async execute(_agent: string, prompt: string) {
      callCount += 1;
      capturedPrompt = prompt;
      return {
        output: jsonEnvelope({
          status: "ok",
          verdict: "pass",
          reason: "hard gates and current diff are sufficient for light-mode verification",
          details: "No plan artifact exists because the workflow was resolved with planMode=light.",
          confidence: 0.88,
        }),
        providerKey: "fake",
        variant: null,
      };
    },
  };

  const result = await runVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-light-no-plan",
    task: "Verify a light-mode execute result with no preceding plan node",
    sourcePath: cpbRoot,
    workflow: "standard",
    planMode: "light",
    pool,
    previousResults: [
      {
        phase: "execute",
        artifact: {
          kind: "deliverable",
          name: "deliverable-light-no-plan",
          metadata: { summary: "Execute completed without creating a plan artifact." },
        },
      },
    ],
  });

  assert.equal(callCount, 1, "verify must reach the verifier agent instead of failing before agent execution");
  assert.equal(result.status, "passed", result.failure?.reason);
  assert.match(capturedPrompt, /current diff/i);
  assert.match(capturedPrompt, /explicit numbered or bulleted task obligation/i);
  assert.match(capturedPrompt, /commit date or executor chronology claim is not evidence/i);
  const verificationEvidence = recordValue(result.diagnostics.verificationEvidence);
  const planEvidence = recordValue(verificationEvidence.plan);
  assert.equal(planEvidence.optional, true);
  assert.match(
    String(planEvidence.reason),
    /planMode "light" has no plan phase/,
  );
});

test("ordinary verifier must review the exact frozen candidate scope expansion", async () => {
  const cpbRoot = await tempRoot("cpb-verify-scope-review");
  await execFile("git", ["init", "-q"], { cwd: cpbRoot });
  await execFile("git", ["config", "user.email", "test@example.invalid"], { cwd: cpbRoot });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: cpbRoot });
  await writeFile(path.join(cpbRoot, "src.txt"), "base\n", "utf8");
  await writeFile(path.join(cpbRoot, "setup.cfg"), "strict = false\n", "utf8");
  await execFile("git", ["add", "-A"], { cwd: cpbRoot });
  await execFile("git", ["commit", "-q", "-m", "base"], { cwd: cpbRoot });
  await writeFile(path.join(cpbRoot, "src.txt"), "candidate\n", "utf8");
  await writeFile(path.join(cpbRoot, "setup.cfg"), "strict = true\n", "utf8");
  const candidateArtifact = await captureCandidateArtifact({ cwd: cpbRoot });
  let capturedPrompt = "";
  const result = await runVerify({
    cpbRoot,
    dataRoot: cpbRoot,
    project: "flow",
    jobId: "job-scope-review",
    task: "Preserve strict repository behavior",
    sourcePath: cpbRoot,
    workflow: "standard",
    planMode: "light",
    env: { CPB_ASSURANCE_MODE: "high" },
    sourceContext: {
      assurance: { mode: "high" },
      acceptanceChecklistArtifact: { name: "acceptance-checklist-1" },
      acceptanceChecklist: {
        items: [{
          id: "AC-001",
          requirement: "Preserve strict repository behavior",
          required: true,
          verificationMethod: "static",
          predicateId: "PRED-001",
          expectedEvidence: "inspect the exact diff",
          allowedFiles: ["src.txt"],
          risk: "medium",
        }],
      },
    },
    previousResults: [{
      phase: "execute",
      status: "passed",
      diagnostics: {
        candidateArtifact,
        executionMap: {
          changedFiles: ["src.txt", "setup.cfg"],
          unmappedChangedFiles: ["setup.cfg"],
          mappings: [{ checklistId: "AC-001", changedFiles: ["src.txt"] }],
        },
      },
    }],
    pool: {
      async execute(_agent: string, prompt: string) {
        capturedPrompt = prompt;
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "pass",
            reason: "candidate behavior is correct",
            details: "scope review omitted",
            confidence: 0.9,
          }),
          providerKey: "fake",
          variant: null,
        };
      },
    },
  });

  assert.match(capturedPrompt, /FROZEN SCOPE AMENDMENT REVIEW/);
  assert.match(capturedPrompt, /setup\.cfg/);
  assert.match(capturedPrompt, new RegExp(candidateArtifact.identityHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, "verdict_invalid");
  assert.match(String(result.failure?.reason), /scopeReview is required/);
});
