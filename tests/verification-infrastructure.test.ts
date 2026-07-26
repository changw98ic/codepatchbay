import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import {
  checklistInfrastructureFailure,
  executableVerificationEvidenceSummary,
  materializeBaselineTestContractReplay,
  materializeCandidateVerificationReplay,
  readVerifierJsonOutputFile,
  runWithTemporaryReplayCleanup,
} from "../core/phases/verify.js";
import {
  _internalWithTemporaryWorkspaceHooks,
  createTemporaryGitWorktree,
  temporaryWorkspaceErrorDetails,
} from "../core/runtime/temporary-workspace.js";
import { applyFrozenGitTreeDelta } from "../core/runtime/frozen-git-tree.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

test("verifier file transport reads only a bounded regular nofollow file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-verifier-output-"));
  const output = path.join(root, "verdict.json");
  await writeFile(output, '{"status":"pass"}\n', "utf8");
  assert.equal(await readVerifierJsonOutputFile(output), '{"status":"pass"}\n');

  const secret = path.join(root, "secret.txt");
  const symlinkPath = path.join(root, "verdict-link.json");
  await writeFile(secret, "must-not-be-read", "utf8");
  await symlink(secret, symlinkPath);
  await assert.rejects(
    readVerifierJsonOutputFile(symlinkPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "VERIFIER_OUTPUT_UNSAFE",
  );

  const hardLinked = path.join(root, "verdict-hardlink.json");
  await link(output, hardLinked);
  await assert.rejects(
    readVerifierJsonOutputFile(hardLinked),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "VERIFIER_OUTPUT_UNSAFE",
  );

  const oversized = path.join(root, "oversized.json");
  await writeFile(oversized, "x", "utf8");
  await truncate(oversized, 1024 * 1024 + 1);
  await assert.rejects(
    readVerifierJsonOutputFile(oversized),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "VERIFIER_OUTPUT_TOO_LARGE",
  );

  assert.equal(await readVerifierJsonOutputFile(path.join(root, "missing.json")), null);

  await rm(root, { recursive: true, force: true });
});

