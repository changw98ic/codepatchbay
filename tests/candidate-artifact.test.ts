import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { temporaryWorkspaceErrorDetails } from "../core/runtime/temporary-workspace.js";

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

async function makeJobGitEnv() {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-candidate-git-env-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  const gitPath = path.join(bin, "git");
  await mkdir(bin, { recursive: true });
  await writeFile(gitPath, `#!/bin/sh
if [ "\${CPB_AMBIENT_GIT_POISON+x}" = "x" ]; then
  echo "ambient git poison leaked" >&2
  exit 86
fi
if [ "$CPB_CANDIDATE_GIT_ENV" != "job" ]; then
  echo "missing job git env" >&2
  exit 87
fi
echo "$@" >> "$CPB_GIT_WRAPPER_LOG"
exec /usr/bin/git "$@"
`, "utf8");
  await chmod(gitPath, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CPB_CANDIDATE_GIT_ENV: "job",
    CPB_GIT_WRAPPER_LOG: log,
  };
  delete env.CPB_AMBIENT_GIT_POISON;
  return {
    root,
    log,
    env,
  };
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

test("candidate artifact git commands use the explicit job env", { concurrency: false }, async () => {
  const cwd = await makeRepository();
  const gitEnv = await makeJobGitEnv();
  const previousPoison = process.env.CPB_AMBIENT_GIT_POISON;
  try {
    await writeFile(path.join(cwd, "src", "value.txt"), "job env candidate\n", "utf8");
    process.env.CPB_AMBIENT_GIT_POISON = "ambient-only";

    const candidate = await captureCandidateArtifact({ cwd, env: gitEnv.env });

    assert.match(candidate.identityHash, /^sha256:[0-9a-f]{64}$/);
    const log = await readFile(gitEnv.log, "utf8");
    assert.match(log, /rev-parse --show-toplevel/);
    assert.match(log, /write-tree/);
  } finally {
    if (previousPoison === undefined) {
      delete process.env.CPB_AMBIENT_GIT_POISON;
    } else {
      process.env.CPB_AMBIENT_GIT_POISON = previousPoison;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(gitEnv.root, { recursive: true, force: true });
  }
});

test("candidate tree hashing preserves a temporary-index successor created by a clean filter", async () => {
  const cwd = await makeRepository();
  const filterPath = path.join(cwd, "replace-index-root.sh");
  const movedLog = path.join(cwd, "moved-index-root.txt");
  let movedRoot = "";
  try {
    await writeFile(filterPath, `#!/bin/sh
root=$(dirname "$GIT_INDEX_FILE")
case $(basename "$root") in
  cpb-candidate-index-*)
    moved="$root.owned"
    mv "$root" "$moved"
    mkdir "$root"
    printf 'successor\\n' > "$root/successor.txt"
    printf '%s\\n' "$moved" > "$CPB_FILTER_MOVED_LOG"
    ;;
esac
cat
`, "utf8");
    await chmod(filterPath, 0o755);
    await writeFile(path.join(cwd, ".gitattributes"), "src/value.txt filter=cpb-root-replace\n", "utf8");
    await git(cwd, ["config", "filter.cpb-root-replace.clean", filterPath]);
    await git(cwd, ["config", "filter.cpb-root-replace.smudge", "cat"]);
    await writeFile(path.join(cwd, "src", "value.txt"), "hostile filter candidate\n", "utf8");

    let failure: unknown;
    try {
      await captureCandidateArtifact({
        cwd,
        env: { ...process.env, CPB_FILTER_MOVED_LOG: movedLog },
      });
      assert.fail("candidate capture must reject replaced temporary-index ownership");
    } catch (error) {
      failure = error;
    }

    movedRoot = (await readFile(movedLog, "utf8")).trim();
    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(await readFile(path.join(details?.recoveryPaths.canonicalRoot || "", "successor.txt"), "utf8"), "successor\n");
    assert.ok(movedRoot.endsWith(".owned"));
  } finally {
    if (movedRoot) {
      await rm(movedRoot, { recursive: true, force: true });
      await rm(movedRoot.slice(0, -".owned".length), { recursive: true, force: true });
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
