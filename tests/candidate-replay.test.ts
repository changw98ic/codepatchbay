import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import {
  createCandidateReplayBundle,
  replayCandidateBundleInCleanWorktree,
  replayCandidateInCleanWorktree,
} from "../core/engine/candidate-replay.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCb);

async function repository() {
  const cwd = await tempRoot("cpb-candidate-replay");
  await execFile("git", ["init"], { cwd });
  await execFile("git", ["config", "user.email", "cpb@example.invalid"], { cwd });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd });
  await writeFile(path.join(cwd, "tracked.txt"), "base\n", "utf8");
  await execFile("git", ["add", "tracked.txt"], { cwd });
  await execFile("git", ["commit", "-m", "base"], { cwd });
  return cwd;
}

async function makeJobGitEnv() {
  const root = await tempRoot("cpb-candidate-replay-git-env");
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  const gitPath = path.join(bin, "git");
  await mkdir(bin, { recursive: true });
  await writeFile(gitPath, `#!/bin/sh
if [ "\${CPB_AMBIENT_GIT_POISON+x}" = "x" ]; then
  echo "ambient git poison leaked" >&2
  exit 86
fi
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exec /usr/bin/git "$@"
`, "utf8");
  await chmod(gitPath, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
  };
  delete env.CPB_AMBIENT_GIT_POISON;
  return {
    log,
    env,
  };
}

test("clean replay reconstructs tracked and untracked candidate state from its base", async () => {
  const cwd = await repository();
  await writeFile(path.join(cwd, "tracked.txt"), "changed\n", "utf8");
  await writeFile(path.join(cwd, "new.txt"), "new file\n", "utf8");
  const candidate = await captureCandidateArtifact({ cwd });

  const replay = await replayCandidateInCleanWorktree({
    cwd,
    candidate,
    replayedAt: "2026-07-11T00:00:00.000Z",
  });

  assert.equal(replay.cleanApply, true, replay.reason || "clean replay failed");
  assert.equal(replay.actualTreeHash, candidate.treeHash);
  assert.equal(replay.expectedTreeHash, candidate.treeHash);
});

test("clean replay fails closed for an unavailable candidate tree", async () => {
  const cwd = await repository();
  const candidate = await captureCandidateArtifact({ cwd });
  const replay = await replayCandidateInCleanWorktree({
    cwd,
    candidate: { ...candidate, treeHash: "0".repeat(40) },
  });

  assert.equal(replay.cleanApply, false);
  assert.ok(replay.reason);
});

test("persisted replay bundle reconstructs a candidate without its unreachable tree object", async () => {
  const cwd = await repository();
  const cloneParent = await tempRoot("cpb-candidate-replay-clone");
  const clone = path.join(cloneParent, "repo");
  await execFile("git", ["clone", "--quiet", cwd, clone]);

  await writeFile(path.join(cwd, "tracked.txt"), "changed through bundle\n", "utf8");
  await writeFile(path.join(cwd, "untracked.bin"), Buffer.from([0, 1, 2, 3, 255]));
  const candidate = await captureCandidateArtifact({ cwd });
  const bundle = await createCandidateReplayBundle({ cwd, candidate });

  await assert.rejects(
    execFile("git", ["cat-file", "-e", candidate.treeHash], { cwd: clone }),
    "the clone must not already contain the unreachable candidate tree",
  );
  const replay = await replayCandidateBundleInCleanWorktree({
    cwd: clone,
    bundle,
    replayedAt: "2026-07-12T00:00:00.000Z",
  });

  assert.equal(replay.cleanApply, true, replay.reason || "persisted bundle replay failed");
  assert.equal(replay.replayMethod, "persisted_patch_bundle");
  assert.equal(replay.actualTreeHash, candidate.treeHash);
  assert.equal(replay.bundleHash, bundle.bundleHash);
  assert.equal(replay.patchSha256, bundle.patchSha256);
  assert.ok(bundle.patchBytes > 0);
});

test("persisted replay bundle fails closed when its patch is tampered", async () => {
  const cwd = await repository();
  await writeFile(path.join(cwd, "tracked.txt"), "changed\n", "utf8");
  const candidate = await captureCandidateArtifact({ cwd });
  const bundle = await createCandidateReplayBundle({ cwd, candidate });

  const replay = await replayCandidateBundleInCleanWorktree({
    cwd,
    bundle: { ...bundle, patch: `${bundle.patch}\n# tampered` },
  });

  assert.equal(replay.cleanApply, false);
  assert.match(replay.reason || "", /patch hash mismatch/);
});

