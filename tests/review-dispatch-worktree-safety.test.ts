import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  acceptSession,
  dispatchSession,
  rejectSession,
} from "../server/services/review/review-dispatch.js";
import {
  createSession,
  getSession,
  updateSession,
  withReviewSessionLockTestHooksForTests,
} from "../server/services/review/review-session.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { listQueue, updateEntry } from "../server/services/hub/hub-queue.js";
import { createJob } from "../server/services/job/job-store.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]) {
  const result = await execFile("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(result.stdout || "").trim();
}

type ReviewWorktreeFixture = Awaited<ReturnType<typeof prepareReviewWorktree>>;

async function prepareReviewWorktree(prefix: string) {
  const cpbRoot = await tempRoot(`${prefix}-cpb`);
  const hubRoot = await tempRoot(`${prefix}-hub`);
  const sourcePath = await tempRoot(`${prefix}-source`);
  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.email", "review-test@example.invalid"]);
  await git(sourcePath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Review fixture\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "Initial fixture"]);
  await git(sourcePath, ["branch", "-M", "main"]);

  const project = await registerProject(hubRoot, {
    id: "proj",
    sourcePath,
    skipCodeGraphGate: true,
  });
  if (!project.projectRuntimeRoot) throw new Error("registered test project has no runtime root");
  const jobId = `job-${prefix}`;
  const branch = `cpb/${jobId}-pipeline`;
  const branchRef = `refs/heads/${branch}`;
  const sourceBaseBranch = "refs/heads/main";
  const sourceBaseCommit = await git(sourcePath, ["rev-parse", "--verify", "HEAD"]);
  const worktreesRoot = path.join(project.projectRuntimeRoot, "worktrees");
  const worktreePath = path.join(worktreesRoot, `${jobId}-pipeline`);
  await mkdir(worktreesRoot, { recursive: true });
  await git(sourcePath, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  const directory = await lstat(worktreePath, { bigint: true });
  const worktreeOwnership = {
    version: 2 as const,
    state: "ready" as const,
    ownerToken: randomUUID(),
    baseBranch: "main",
    baseCommit: sourceBaseCommit,
    directory: {
      dev: String(directory.dev),
      ino: String(directory.ino),
      birthtimeNs: String(directory.birthtimeNs),
      mode: String(directory.mode),
      uid: String(directory.uid),
      gid: String(directory.gid),
    },
  };
  await git(sourcePath, [
    "config",
    "--local",
    "--replace-all",
    `branch.${branch}.cpbBaseBinding`,
    JSON.stringify(worktreeOwnership),
  ]);
  await writeFile(path.join(worktreePath, "review-change.txt"), `${prefix}\n`, "utf8");
  await git(worktreePath, ["add", "review-change.txt"]);
  await git(worktreePath, ["commit", "-m", `Review change ${prefix}`]);
  await createJob(cpbRoot, {
    project: "proj",
    jobId,
    task: `review ${prefix}`,
    dataRoot: project.projectRuntimeRoot,
  });
  await appendEvent(cpbRoot, "proj", jobId, {
    type: "worktree_created",
    project: "proj",
    jobId,
    worktree: worktreePath,
    branch,
    baseBranch: "main",
    baseCommit: sourceBaseCommit,
    worktreeOwnership,
    ts: new Date().toISOString(),
  }, { dataRoot: project.projectRuntimeRoot, includeLegacyFallback: false });

  const storageOptions = { hubRoot };
  const session = await createSession(cpbRoot, {
    project: "proj",
    intent: `review ${prefix}`,
    ...storageOptions,
  });
  await updateSession(cpbRoot, session.sessionId, {
    status: "user_review",
    jobId,
    worktreePath,
    sourceBaseBranch,
    sourceBaseCommit,
  }, { ...storageOptions, skipTransitionCheck: true });
  return {
    cpbRoot,
    hubRoot,
    sourcePath,
    project,
    jobId,
    branch,
    branchRef,
    sourceBaseBranch,
    sourceBaseCommit,
    worktreesRoot,
    worktreePath,
    sessionId: session.sessionId,
    storageOptions,
  };
}

async function assertSessionStatus(fixture: ReviewWorktreeFixture, expected: string) {
  const session = await getSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);
  assert.ok(session);
  assert.equal(session.status, expected);
  return session;
}

