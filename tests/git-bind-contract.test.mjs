import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseGitRemote(url) {
  const input = String(url || "").trim();

  // GitHub URLs: git@github.com:user/repo.git or https://github.com/user/repo.git
  const githubSsh = /^git@github\.com:(.+?)\/(.+?)(\.git)?$/;
  const githubHttps = /^https:\/\/github\.com\/(.+?)\/(.+?)(\.git)?$/;
  const githubMatch = input.match(githubSsh) || input.match(githubHttps);
  if (githubMatch) {
    return {
      platform: "github",
      owner: githubMatch[1],
      repo: githubMatch[2],
      fullName: `${githubMatch[1]}/${githubMatch[2]}`,
      url: input,
    };
  }

  // GitLab URLs: git@gitlab.com:user/repo.git or https://gitlab.com/user/repo.git
  const gitlabSsh = /^git@gitlab\.com:(.+?)\/(.+?)(\.git)?$/;
  const gitlabHttps = /^https:\/\/gitlab\.com\/(.+?)\/(.+?)(\.git)?$/;
  const gitlabMatch = input.match(gitlabSsh) || input.match(gitlabHttps);
  if (gitlabMatch) {
    return {
      platform: "gitlab",
      owner: gitlabMatch[1],
      repo: gitlabMatch[2],
      fullName: `${gitlabMatch[1]}/${gitlabMatch[2]}`,
      url: input,
    };
  }

  // Bitbucket URLs: git@bitbucket.org:user/repo.git or https://bitbucket.org/user/repo.git
  const bitbucketSsh = /^git@bitbucket\.org:(.+?)\/(.+?)(\.git)?$/;
  const bitbucketHttps = /^https:\/\/bitbucket\.org\/(.+?)\/(.+?)(\.git)?$/;
  const bitbucketMatch = input.match(bitbucketSsh) || input.match(bitbucketHttps);
  if (bitbucketMatch) {
    return {
      platform: "bitbucket",
      owner: bitbucketMatch[1],
      repo: bitbucketMatch[2],
      fullName: `${bitbucketMatch[1]}/${bitbucketMatch[2]}`,
      url: input,
    };
  }

  // Generic git URL (any valid git URL)
  try {
    const urlObj = new URL(input.startsWith("git@") ? `ssh://${input.replace(":", "/")}` : input);
    if (urlObj.protocol === "ssh:" || urlObj.protocol === "https:" || urlObj.protocol === "http:" || urlObj.protocol === "git:") {
      return {
        platform: "generic",
        url: input,
      };
    }
  } catch {}

  throw new Error(`invalid git remote URL: ${url}`);
}