test("candidate replay git commands use the explicit job env", { concurrency: false }, async () => {
  const cwd = await repository();
  const gitEnv = await makeJobGitEnv();
  const previousPoison = process.env.CPB_AMBIENT_GIT_POISON;
  try {
    await writeFile(path.join(cwd, "tracked.txt"), "changed with explicit env\n", "utf8");
    await writeFile(path.join(cwd, "new.txt"), "new with explicit env\n", "utf8");
    process.env.CPB_AMBIENT_GIT_POISON = "ambient-only";

    const candidate = await captureCandidateArtifact({ cwd, env: gitEnv.env });
    const bundle = await createCandidateReplayBundle({ cwd, candidate, env: gitEnv.env });
    const treeReplay = await replayCandidateInCleanWorktree({ cwd, candidate, env: gitEnv.env });
    const bundleReplay = await replayCandidateBundleInCleanWorktree({ cwd, bundle, env: gitEnv.env });

    assert.equal(treeReplay.cleanApply, true, treeReplay.reason || "tree replay failed");
    assert.equal(bundleReplay.cleanApply, true, bundleReplay.reason || "bundle replay failed");
    const log = await readFile(gitEnv.log, "utf8");
    assert.match(log, /diff --binary/);
    assert.match(log, /worktree add/);
    assert.match(log, /write-tree/);
  } finally {
    if (previousPoison === undefined) {
      delete process.env.CPB_AMBIENT_GIT_POISON;
    } else {
      process.env.CPB_AMBIENT_GIT_POISON = previousPoison;
    }
  }
});

test("candidate replay records cleanup failure and preserves replay-root successors", async () => {
  const cwd = await repository();
  const wrapperRoot = await tempRoot("cpb-candidate-replay-root-replacer");
  const bin = path.join(wrapperRoot, "bin");
  const movedLog = path.join(wrapperRoot, "moved.log");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "git"), `#!/bin/sh
case "$1" in
  write-tree)
    parent=$(dirname "$PWD")
    case $(basename "$parent") in
      cpb-candidate-replay-*|cpb-candidate-bundle-replay-*)
        output=$(/usr/bin/git "$@") || exit $?
        moved="$parent.owned"
        mv "$parent" "$moved"
        mkdir -p "$parent/worktree"
        printf 'successor\\n' > "$parent/successor.txt"
        printf '%s\\n' "$moved" >> "$CPB_REPLAY_MOVED_LOG"
        printf '%s\\n' "$output"
        exit 0
        ;;
    esac
    ;;
esac
exec /usr/bin/git "$@"
`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    CPB_REPLAY_MOVED_LOG: movedLog,
  };
  const recoveryRoots: string[] = [];
  const movedRoots: string[] = [];
  try {
    await writeFile(path.join(cwd, "tracked.txt"), "hostile cleanup candidate\n", "utf8");
    const candidate = await captureCandidateArtifact({ cwd });
    const bundle = await createCandidateReplayBundle({ cwd, candidate });

    const records = [
      await replayCandidateInCleanWorktree({ cwd, candidate, env }),
      await replayCandidateBundleInCleanWorktree({ cwd, bundle, env }),
    ];
    for (const replay of records) {
      assert.equal(replay.cleanApply, false);
      assert.match(replay.reason || "", /cleanup.*authority|authority.*cleanup/i);
      assert.equal(replay.cleanup?.committed, false);
      assert.equal(replay.cleanup?.disposition, "retained");
      assert.equal(replay.cleanup?.successorPreserved, true);
      const canonicalRoot = replay.cleanup?.recoveryPaths.canonicalRoot || "";
      recoveryRoots.push(canonicalRoot);
      assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "successor\n");
    }
    movedRoots.push(...(await readFile(movedLog, "utf8")).trim().split("\n").filter(Boolean));
    assert.equal(movedRoots.length, 2);
  } finally {
    for (const target of [...recoveryRoots, ...movedRoots]) {
      await rm(target, { recursive: true, force: true });
    }
    await execFile("git", ["worktree", "prune", "--expire", "now"], { cwd }).catch(() => null);
    await rm(cwd, { recursive: true, force: true });
    await rm(wrapperRoot, { recursive: true, force: true });
  }
});
