import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  classifyRepairRisk,
  evaluateGuardedRepair,
  normalizeEvolvePolicy,
} from "../server/services/evolve-policy.js";

const execFileAsync = promisify(execFile);

async function initGitRepo() {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-policy-repo-"));
  await execFileAsync("git", ["init"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "README.md"), "demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: sourcePath });
  await execFileAsync("git", ["-c", "user.email=cpb@example.invalid", "-c", "user.name=CPB Test", "commit", "-m", "init"], {
    cwd: sourcePath,
  });
  return sourcePath;
}

test("guarded repair policy blocks non-allowlisted projects", async () => {
  const sourcePath = await initGitRepo();
  const project = { id: "project-a", name: "Project A", sourcePath };
  const policy = normalizeEvolvePolicy({ allowProjects: ["other"], blockedPriorities: [] });

  const result = await evaluateGuardedRepair({
    project,
    issue: { priority: "P2", description: "small cleanup" },
    policy,
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /not allowlisted/);
});

test("guarded repair policy blocks P0/P1 and high-risk keywords", () => {
  const policy = normalizeEvolvePolicy({ allowProjects: ["*"] });

  assert.deepEqual(
    classifyRepairRisk({ priority: "P1", description: "small-looking change" }, policy),
    { blocked: true, reason: "P1 issues require human review" },
  );
  assert.match(
    classifyRepairRisk({ priority: "P2", description: "update auth handling" }, policy).reason,
    /auth/,
  );
});

test("guarded repair policy requires a clean git worktree by default", async () => {
  const sourcePath = await initGitRepo();
  await writeFile(path.join(sourcePath, "dirty.txt"), "dirty\n", "utf8");
  const project = { id: "project-a", sourcePath };

  const result = await evaluateGuardedRepair({
    project,
    issue: { priority: "P2", description: "small cleanup" },
    policy: normalizeEvolvePolicy({ allowProjects: ["project-a"], blockedPriorities: [] }),
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /dirty/);
});