test("review dispatch binds the session to the registered project runtime worktree", async () => {
  const cpbRoot = await tempRoot("cpb-review-dispatch-binding-cpb");
  const hubRoot = await tempRoot("cpb-review-dispatch-binding-hub");
  const sourcePath = await tempRoot("cpb-review-dispatch-binding-source");
  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.email", "review-test@example.invalid"]);
  await git(sourcePath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Dispatch binding\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "Initial dispatch fixture"]);
  await git(sourcePath, ["branch", "-M", "main"]);
  const project = await registerProject(hubRoot, {
    id: "proj",
    sourcePath,
    skipCodeGraphGate: true,
  });
  if (!project.projectRuntimeRoot) throw new Error("registered dispatch project has no runtime root");
  const session = await createSession(cpbRoot, { project: "proj", intent: "dispatch binding", hubRoot });
  await updateSession(cpbRoot, session.sessionId, { status: "user_review" }, {
    hubRoot,
    skipTransitionCheck: true,
  });

  const result: any = await dispatchSession(cpbRoot, session.sessionId, { hubRoot });

  assert.equal(result.ok, true);
  assert.equal(
    result.session.worktreePath,
    path.join(project.projectRuntimeRoot, "worktrees", `${result.jobId}-pipeline`),
  );
  assert.equal(result.session.worktreePath.startsWith(path.join(cpbRoot, "cpb-task")), false);
});

test("review dispatch recovers the exact claimed queue entry after session publication fails", async () => {
  const cpbRoot = await tempRoot("cpb-review-dispatch-recovery-cpb");
  const hubRoot = await tempRoot("cpb-review-dispatch-recovery-hub");
  const sourcePath = await tempRoot("cpb-review-dispatch-recovery-source");
  await git(sourcePath, ["init"]);
  await git(sourcePath, ["config", "user.email", "review-test@example.invalid"]);
  await git(sourcePath, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(sourcePath, "README.md"), "# Dispatch recovery\n", "utf8");
  await git(sourcePath, ["add", "README.md"]);
  await git(sourcePath, ["commit", "-m", "Initial dispatch recovery fixture"]);
  await git(sourcePath, ["branch", "-M", "main"]);
  await registerProject(hubRoot, {
    id: "proj",
    sourcePath,
    skipCodeGraphGate: true,
  });
  const session = await createSession(cpbRoot, { project: "proj", intent: "recover dispatch", hubRoot });
  await updateSession(cpbRoot, session.sessionId, { status: "user_review" }, {
    hubRoot,
    skipTransitionCheck: true,
  });

  await assert.rejects(
    withReviewSessionLockTestHooksForTests({
      beforeSessionPublish: () => {
        throw new Error("simulated session publication failure");
      },
    }, () => dispatchSession(cpbRoot, session.sessionId, { hubRoot })),
    /durable JSON publication failed/,
  );

  const afterFailure = await listQueue(hubRoot, { projectId: "proj" });
  assert.equal(afterFailure.length, 1);
  const original = afterFailure[0];
  const originalJobId = original.metadata?.jobId;
  assert.equal(typeof originalJobId, "string");
  const claimed = await updateEntry(hubRoot, original.id, {
    status: "in_progress",
    claimedBy: "recovery-test-worker",
    claimedAt: new Date().toISOString(),
  }, { expectedStatus: "pending" });
  assert.ok(claimed);

  const recovered: any = await dispatchSession(cpbRoot, session.sessionId, { hubRoot });

  assert.equal(recovered.ok, true);
  assert.equal(recovered.taskId, original.id);
  assert.equal(recovered.jobId, originalJobId);
  const finalQueue = await listQueue(hubRoot, { projectId: "proj" });
  assert.equal(finalQueue.length, 1, "retry must not create a second queue entry after the first was claimed");
  assert.equal(recovered.session.queueEntryId, original.id);
  assert.equal(recovered.session.jobId, originalJobId);
});

