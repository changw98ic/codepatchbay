import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  CandidateArtifactIdentityMismatchError,
  assertCandidateArtifactIdentityMatch,
  captureCandidateArtifact,
  verifyCandidateArtifactIdentity,
} from "../core/engine/candidate-artifact.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function makeRepository() {
  const cwd = await mkdtemp(path.join(tmpdir(), "cpb-candidate-artifact-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "candidate@example.test"]);
  await git(cwd, ["config", "user.name", "Candidate Artifact Test"]);
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "value.txt"), "base\n", "utf8");
  await writeFile(path.join(cwd, "delete-me.txt"), "delete me\n", "utf8");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", "base"]);
  return cwd;
}

test("candidate artifact identity is stable and covers tracked plus untracked content", async () => {
  const cwd = await makeRepository();
  try {
    await writeFile(path.join(cwd, "src", "value.txt"), "changed\n", "utf8");
    await rm(path.join(cwd, "delete-me.txt"));
    await mkdir(path.join(cwd, "generated"), { recursive: true });
    await writeFile(path.join(cwd, "generated", "payload.bin"), Buffer.from([0, 1, 2, 255]));

    const first = await captureCandidateArtifact({ cwd });
    const second = await captureCandidateArtifact({ cwd });

    assert.deepEqual(second, first);
    assert.deepEqual(first.trackedChangedFiles, ["delete-me.txt", "src/value.txt"]);
    assert.deepEqual(first.changedFiles, ["delete-me.txt", "generated/payload.bin", "src/value.txt"]);
    assert.deepEqual(first.untrackedManifest.map((entry) => entry.path), ["generated/payload.bin"]);
    assert.match(first.treeHash, /^[0-9a-f]{40,64}$/);
    assert.match(first.trackedPatchHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.patchHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.untrackedManifestHash, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.identityHash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("untracked content, path, and executable mode participate in candidate identity", async () => {
  const cwd = await makeRepository();
  try {
    const script = path.join(cwd, "new-tool.sh");
    await writeFile(script, "echo one\n", "utf8");
    const initial = await captureCandidateArtifact({ cwd });

    await writeFile(script, "echo two\n", "utf8");
    const contentChanged = await captureCandidateArtifact({ cwd });
    assert.equal(contentChanged.trackedPatchHash, initial.trackedPatchHash);
    assert.notEqual(contentChanged.untrackedManifestHash, initial.untrackedManifestHash);
    assert.notEqual(contentChanged.patchHash, initial.patchHash);
    assert.notEqual(contentChanged.treeHash, initial.treeHash);

    await chmod(script, 0o755);
    const modeChanged = await captureCandidateArtifact({ cwd });
    assert.equal(modeChanged.untrackedManifest[0].mode, "100755");
    assert.notEqual(modeChanged.untrackedManifestHash, contentChanged.untrackedManifestHash);
    assert.notEqual(modeChanged.identityHash, contentChanged.identityHash);

    await rename(script, path.join(cwd, "renamed-tool.sh"));
    const pathChanged = await captureCandidateArtifact({ cwd });
    assert.deepEqual(pathChanged.changedFiles, ["renamed-tool.sh"]);
    assert.notEqual(pathChanged.untrackedManifestHash, modeChanged.untrackedManifestHash);
    assert.notEqual(pathChanged.patchHash, modeChanged.patchHash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tracked worktree changes alter tree, patch, and aggregate identity", async () => {
  const cwd = await makeRepository();
  try {
    const clean = await captureCandidateArtifact({ cwd });
    await writeFile(path.join(cwd, "src", "value.txt"), "first change\n", "utf8");
    const firstChange = await captureCandidateArtifact({ cwd });
    await writeFile(path.join(cwd, "src", "value.txt"), "second change\n", "utf8");
    const secondChange = await captureCandidateArtifact({ cwd });

    assert.notEqual(firstChange.treeHash, clean.treeHash);
    assert.notEqual(firstChange.trackedPatchHash, clean.trackedPatchHash);
    assert.notEqual(firstChange.patchHash, clean.patchHash);
    assert.notEqual(firstChange.identityHash, clean.identityHash);
    assert.notEqual(secondChange.treeHash, firstChange.treeHash);
    assert.notEqual(secondChange.trackedPatchHash, firstChange.trackedPatchHash);
    assert.equal(secondChange.untrackedManifestHash, firstChange.untrackedManifestHash);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("identity verification produces an auditable record and assertion failure", async () => {
  const cwd = await makeRepository();
  try {
    const expected = await captureCandidateArtifact({ cwd });
    const matching = await captureCandidateArtifact({ cwd });
    const verifiedAt = "2026-07-11T00:00:00.000Z";
    const match = assertCandidateArtifactIdentityMatch(expected, matching, { verifiedAt });
    assert.equal(match.matches, true);
    assert.equal(match.verifiedAt, verifiedAt);
    assert.deepEqual(match.mismatches, []);

    await writeFile(path.join(cwd, "untracked.txt"), "new candidate content\n", "utf8");
    const actual = await captureCandidateArtifact({ cwd });
    const mismatch = verifyCandidateArtifactIdentity(expected, actual, { verifiedAt });
    assert.equal(mismatch.matches, false);
    assert.ok(mismatch.mismatches.some((entry) => entry.field === "treeHash"));
    assert.ok(mismatch.mismatches.some((entry) => entry.field === "untrackedManifestHash"));
    assert.ok(mismatch.mismatches.some((entry) => entry.field === "identityHash"));

    assert.throws(
      () => assertCandidateArtifactIdentityMatch(expected, actual, { verifiedAt }),
      (error: unknown) => {
        assert.ok(error instanceof CandidateArtifactIdentityMismatchError);
        assert.equal(error.verification.matches, false);
        assert.equal(error.verification.actualIdentityHash, actual.identityHash);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