test("verification replay cleanup preserves both operation and cleanup failures", async () => {
  const operationError = new Error("verifier operation failed");
  const cleanupError = new Error("verification replay cleanup failed");
  await assert.rejects(
    runWithTemporaryReplayCleanup({
      operation: async () => {
        throw operationError;
      },
      cleanup: async () => {
        throw cleanupError;
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [operationError, cleanupError]);
      assert.equal(error.cause, cleanupError);
      return true;
    },
  );
});

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

test("candidate verification replay cleanup reports a committed quarantine on post-rename failure", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-verification-replay-cleanup-test-"));
  let failure: unknown;
  try {
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "verification@example.test"]);
    await git(cwd, ["config", "user.name", "Verification Replay Test"]);
    await writeFile(path.join(cwd, "value.js"), "export const value = 1;\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);
    await writeFile(path.join(cwd, "value.js"), "export const value = 2;\n", "utf8");
    const candidate = await captureCandidateArtifact({ cwd });

    failure = await _internalWithTemporaryWorkspaceHooks({
      afterQuarantineRename({ rootPath }) {
        if (path.basename(rootPath).startsWith("cpb-candidate-verification-")) {
          throw new Error("simulated candidate replay cleanup interruption");
        }
      },
    }, async () => {
      const replay = await materializeCandidateVerificationReplay({ cwd, candidate });
      try {
        await replay.cleanup();
      } catch (error) {
        return error;
      }
      assert.fail("cleanup must surface the committed quarantine interruption");
    });

    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.committed, true);
    assert.equal(details?.disposition, "quarantined");
    assert.equal(details?.quarantinePreserved, true);
    assert.match(details?.recoveryPaths.quarantineRoot || "", /cpb-candidate-verification-/);
  } finally {
    const details = temporaryWorkspaceErrorDetails(failure);
    if (details?.recoveryPaths.quarantineRoot) {
      await rm(details.recoveryPaths.quarantineRoot, { recursive: true, force: true });
    }
    await git(cwd, ["worktree", "prune", "--expire", "now"]).catch(() => "");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("baseline test-contract replay cleanup preserves a worktree successor", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-baseline-replay-cleanup-test-"));
  let replayRoot = "";
  let movedReplay = "";
  try {
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "verification@example.test"]);
    await git(cwd, ["config", "user.name", "Verification Replay Test"]);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "src", "value.js"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(cwd, "tests", "value.test.js"), "export const expected = 1;\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);
    const baseSha = await git(cwd, ["rev-parse", "HEAD"]);
    await writeFile(path.join(cwd, "src", "value.js"), "export const value = 2;\n", "utf8");

    const replay = await materializeBaselineTestContractReplay({
      cwd,
      baseSha,
      changedFiles: ["src/value.js", "tests/value.test.js"],
    });
    assert.ok(replay);
    replayRoot = path.dirname(replay.replayPath);
    movedReplay = `${replay.replayPath}.owned`;
    await rename(replay.replayPath, movedReplay);
    await mkdir(replay.replayPath);
    await writeFile(path.join(replay.replayPath, "successor.txt"), "preserve\n", "utf8");

    let failure: unknown;
    try {
      await replay.cleanup();
      assert.fail("cleanup must reject replay-path replacement");
    } catch (error) {
      failure = error;
    }
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(replay.replayPath, "successor.txt"), "utf8"), "preserve\n");
    assert.equal(await readFile(path.join(movedReplay, "tests", "value.test.js"), "utf8"), "export const expected = 1;\n");
  } finally {
    if (replayRoot) await rm(replayRoot, { recursive: true, force: true });
    await git(cwd, ["worktree", "prune", "--expire", "now"]).catch(() => "");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("baseline replay with an empty production scope never applies candidate test changes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-baseline-empty-production-test-"));
  try {
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "verification@example.test"]);
    await git(cwd, ["config", "user.name", "Verification Replay Test"]);
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "tests", "value.test.js"), "export const expected = 1;\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);
    const baseSha = await git(cwd, ["rev-parse", "HEAD"]);
    await writeFile(path.join(cwd, "tests", "value.test.js"), "export const expected = 2;\n", "utf8");
    const candidate = await captureCandidateArtifact({ cwd, base: baseSha });

    const replay = await materializeBaselineTestContractReplay({
      cwd,
      baseSha,
      changedFiles: ["tests/value.test.js"],
      candidateTree: candidate.treeHash,
    });
    assert.ok(replay);
    try {
      assert.deepEqual(replay.productionFiles, []);
      assert.equal(
        await readFile(path.join(replay.replayPath, "tests", "value.test.js"), "utf8"),
        "export const expected = 1;\n",
      );
      assert.equal(await git(replay.replayPath, ["diff", "--name-only", baseSha]), "");
    } finally {
      await replay.cleanup();
    }
  } finally {
    await git(cwd, ["worktree", "prune", "--expire", "now"]).catch(() => "");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("frozen tree replay treats hostile Git pathspec filenames literally", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-frozen-tree-literal-pathspec-test-"));
  const hostileFile = ":(glob)**";
  try {
    await git(cwd, ["init", "-q"]);
    await git(cwd, ["config", "user.email", "verification@example.test"]);
    await git(cwd, ["config", "user.name", "Verification Replay Test"]);
    await writeFile(path.join(cwd, hostileFile), "hostile base\n", "utf8");
    await writeFile(path.join(cwd, "ordinary.txt"), "ordinary base\n", "utf8");
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "base"]);
    await writeFile(path.join(cwd, hostileFile), "hostile candidate\n", "utf8");
    await writeFile(path.join(cwd, "ordinary.txt"), "ordinary candidate\n", "utf8");
    const candidate = await captureCandidateArtifact({ cwd });
    const replay = await createTemporaryGitWorktree({
      sourcePath: cwd,
      revision: candidate.headSha,
      prefix: "cpb-frozen-tree-pathspec-",
    });
    try {
      await applyFrozenGitTreeDelta({
        sourceRoot: cwd,
        replayRoot: replay.worktreePath,
        fromTree: candidate.headSha,
        candidateTree: candidate.treeHash,
        files: [hostileFile],
        env: replay.gitEnv,
      });
      assert.equal(await readFile(path.join(replay.worktreePath, hostileFile), "utf8"), "hostile candidate\n");
      assert.equal(await readFile(path.join(replay.worktreePath, "ordinary.txt"), "utf8"), "ordinary base\n");
    } finally {
      await replay.cleanup();
    }
  } finally {
    await git(cwd, ["worktree", "prune", "--expire", "now"]).catch(() => "");
    await rm(cwd, { recursive: true, force: true });
  }
});