test("review rejection preserves a forged path and the legitimate registered worktree", async () => {
  const fixture = await prepareReviewWorktree("forged-path");
  const sentinel = await tempRoot("cpb-review-forged-sentinel");
  const marker = path.join(sentinel, "must-survive.txt");
  await writeFile(marker, "survive\n", "utf8");
  await updateSession(fixture.cpbRoot, fixture.sessionId, { worktreePath: sentinel }, fixture.storageOptions);

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, false);
  assert.equal(result.code, "REVIEW_WORKTREE_BINDING_INVALID");
  assert.equal(await readFile(marker, "utf8"), "survive\n");
  assert.equal(existsSync(fixture.worktreePath), true);
  await assertSessionStatus(fixture, "user_review");
});

test("review rejection refuses a symlink at the exact managed worktree path", async () => {
  const fixture = await prepareReviewWorktree("symlink-path");
  const relocated = `${fixture.worktreePath}.relocated`;
  const sentinel = await tempRoot("cpb-review-symlink-sentinel");
  const marker = path.join(sentinel, "must-survive.txt");
  await writeFile(marker, "survive\n", "utf8");
  await rename(fixture.worktreePath, relocated);
  await symlink(sentinel, fixture.worktreePath, "dir");

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, false);
  assert.equal(result.code, "REVIEW_WORKTREE_PATH_UNSAFE");
  assert.equal(await readFile(marker, "utf8"), "survive\n");
  assert.equal(existsSync(relocated), true);
  await assertSessionStatus(fixture, "user_review");
});

test("review quarantine preserves both generations when replacement lands in the mutation window", async () => {
  const fixture = await prepareReviewWorktree("mutation-window");
  const originalRecovery = `${fixture.worktreePath}.original-recovery`;
  let quarantinePath = "";

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      beforeIsolation: (context: { quarantinePath: string }) => {
        quarantinePath = context.quarantinePath;
      },
      renameSyncForTests: (sourcePath: string, destinationPath: string) => {
        renameSync(sourcePath, originalRecovery);
        mkdirSync(sourcePath);
        writeFileSync(path.join(sourcePath, "successor.txt"), "successor\n", "utf8");
        renameSync(sourcePath, destinationPath);
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "REVIEW_WORKTREE_QUARANTINE_GENERATION_CONFLICT", result.cleanupError);
  assert.equal(existsSync(path.join(originalRecovery, "review-change.txt")), true);
  assert.equal(await readFile(path.join(quarantinePath, "successor.txt"), "utf8"), "successor\n");
  assert.equal((await git(fixture.sourcePath, ["worktree", "list", "--porcelain", "-z"])).includes(fixture.branchRef), true);
  await assertSessionStatus(fixture, "user_review");
});

test("review rejection never prunes unrelated missing worktree metadata", async () => {
  const fixture = await prepareReviewWorktree("unrelated-metadata");
  const unrelatedBranch = "cpb/unrelated-missing-worktree";
  const unrelatedRef = `refs/heads/${unrelatedBranch}`;
  const unrelatedPath = path.join(fixture.worktreesRoot, "unrelated-missing-worktree");
  const unrelatedRecovery = `${unrelatedPath}.retained`;
  await git(fixture.sourcePath, ["worktree", "add", "-b", unrelatedBranch, unrelatedPath, "HEAD"]);
  await rename(unrelatedPath, unrelatedRecovery);
  const before = await git(fixture.sourcePath, ["worktree", "list", "--porcelain", "-z"]);
  assert.equal(before.includes(unrelatedRef), true);

  const runGit = async (cwd: string, args: string[]) => {
    if (
      (args[0] === "worktree" && ["prune", "remove"].includes(args[1] || ""))
      || (args[0] === "branch" && args[1] === "-D")
    ) {
      throw Object.assign(new Error(`destructive Git cleanup invoked: ${args.join(" ")}`), {
        code: "TEST_DESTRUCTIVE_GIT_CLEANUP",
      });
    }
    return git(cwd, args);
  };

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: { runGit },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(fixture.worktreePath), false);
  assert.equal(existsSync(unrelatedRecovery), true);
  const after = await git(fixture.sourcePath, ["worktree", "list", "--porcelain", "-z"]);
  assert.equal(after.includes(unrelatedRef), true);
  assert.equal(after.includes(fixture.branchRef), true);
  await assertSessionStatus(fixture, "expired");
});

