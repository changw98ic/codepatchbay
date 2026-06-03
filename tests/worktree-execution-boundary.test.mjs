import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { buildMeta, REQUIRED_EXECUTION_BOUNDARY } from "../core/job/meta.js";
import { enqueue } from "../server/services/hub-queue.js";
import { mergeProfilePolicy } from "../server/services/permission-matrix.js";
import { createIsolatedWorktreeWithRetry } from "../runtime/worker/managed-worker.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd });
}

describe("worktree execution boundary", () => {
  it("hard-codes executionBoundary to worktree in normalized metadata and queue entries", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-worktree-boundary-"));
    try {
      const sourcePath = path.join(tmpDir, "source");
      const hubRoot = path.join(tmpDir, "hub");
      await mkdir(sourcePath, { recursive: true });

      const meta = buildMeta({
        projectId: "flow",
        sourcePath,
        cwd: sourcePath,
        executionBoundary: "source",
      });
      assert.equal(meta.executionBoundary, REQUIRED_EXECUTION_BOUNDARY);

      const entry = await enqueue(hubRoot, {
        projectId: "flow",
        sourcePath,
        cwd: sourcePath,
        executionBoundary: "source",
        description: "must run in a worktree",
        metadata: {},
      });
      assert.equal(entry.executionBoundary, REQUIRED_EXECUTION_BOUNDARY);

      const rawQueue = JSON.parse(await readFile(path.join(hubRoot, "queue", "queue.json"), "utf8"));
      assert.equal(rawQueue.entries[0].executionBoundary, REQUIRED_EXECUTION_BOUNDARY);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not let permission profiles override the worktree boundary", () => {
    const policy = mergeProfilePolicy(
      {
        role: "executor",
        readAllowed: ["*"],
        writeAllowed: [],
        writeDenied: [],
        observablePaths: [],
        executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
      },
      { execution_boundary: "source" },
    );

    assert.equal(policy.executionBoundary, REQUIRED_EXECUTION_BOUNDARY);
  });

  it("retries worktree creation and returns only an isolated worktree path", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-worktree-retry-"));
    try {
      const sourcePath = path.join(tmpDir, "source");
      const hubRoot = path.join(tmpDir, "hub");
      await mkdir(sourcePath, { recursive: true });

      const cleanupCalls = [];
      let createCalls = 0;
      const worktreeInfo = await createIsolatedWorktreeWithRetry({
        hubRoot,
        sourcePath,
        entryId: "q-retry-001",
        retryDelayMs: 0,
        maxAttempts: 2,
        create: async ({ jobId, slug, worktreesRoot }) => {
          createCalls += 1;
          if (createCalls === 1) throw new Error("stale worktree path");
          const worktreePath = path.join(worktreesRoot, `${jobId}-${slug}`);
          await mkdir(worktreePath, { recursive: true });
          return { branch: `cpb/${jobId}-${slug}`, path: worktreePath };
        },
        runGit: async (_command, args, opts) => {
          cleanupCalls.push({ args, cwd: opts.cwd });
          return { stdout: "", stderr: "" };
        },
        removePath: async (target, options) => {
          cleanupCalls.push({ args: ["rm"], target, options });
        },
      });

      assert.equal(createCalls, 2);
      assert.notEqual(path.resolve(worktreeInfo.path), path.resolve(sourcePath));
      assert.match(worktreeInfo.path, /worktrees/);
      assert.ok(cleanupCalls.some((call) => call.args?.[0] === "worktree" && call.args?.[1] === "remove"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed when worktree creation resolves to the source checkout", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-worktree-source-reject-"));
    try {
      const sourcePath = path.join(tmpDir, "source");
      const hubRoot = path.join(tmpDir, "hub");
      await mkdir(sourcePath, { recursive: true });

      await assert.rejects(
        () => createIsolatedWorktreeWithRetry({
          hubRoot,
          sourcePath,
          entryId: "q-source-001",
          retryDelayMs: 0,
          maxAttempts: 1,
          create: async ({ jobId, slug }) => ({ branch: `cpb/${jobId}-${slug}`, path: sourcePath }),
          runGit: async () => ({ stdout: "", stderr: "" }),
          removePath: async () => {},
        }),
        /refusing to run against source checkout/,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a real git worktree without dirtying the source checkout", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-worktree-real-"));
    try {
      const sourcePath = path.join(tmpDir, "source");
      const hubRoot = path.join(tmpDir, "hub");
      await mkdir(sourcePath, { recursive: true });
      await git(sourcePath, ["init", "-b", "main"]);
      await git(sourcePath, ["config", "user.email", "cpb-test@example.invalid"]);
      await git(sourcePath, ["config", "user.name", "CPB Test"]);
      await writeFile(
        path.join(sourcePath, ".gitignore"),
        [
          ".env",
          ".env.*",
          "node_modules/",
          "dist/",
          "build/",
          "coverage/",
          "cpb-task/state/",
          "cpb-task/worktrees/",
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(path.join(sourcePath, "README.md"), "# Source\n", "utf8");
      await git(sourcePath, ["add", "."]);
      await git(sourcePath, ["commit", "-m", "initial"]);

      const worktreeInfo = await createIsolatedWorktreeWithRetry({
        hubRoot,
        sourcePath,
        entryId: "q-real-001",
        retryDelayMs: 0,
      });

      assert.notEqual(path.resolve(worktreeInfo.path), path.resolve(sourcePath));
      assert.match(worktreeInfo.path, /worktrees/);
      const { stdout } = await git(sourcePath, ["status", "--porcelain"]);
      assert.equal(stdout.trim(), "");

      await git(sourcePath, ["worktree", "remove", "--force", worktreeInfo.path]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
