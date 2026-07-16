import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { writeFile } from "node:fs/promises";
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