test("review rejection quarantines the bound worktree and defers exact metadata and branch cleanup", async () => {
  const fixture = await prepareReviewWorktree("reject-success");

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(fixture.worktreePath), false);
  assert.equal(await readFile(path.join(result.recoveryPath, "review-change.txt"), "utf8"), "reject-success\n");
  assert.equal((await git(fixture.sourcePath, ["worktree", "list", "--porcelain", "-z"])).includes(fixture.branchRef), true);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "--verify", fixture.branchRef]) !== "", true);
  assert.equal(result.metadataCleanupDeferred, true);
  assert.equal(result.branchCleanupDeferred, true);
  const updated = await assertSessionStatus(fixture, "expired");
  assert.equal(updated.worktreeRecoveryPath, result.recoveryPath);
  assert.equal(updated.worktreeMetadataCleanup, "deferred");
});

test("review acceptance merges the pinned commit and preserves a quarantined recovery copy", async () => {
  const fixture = await prepareReviewWorktree("accept-success");

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.merged, true);
  assert.equal(result.status, "completed");
  assert.equal(await readFile(path.join(fixture.sourcePath, "review-change.txt"), "utf8"), "accept-success\n");
  assert.equal(await readFile(path.join(result.recoveryPath, "review-change.txt"), "utf8"), "accept-success\n");
  assert.equal(existsSync(fixture.worktreePath), false);
  assert.equal((await git(fixture.sourcePath, ["worktree", "list", "--porcelain", "-z"])).includes(fixture.branchRef), true);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "--verify", fixture.branchRef]) !== "", true);
  assert.equal(result.metadataCleanupDeferred, true);
  assert.equal(result.branchCleanupDeferred, true);
  await assertSessionStatus(fixture, "completed");
});

test("review acceptance refuses a dirty registered source without changing refs or the worktree", async () => {
  const fixture = await prepareReviewWorktree("accept-dirty-source");
  const sourceHead = await git(fixture.sourcePath, ["rev-parse", "HEAD"]);
  const reviewHead = await git(fixture.sourcePath, ["rev-parse", fixture.branchRef]);
  const dirtyPath = path.join(fixture.sourcePath, "user-untracked.txt");
  await writeFile(dirtyPath, "user state\n", "utf8");

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, false);
  assert.equal(result.merged, false);
  assert.equal(result.status, "merge_failed");
  assert.equal(result.code, "REVIEW_SOURCE_DIRTY", result.session?.mergeError);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "HEAD"]), sourceHead);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", fixture.branchRef]), reviewHead);
  assert.equal(await readFile(dirtyPath, "utf8"), "user state\n");
  assert.equal(existsSync(path.join(fixture.sourcePath, "review-change.txt")), false);
  assert.equal(existsSync(fixture.worktreePath), true);
  await assertSessionStatus(fixture, "merge_failed");
});

test("review acceptance refuses a different current source branch without changing refs", async () => {
  const fixture = await prepareReviewWorktree("accept-wrong-source-branch");
  await git(fixture.sourcePath, ["switch", "-c", "user-current-branch"]);
  const sourceHead = await git(fixture.sourcePath, ["rev-parse", "HEAD"]);
  const reviewHead = await git(fixture.sourcePath, ["rev-parse", fixture.branchRef]);

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, false);
  assert.equal(result.merged, false);
  assert.equal(result.status, "merge_failed");
  assert.equal(result.code, "REVIEW_SOURCE_BRANCH_MISMATCH", result.session?.mergeError);
  assert.equal(await git(fixture.sourcePath, ["symbolic-ref", "--quiet", "HEAD"]), "refs/heads/user-current-branch");
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "HEAD"]), sourceHead);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", fixture.branchRef]), reviewHead);
  assert.equal(existsSync(path.join(fixture.sourcePath, "review-change.txt")), false);
  assert.equal(existsSync(fixture.worktreePath), true);
  await assertSessionStatus(fixture, "merge_failed");
});

test("review acceptance records partial merge truth and does not complete when isolation fails", async () => {
  const fixture = await prepareReviewWorktree("accept-isolation-failure");

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      renameSyncForTests: () => {
        throw Object.assign(new Error("injected isolation rename failure"), {
          code: "TEST_ISOLATION_RENAME_FAILED",
        });
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.merged, true);
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.status, "merge_failed");
  assert.equal(result.code, "TEST_ISOLATION_RENAME_FAILED");
  assert.equal(await readFile(path.join(fixture.sourcePath, "review-change.txt"), "utf8"), "accept-isolation-failure\n");
  assert.equal(await readFile(path.join(fixture.worktreePath, "review-change.txt"), "utf8"), "accept-isolation-failure\n");
  const updated = await assertSessionStatus(fixture, "merge_failed");
  assert.equal(updated.merged, true);
  assert.equal(updated.worktreeCleanupCode, "TEST_ISOLATION_RENAME_FAILED");
});

