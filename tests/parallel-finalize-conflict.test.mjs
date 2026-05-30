import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectParallelConflict, finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";
import { createJob, completeJob, recordWorktreeCreated } from "../server/services/job-store.js";

const execFileAsync = promisify(execFile);

function gitCmd(cwd, args) {
  return execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
}

function head(dir) {
  return execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, maxBuffer: 1024 * 1024 })
    .then((r) => r.stdout.trim());
}

async function makeGitRepo(dir) {
  await mkdir(dir, { recursive: true });
  await gitCmd(dir, ["init", "-b", "main"]);
  await gitCmd(dir, ["config", "user.email", "cpb@test.invalid"]);
  await gitCmd(dir, ["config", "user.name", "CPB Test"]);
  await writeFile(path.join(dir, "README.md"), "initial\n", "utf8");
  await gitCmd(dir, ["add", "README.md"]);
  await gitCmd(dir, ["commit", "-m", "initial"]);
}

async function addAndCommit(dir, filePath, content, message) {
  const fullPath = path.join(dir, filePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  await gitCmd(dir, ["add", filePath]);
  await gitCmd(dir, ["commit", "-m", message]);
}

describe("detectParallelConflict", () => {
  it("returns no conflict when source HEAD unchanged", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-conflict-test-"));
    try {
      await makeGitRepo(tmp);
      const h = await head(tmp);
      const result = await detectParallelConflict(tmp, h, ["src/foo.js"]);
      assert.equal(result.conflict, false);
      assert.equal(result.sourceAdvanced, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("detects file overlap when source advanced", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-conflict-test-"));
    try {
      await makeGitRepo(tmp);
      const oldHead = await head(tmp);

      await addAndCommit(tmp, "src/shared.js", "v1\n", "advance source");

      const result = await detectParallelConflict(tmp, oldHead, ["src/shared.js", "src/other.js"]);
      assert.equal(result.conflict, true);
      assert.equal(result.sourceAdvanced, true);
      assert.deepEqual(result.overlappingFiles, ["src/shared.js"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns no file conflict when source advanced but files disjoint", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-conflict-test-"));
    try {
      await makeGitRepo(tmp);
      const oldHead = await head(tmp);

      await addAndCommit(tmp, "src/alpha.js", "v1\n", "advance source");

      const result = await detectParallelConflict(tmp, oldHead, ["src/beta.js"]);
      assert.equal(result.conflict, false);
      assert.equal(result.sourceAdvanced, true);
      assert.deepEqual(result.overlappingFiles, []);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("normalizes paths before comparing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-conflict-test-"));
    try {
      await makeGitRepo(tmp);
      const oldHead = await head(tmp);

      await addAndCommit(tmp, "src/foo.js", "v1\n", "advance");

      const result = await detectParallelConflict(tmp, oldHead, ["./src/foo.js"]);
      assert.equal(result.conflict, true);
      assert.deepEqual(result.overlappingFiles, ["src/foo.js"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("finalizeSuccessfulQueueEntry parallel conflict", () => {
  async function setupFinalizeEnv() {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "cpb-finalize-conflict-"));
    const sourcePath = path.join(tmp, "source");
    const worktreePath = path.join(tmp, "worktree");
    const cpbRoot = path.join(tmp, "cpb");

    await makeGitRepo(sourcePath);
    const branch = "cpb/test-conflict";
    await gitCmd(sourcePath, ["worktree", "add", "-b", branch, worktreePath]);

    const created = await createJob(cpbRoot, {
      project: "test",
      task: "Parallel conflict test",
      workflow: "standard",
      sourceContext: {
        type: "github_issue",
        repo: "my-org/test",
        issueNumber: 42,
        issueTitle: "Parallel conflict test",
      },
    });
    await recordWorktreeCreated(cpbRoot, "test", created.jobId, {
      worktree: worktreePath,
      branch,
      baseBranch: "main",
    });
    const completed = await completeJob(cpbRoot, "test", created.jobId);

    return { tmp, sourcePath, worktreePath, cpbRoot, created, completed, branch };
  }

  const baseEntry = {
    id: "q-conflict-test",
    metadata: {
      issueNumber: 42,
      issueUrl: "https://github.com/my-org/test/issues/42",
      repo: "my-org/test",
    },
  };

  it("rejects with PARALLEL_FILE_CONFLICT when overlapping files merged by another finalize", async () => {
    const env = await setupFinalizeEnv();
    try {
      const { sourcePath, worktreePath, cpbRoot, completed } = env;

      // Worktree changes src/shared.js
      await addAndCommit(worktreePath, "src/shared.js", "worktree-change\n", "worktree change");

      // Simulate another finalize that already merged src/shared.js into source
      await addAndCommit(sourcePath, "src/shared.js", "other-finalize\n", "other finalize landed first");

      const result = await finalizeSuccessfulQueueEntry({
        cpbRoot,
        project: "test",
        entry: baseEntry,
        job: completed,
        sourcePath,
        mode: "local",
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, "rejected");
      assert.equal(result.code, "PARALLEL_FILE_CONFLICT");
      assert.equal(result.retryable, true);
      assert.ok(result.overlappingFiles.includes("src/shared.js"));
    } finally {
      await rm(env.tmp, { recursive: true, force: true });
    }
  });

  it("rejects with SOURCE_ADVANCED_NO_CONFLICT when source advanced without overlap", async () => {
    const env = await setupFinalizeEnv();
    try {
      const { sourcePath, worktreePath, cpbRoot, completed } = env;

      // Worktree changes src/beta.js
      await addAndCommit(worktreePath, "src/beta.js", "worktree-change\n", "worktree change");

      // Other finalize merged src/alpha.js (disjoint)
      await addAndCommit(sourcePath, "src/alpha.js", "other-finalize\n", "other finalize disjoint files");

      const result = await finalizeSuccessfulQueueEntry({
        cpbRoot,
        project: "test",
        entry: baseEntry,
        job: completed,
        sourcePath,
        mode: "local",
      });

      assert.equal(result.ok, false);
      assert.equal(result.status, "rejected");
      assert.equal(result.code, "SOURCE_ADVANCED_NO_CONFLICT");
      assert.equal(result.retryable, true);
      assert.deepEqual(result.overlappingFiles, []);
    } finally {
      await rm(env.tmp, { recursive: true, force: true });
    }
  });

  it("succeeds when no parallel finalize occurred", async () => {
    const env = await setupFinalizeEnv();
    try {
      const { sourcePath, worktreePath, cpbRoot, completed } = env;

      await addAndCommit(worktreePath, "src/solo.js", "solo-change\n", "solo change");

      const result = await finalizeSuccessfulQueueEntry({
        cpbRoot,
        project: "test",
        entry: baseEntry,
        job: completed,
        sourcePath,
        mode: "local",
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "finalized");
    } finally {
      await rm(env.tmp, { recursive: true, force: true });
    }
  });

  it("logs parallel_finalize_conflict event to event store", async () => {
    const env = await setupFinalizeEnv();
    try {
      const { sourcePath, worktreePath, cpbRoot, completed, created } = env;

      await addAndCommit(worktreePath, "src/overlap.js", "wt\n", "wt change");
      await addAndCommit(sourcePath, "src/overlap.js", "other\n", "other");

      await finalizeSuccessfulQueueEntry({
        cpbRoot,
        project: "test",
        entry: baseEntry,
        job: completed,
        sourcePath,
        mode: "local",
      });

      const { readEvents } = await import("../server/services/event-store.js");
      const events = await readEvents(cpbRoot, "test", created.jobId);
      const conflictEvents = events.filter((e) => e.type === "parallel_finalize_conflict");
      assert.equal(conflictEvents.length, 1);
      assert.equal(conflictEvents[0].conflict, true);
      assert.ok(conflictEvents[0].overlappingFiles.includes("src/overlap.js"));
    } finally {
      await rm(env.tmp, { recursive: true, force: true });
    }
  });
});
