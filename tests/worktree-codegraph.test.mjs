import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createWorktree } from "../runtime/git/worktree.js";

const execFile = promisify(execFileCb);

async function git(cwd, args) {
  return execFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cpb-test",
      GIT_AUTHOR_EMAIL: "cpb-test@example.com",
      GIT_COMMITTER_NAME: "cpb-test",
      GIT_COMMITTER_EMAIL: "cpb-test@example.com",
    },
  });
}

async function gitOutput(cwd, args) {
  const result = await git(cwd, args);
  return result.stdout.trim();
}

describe("worktree codegraph inheritance", () => {
  it("links the source .codegraph into created pipeline worktrees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-worktree-codegraph-"));
    const source = path.join(root, "source");
    const worktreesRoot = path.join(root, "worktrees");
    const codegraphDir = path.join(source, ".codegraph");

    try {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "package.json"), "{\"type\":\"module\"}\n", "utf8");
      await git(source, ["init"]);
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "baseline"]);

      await mkdir(codegraphDir, { recursive: true });
      await writeFile(path.join(codegraphDir, "manifest.json"), "{\"ready\":true}\n", "utf8");

      const worktree = await createWorktree({
        project: source,
        jobId: "job-codegraph",
        slug: "pipeline",
        worktreesRoot,
      });

      const inheritedPath = path.join(worktree.path, ".codegraph");
      const inheritedStat = await lstat(inheritedPath);
      assert.equal(inheritedStat.isSymbolicLink(), true);
      assert.equal(await realpath(inheritedPath), await realpath(codegraphDir));
      assert.equal(await readFile(path.join(inheritedPath, "manifest.json"), "utf8"), "{\"ready\":true}\n");
      assert.equal(await gitOutput(worktree.path, ["status", "--short"]), "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