test("review rejection refuses a reconstructed logical successor with the same managed pathname", async () => {
  const fixture = await prepareReviewWorktree("successor-reconstruction");
  const ownedRecovery = `${fixture.worktreePath}.owned-recovery`;
  await rename(fixture.worktreePath, ownedRecovery);
  await mkdir(fixture.worktreePath);
  await writeFile(path.join(fixture.worktreePath, "successor.txt"), "successor survives\n", "utf8");

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(result.ok, false);
  assert.equal(result.code, "REVIEW_WORKTREE_OWNERSHIP_MISMATCH");
  assert.equal(await readFile(path.join(ownedRecovery, "review-change.txt"), "utf8"), "successor-reconstruction\n");
  assert.equal(await readFile(path.join(fixture.worktreePath, "successor.txt"), "utf8"), "successor survives\n");
  await assertSessionStatus(fixture, "user_review");
});

test("review acceptance journals exact conflicted source mutation instead of claiming merged false", async () => {
  const fixture = await prepareReviewWorktree("conflict-mutation");

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      beforeSourceMutation: async ({ fixedWorktreeHead }: { fixedWorktreeHead: string }) => {
        await git(fixture.sourcePath, ["switch", "-c", "conflict-source"]);
        await writeFile(path.join(fixture.sourcePath, "review-change.txt"), "conflicting user commit\n", "utf8");
        await git(fixture.sourcePath, ["add", "review-change.txt"]);
        await git(fixture.sourcePath, ["commit", "-m", "Conflicting source commit"]);
        await assert.rejects(() => git(fixture.sourcePath, ["merge", fixedWorktreeHead]));
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.merged, null);
  assert.equal(result.code, "REVIEW_SOURCE_MUTATION_RACE");
  const updated: any = await assertSessionStatus(fixture, "merge_failed");
  assert.equal(updated.reviewDecision.mergeProof.sourceMutation, true);
  assert.equal(updated.reviewDecision.mergeProof.outcome, "unconfirmed");
  assert.equal(updated.reviewDecision.mergeProof.after.symbolicRef, "refs/heads/conflict-source");
  assert.equal(updated.reviewDecision.mergeProof.after.mergeHead, await git(fixture.sourcePath, ["rev-parse", "MERGE_HEAD"]));
  assert.notEqual(updated.reviewDecision.mergeProof.after.statusPorcelainV2, "");
  assert.match(updated.reviewDecision.mergeProof.after.indexEntries, /review-change\.txt/);
});

test("review acceptance retry recognizes the exact merge commit after a crash before journal proof", async () => {
  const fixture = await prepareReviewWorktree("merge-crash-retry");
  let crashedMergeCommit = "";

  await assert.rejects(
    () => acceptSession(fixture.cpbRoot, fixture.sessionId, {
      ...fixture.storageOptions,
      worktreeCleanupTestHooks: {
        afterMergeRefCas: ({ mergeCommit }: { mergeCommit: string }) => {
          crashedMergeCommit = mergeCommit;
          throw Object.assign(new Error("simulated process crash after merge"), {
            code: "TEST_REVIEW_SIMULATED_CRASH",
            simulateCrash: true,
          });
        },
      },
    }),
    /simulated process crash after merge/,
  );
  assert.match(crashedMergeCommit, /^[0-9a-f]{40}$/);
  const interrupted: any = await assertSessionStatus(fixture, "user_review");
  assert.equal(interrupted.reviewDecision.phase, "intent");
  assert.equal(await git(fixture.sourcePath, ["rev-parse", fixture.sourceBaseBranch]), crashedMergeCommit);

  const retried: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.merged, true);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", fixture.sourceBaseBranch]), crashedMergeCommit);
  const parents = (await git(fixture.sourcePath, ["show", "-s", "--format=%P", crashedMergeCommit])).split(" ");
  assert.deepEqual(parents, [fixture.sourceBaseCommit, await git(fixture.sourcePath, ["rev-parse", fixture.branchRef])]);
  const updated: any = await assertSessionStatus(fixture, "completed");
  assert.equal(updated.reviewDecision.mergeProof.mergeCommit, crashedMergeCommit);
});

