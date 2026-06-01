import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeGithubRepo, resolveGithubRepo } from "../scripts/e2e-npm-pack.mjs";

describe("e2e-npm-pack script", () => {
  it("does not hardcode a single GitHub repository", async () => {
    const script = await readFile(new URL("../scripts/e2e-npm-pack.mjs", import.meta.url), "utf8");
    assert.equal(script.includes("\"changw98ic/codepatchbay\""), false);
  });

  it("resolves GitHub repo from env before git remote", () => {
    const repo = resolveGithubRepo({
      env: { CPB_E2E_GITHUB_REPO: "example/fork" },
      execSyncFn: () => {
        throw new Error("git should not be called");
      },
    });
    assert.equal(repo, "example/fork");
  });

  it("normalizes common GitHub remote URL formats", () => {
    assert.equal(normalizeGithubRepo("git@github.com:owner/repo.git"), "owner/repo");
    assert.equal(normalizeGithubRepo("https://github.com/owner/repo.git"), "owner/repo");
    assert.equal(normalizeGithubRepo("owner/repo"), "owner/repo");
  });
});
