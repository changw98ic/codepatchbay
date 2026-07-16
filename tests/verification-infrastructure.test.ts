import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import {
  checklistInfrastructureFailure,
  executableVerificationEvidenceSummary,
  materializeCandidateVerificationReplay,
} from "../core/phases/verify.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
}

test("checklist infrastructure classification requires both objective unavailability and verifier confirmation", () => {
  const checklistVerdict = {
    status: "fail",
    items: [{
      checklistId: "AC-001",
      result: "fail",
      actualResult: "The predeclared deterministic test evidence is fail.",
      reason: "No passing ledger evidence is available.",
    }],
  };
  const evidenceLedger = {
    evidence: [{
      checklistId: "AC-001",
      result: "fail",
      infrastructureFailure: true,
      failureClass: "verification_evidence_unavailable",
    }],
  };
  const classified = checklistInfrastructureFailure(
    checklistVerdict,
    evidenceLedger,
    { ok: true, status: "fail", reason: "No passing ledger evidence", details: "Environment unavailable" },
  );
  assert.equal(classified?.failureClass, "verification_infrastructure");
  assert.equal(classified?.candidateMutationAllowed, false);

  const smokeWording = checklistInfrastructureFailure(
    {
      ...checklistVerdict,
      items: [{
        ...checklistVerdict.items[0],
        actualResult: "The predeclared deterministic test evidence is marked fail, and local rerun was blocked by missing numpy/pytest.",
        reason: "Required behavior cannot be marked pass without passing matching ledger evidence.",
      }],
    },
    evidenceLedger,
    {
      ok: true,
      status: "fail",
      reason: "Required behavior checklist items do not have passing cited ledger evidence.",
      details: "The local sandbox could not rerun repository tests because dependencies and network access are unavailable.",
    },
  );
  assert.equal(smokeWording?.failureClass, "verification_infrastructure");
  assert.equal(smokeWording?.candidateMutationAllowed, false);

  const implementationFailure = checklistInfrastructureFailure(
    {
      ...checklistVerdict,
      items: [{
        ...checklistVerdict.items[0],
        actualResult: "Runtime assertion returned a dense lower-right matrix.",
        reason: "Assertion returned the wrong matrix",
      }],
    },
    evidenceLedger,
    { ok: true, status: "fail", reason: "Wrong matrix values", details: "Assertion mismatch" },
  );
  assert.equal(implementationFailure, null);
});

test("high-assurance executable evidence cannot be satisfied by static scope alone", () => {
  const emptyObservableCoverage = {
    required: false,
    ok: true,
    requiredContractIds: [],
    passedContractIds: [],
    failedContractIds: [],
    missingContractIds: [],
    targetChecklistIds: [],
    fixScope: [],
  };
  assert.deepEqual(
    executableVerificationEvidenceSummary({
      evidence: [{ id: "EV-STATIC", result: "pass", verificationMethod: "static", matchCount: 2 }],
    }, {
      checks: [{ gate: "focused node --test", ok: true, skipped: true }],
    }),
    {
      ok: false,
      genericExecutionPassed: false,
      observableCoverage: emptyObservableCoverage,
      ledgerEvidenceIds: [],
      hardGateCommands: [],
      independentVerifierExecutions: {
        ok: false,
        reason: "no verifier ACP execution audit was available",
        observations: [],
      },
    },
  );

  assert.deepEqual(
    executableVerificationEvidenceSummary({
      evidence: [{ id: "EV-TEST", result: "pass", verificationMethod: "test", exitCode: 0 }],
    }, { checks: [] }),
    {
      ok: true,
      genericExecutionPassed: true,
      observableCoverage: emptyObservableCoverage,
      ledgerEvidenceIds: ["EV-TEST"],
      hardGateCommands: [],
      independentVerifierExecutions: {
        ok: false,
        reason: "no verifier ACP execution audit was available",
        observations: [],
      },
    },
  );
});

test("disposable verification replay preserves the frozen candidate while allowing build output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-verification-replay-test-"));
  try {
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "verification@example.test"]);
    await git(cwd, ["config", "user.name", "Verification Replay Test"]);
    await writeFile(path.join(cwd, ".gitignore"), "build/\n", "utf8");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "value.js"), "export const value = 1;\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);

    await writeFile(path.join(cwd, "src", "value.js"), "export const value = 2;\n", "utf8");
    const candidate = await captureCandidateArtifact({ cwd });
    const replay = await materializeCandidateVerificationReplay({ cwd, candidate });
    try {
      assert.equal(replay.candidateVerification.matches, true);
      await mkdir(path.join(replay.replayPath, "build"), { recursive: true });
      await writeFile(path.join(replay.replayPath, "build", "compiled.bin"), "artifact\n", "utf8");
      const replayAfterBuild = await captureCandidateArtifact({ cwd: replay.replayPath, base: candidate.baseSha });
      assert.equal(replayAfterBuild.identityHash, candidate.identityHash);

      await writeFile(path.join(replay.replayPath, "src", "value.js"), "export const value = 3;\n", "utf8");
      const replayAfterSourceMutation = await captureCandidateArtifact({ cwd: replay.replayPath, base: candidate.baseSha });
      assert.notEqual(replayAfterSourceMutation.identityHash, candidate.identityHash);

      const canonicalAfterReplayMutation = await captureCandidateArtifact({ cwd, base: candidate.baseSha });
      assert.equal(canonicalAfterReplayMutation.identityHash, candidate.identityHash);
    } finally {
      await replay.cleanup();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