test("review rejection preserves an exclusive quarantine destination race without clobbering", async () => {
  const fixture = await prepareReviewWorktree("quarantine-destination-race");
  let racedPath = "";

  const result: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      beforeIsolation: ({ quarantinePath }: { quarantinePath: string }) => {
        racedPath = quarantinePath;
      },
      renameSyncForTests: (sourcePath: string, quarantinePath: string) => {
        mkdirSync(quarantinePath);
        writeFileSync(path.join(quarantinePath, "racer.txt"), "preserve racer\n", "utf8");
        renameSync(sourcePath, quarantinePath);
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "REVIEW_WORKTREE_QUARANTINE_COLLISION");
  assert.equal(result.isolationCommitted, false);
  assert.equal(await readFile(path.join(racedPath, "racer.txt"), "utf8"), "preserve racer\n");
  assert.equal(await readFile(path.join(fixture.worktreePath, "review-change.txt"), "utf8"), "quarantine-destination-race\n");
  const updated: any = await assertSessionStatus(fixture, "user_review");
  assert.equal(updated.reviewDecision.cleanupProof.committed, false);
  assert.deepEqual(updated.reviewDecision.cleanupProof.recoveryPaths.sort(), [racedPath, fixture.worktreePath].sort());
});

test("review acceptance detects a source branch switch inside the repository mutation fence", async () => {
  const fixture = await prepareReviewWorktree("source-branch-switch-race");

  const result: any = await acceptSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      beforeSourceMutation: async () => {
        await git(fixture.sourcePath, ["switch", "-c", "race-successor-branch"]);
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.merged, null);
  assert.equal(result.code, "REVIEW_SOURCE_MUTATION_RACE");
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "refs/heads/main"]), fixture.sourceBaseCommit);
  assert.equal(await git(fixture.sourcePath, ["rev-parse", "refs/heads/race-successor-branch"]), fixture.sourceBaseCommit);
  assert.equal(existsSync(path.join(fixture.sourcePath, "review-change.txt")), false);
  const updated: any = await assertSessionStatus(fixture, "merge_failed");
  assert.equal(updated.reviewDecision.mergeProof.sourceMutation, true);
  assert.equal(updated.reviewDecision.mergeProof.after.symbolicRef, "refs/heads/race-successor-branch");
});

test("review rejection retries a committed isolation after durability confirmation failed", async () => {
  const fixture = await prepareReviewWorktree("committed-isolation-recovery");

  const first: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, {
    ...fixture.storageOptions,
    worktreeCleanupTestHooks: {
      fsyncDirectory: async () => {
        throw Object.assign(new Error("injected quarantine fsync failure"), {
          code: "TEST_QUARANTINE_FSYNC_FAILED",
        });
      },
    },
  });

  assert.equal(first.ok, false);
  assert.equal(first.code, "REVIEW_WORKTREE_QUARANTINE_DURABILITY_FAILED");
  assert.equal(first.isolationCommitted, true);
  assert.equal(first.durabilityConfirmed, false);
  assert.equal(first.quarantinePreserved, true);
  assert.equal(existsSync(fixture.worktreePath), false);
  assert.equal(await readFile(path.join(first.recoveryPath, "review-change.txt"), "utf8"), "committed-isolation-recovery\n");
  const interrupted: any = await assertSessionStatus(fixture, "user_review");
  assert.equal(interrupted.reviewDecision.phase, "cleanup_proof");
  assert.equal(interrupted.reviewDecision.cleanupProof.committed, true);

  const retried: any = await rejectSession(fixture.cpbRoot, fixture.sessionId, fixture.storageOptions);

  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(retried.recoveryPath, first.recoveryPath);
  const completed: any = await assertSessionStatus(fixture, "expired");
  assert.equal(completed.reviewDecision.final.status, "expired");
  assert.equal(completed.reviewDecision.cleanupProof.durabilityConfirmed, true);
});