describe("git bind contract", () => {
  afterEach(async () => {
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  describe("parseGitRemote", () => {
    it("parses GitHub SSH URLs", () => {
      const result = parseGitRemote("git@github.com:octocat/Hello-World.git");
      assert.equal(result.platform, "github");
      assert.equal(result.owner, "octocat");
      assert.equal(result.repo, "Hello-World");
      assert.equal(result.fullName, "octocat/Hello-World");
      assert.equal(result.url, "git@github.com:octocat/Hello-World.git");
    });

    it("parses GitHub HTTPS URLs", () => {
      const result = parseGitRemote("https://github.com/octocat/Hello-World.git");
      assert.equal(result.platform, "github");
      assert.equal(result.owner, "octocat");
      assert.equal(result.repo, "Hello-World");
      assert.equal(result.fullName, "octocat/Hello-World");
      assert.equal(result.url, "https://github.com/octocat/Hello-World.git");
    });

    it("parses GitHub HTTPS URLs without .git suffix", () => {
      const result = parseGitRemote("https://github.com/octocat/Hello-World");
      assert.equal(result.platform, "github");
      assert.equal(result.owner, "octocat");
      assert.equal(result.repo, "Hello-World");
      assert.equal(result.fullName, "octocat/Hello-World");
    });

    it("parses GitLab SSH URLs", () => {
      const result = parseGitRemote("git@gitlab.com:group/project.git");
      assert.equal(result.platform, "gitlab");
      assert.equal(result.owner, "group");
      assert.equal(result.repo, "project");
      assert.equal(result.fullName, "group/project");
    });

    it("parses GitLab HTTPS URLs", () => {
      const result = parseGitRemote("https://gitlab.com/group/project.git");
      assert.equal(result.platform, "gitlab");
      assert.equal(result.owner, "group");
      assert.equal(result.repo, "project");
      assert.equal(result.fullName, "group/project");
    });

    it("parses Bitbucket SSH URLs", () => {
      const result = parseGitRemote("git@bitbucket.org:workspace/repo.git");
      assert.equal(result.platform, "bitbucket");
      assert.equal(result.owner, "workspace");
      assert.equal(result.repo, "repo");
      assert.equal(result.fullName, "workspace/repo");
    });

    it("parses Bitbucket HTTPS URLs", () => {
      const result = parseGitRemote("https://bitbucket.org/workspace/repo.git");
      assert.equal(result.platform, "bitbucket");
      assert.equal(result.owner, "workspace");
      assert.equal(result.repo, "repo");
      assert.equal(result.fullName, "workspace/repo");
    });

    it("parses generic HTTPS git URLs", () => {
      const result = parseGitRemote("https://git.example.com/repo.git");
      assert.equal(result.platform, "generic");
      assert.equal(result.url, "https://git.example.com/repo.git");
    });

    it("parses generic HTTP git URLs", () => {
      const result = parseGitRemote("http://git.example.com/repo.git");
      assert.equal(result.platform, "generic");
      assert.equal(result.url, "http://git.example.com/repo.git");
    });

    it("parses generic git protocol URLs", () => {
      const result = parseGitRemote("git://git.example.com/repo.git");
      assert.equal(result.platform, "generic");
      assert.equal(result.url, "git://git.example.com/repo.git");
    });

    it("rejects invalid URLs", () => {
      assert.throws(() => parseGitRemote("not-a-url"), /invalid git remote URL/);
      assert.throws(() => parseGitRemote(""), /invalid git remote URL/);
      // Valid URL format is accepted as generic
      const result = parseGitRemote("https://not-a-git-url");
      assert.equal(result.platform, "generic");
      assert.equal(result.url, "https://not-a-git-url");
    });
  });

  describe("bindProjectGit registry integration", () => {
    it("stores git remote in project registry", async () => {
      const root = await tempDir("cpb-git-bind-");
      const { resolveHubRoot, registerProject, bindProjectGit, getProject } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      const project = await registerProject(hubRoot, { id: "test-project", sourcePath: root });

      const remoteInfo = parseGitRemote("git@github.com:octocat/Hello-World.git");
      const bound = await bindProjectGit(hubRoot, "test-project", remoteInfo);

      assert.equal(bound.git.url, "git@github.com:octocat/Hello-World.git");
      assert.equal(bound.git.platform, "github");
      assert.equal(bound.git.owner, "octocat");
      assert.equal(bound.git.repo, "Hello-World");
      assert.equal(bound.git.fullName, "octocat/Hello-World");
      assert.ok(bound.git.boundAt);

      const retrieved = await getProject(hubRoot, "test-project");
      assert.deepEqual(retrieved.git, bound.git);
    });

    it("returns null for non-existent project", async () => {
      const root = await tempDir("cpb-git-bind-null-");
      const { resolveHubRoot, bindProjectGit } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      const remoteInfo = parseGitRemote("https://github.com/octocat/Hello-World.git");

      const result = await bindProjectGit(hubRoot, "non-existent", remoteInfo);
      assert.equal(result, null);
    });

    it("stores generic git remotes", async () => {
      const root = await tempDir("cpb-git-bind-generic-");
      const { resolveHubRoot, registerProject, bindProjectGit, getProject } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      const project = await registerProject(hubRoot, { id: "generic-project", sourcePath: root });

      const remoteInfo = parseGitRemote("https://git.example.com/custom-repo.git");
      const bound = await bindProjectGit(hubRoot, "generic-project", remoteInfo);

      assert.equal(bound.git.url, "https://git.example.com/custom-repo.git");
      assert.equal(bound.git.platform, "generic");
      assert.equal(bound.git.fullName, null);

      const retrieved = await getProject(hubRoot, "generic-project");
      assert.equal(retrieved.git.platform, "generic");
    });

    it("validates project ID format", async () => {
      const root = await tempDir("cpb-git-bind-invalid-");
      const { resolveHubRoot, bindProjectGit } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      const remoteInfo = parseGitRemote("https://github.com/octocat/Hello-World.git");

      await assert.rejects(
        bindProjectGit(hubRoot, "invalid project id!", remoteInfo),
        /invalid project id/
      );
    });

    it("validates remoteInfo structure", async () => {
      const root = await tempDir("cpb-git-bind-bad-remote-");
      const { resolveHubRoot, registerProject, bindProjectGit } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      await registerProject(hubRoot, { id: "test-project", sourcePath: root });

      await assert.rejects(
        bindProjectGit(hubRoot, "test-project", null),
        /remoteInfo must be an object/
      );

      await assert.rejects(
        bindProjectGit(hubRoot, "test-project", {}),
        /remoteInfo\.url is required/
      );

      await assert.rejects(
        bindProjectGit(hubRoot, "test-project", { url: "" }),
        /remoteInfo\.url is required/
      );
    });

    it("preserves existing git bindings on rebind", async () => {
      const root = await tempDir("cpb-git-rebind-");
      const { resolveHubRoot, registerProject, bindProjectGit, getProject } = await import("../server/services/hub-registry.js");

      const hubRoot = resolveHubRoot(root);
      await registerProject(hubRoot, { id: "test-project", sourcePath: root });

      const firstRemote = parseGitRemote("https://github.com/first/repo.git");
      await bindProjectGit(hubRoot, "test-project", firstRemote);

      const secondRemote = parseGitRemote("https://gitlab.com/second/repo.git");
      const bound = await bindProjectGit(hubRoot, "test-project", secondRemote);

      assert.equal(bound.git.platform, "gitlab");
      assert.equal(bound.git.fullName, "second/repo");
      assert.ok(bound.git.boundAt);
    });
  });
});
