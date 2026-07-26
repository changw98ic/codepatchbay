import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  _internalWithTemporaryWorkspaceHooks,
  temporaryWorkspaceErrorDetails,
} from "../core/runtime/temporary-workspace.js";
import {
  closeGithubIssueWithGh,
  createPullRequestWithGh,
  openDraftPullRequest,
  preparePullRequestBranchWithGit,
} from "../server/services/github/github-issues.js";

async function exists(target: string) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function disposeGithubTemporaryPath(target: string) {
  const resolved = path.resolve(target);
  const temp = await realpath(tmpdir());
  const parent = await realpath(path.dirname(resolved));
  const basename = path.basename(resolved);
  if (
    parent !== temp
    || (!basename.startsWith("cpb-git-askpass-") && !basename.startsWith("cpb-pr-body-"))
  ) {
    throw new Error(`refusing to remove unexpected GitHub temporary path: ${target}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

function prReadyJob() {
  return {
    status: "completed",
    jobId: "job-pr",
    task: "Fix issue",
    worktree: "/tmp/worktree",
    worktreeBranch: "cpb/job-pr",
    worktreeBaseBranch: "main",
    commit: "b".repeat(40),
    sourceContext: {
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: "Fix issue",
    },
  };
}

function remoteCapability() {
  return {
    schema: "cpb.github-remote-capability.v1" as const,
    repository: "owner/repo",
    repositoryId: "R_owner_repo",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json" as const,
    markerSha: "a".repeat(40),
    issueNumber: 42,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
}

async function boundActorAuthority(request?: { operation?: string }) {
  return request?.operation === "pull_request.create"
    ? { authorLogin: "cpb-bot", authorId: "91" }
    : undefined;
}

test("openDraftPullRequest defaults to dry-run and does not create or push", async () => {
  let createPullRequestCalls = 0;
  let commandCalls = 0;

  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/1", number: 1 };
    },
    runCommand: async () => {
      commandCalls += 1;
      throw new Error("implicit dry-run must not run git or gh");
    },
  });

  assert.equal(result.status, "dry-run");
  assert.equal(result.posted, false);
  assert.equal(result.request.repo, "owner/repo");
  assert.equal(result.request.head, "cpb/job-pr");
  assert.equal(createPullRequestCalls, 0);
  assert.equal(commandCalls, 0);
});

test("openDraftPullRequest requires explicit live opt-in before creating a PR", async () => {
  let createPullRequestCalls = 0;

  const blocked = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/1", number: 1 };
    },
  });

  assert.equal(blocked.status, "blocked.pr");
  assert.match(blocked.evidence.reason, /requires explicit live finalization opt-in/);
  assert.equal(createPullRequestCalls, 0);

  const missingCapability = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });
  assert.equal(missingCapability.status, "blocked.pr");
  assert.match(missingCapability.evidence.reason, /requires a remote capability/);
  assert.equal(missingCapability.evidence.committed, false);
  assert.equal(createPullRequestCalls, 0);

  const opened = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(opened.status, "pr.opened");
  assert.equal(opened.prNumber, 7);
  assert.equal(createPullRequestCalls, 1);
});

test("openDraftPullRequest blocks creation when branch push resolves with a non-zero result", async () => {
  let createPullRequestCalls = 0;
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: false,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: null }),
    runCommand: async (_command, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "rejected", status: 1 };
      return { stdout: "", stderr: "", code: 0 };
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(result.status, "blocked.pr");
  assert.equal(result.evidence?.committed, null);
  assert.equal(createPullRequestCalls, 0);
});

test("openDraftPullRequest trusts exact push readback after a non-zero transport result", async () => {
  let createPullRequestCalls = 0;
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: false,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    runCommand: async (_command, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "push") return { stdout: "", stderr: "connection reset", status: 1 };
      return { stdout: "", stderr: "", code: 0 };
    },
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(result.status, "pr.opened");
  assert.equal(createPullRequestCalls, 1);
  assert.match(
    String((result.branchPreparation?.verification as Record<string, any>)?.evidence?.transportWarning?.message || ""),
    /connection reset/,
  );
});

test("openDraftPullRequest does not report a resolved non-zero gh submission as opened", async () => {
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: false }),
    runCommand: async () => ({
      stdout: "",
      stderr: "GraphQL denied",
      status: 1,
    }),
  });

  assert.equal(result.status, "blocked.pr");
  assert.equal(result.evidence?.committed, false);
  assert.equal(result.prUrl, undefined);
});

test("openDraftPullRequest recovers one exact PR after create committed then transport threw", async () => {
  let discoveryRequests = 0;
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    pushToken: "opaque-create-token",
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => {
      discoveryRequests += 1;
      assert.equal(request.pullRequestNumber, undefined);
      assert.equal(request.authorLogin, "cpb-bot");
      assert.equal(request.authorId, "91");
      assert.equal(request.draft, true);
      assert.match(String(request.body), /CodePatchBay/);
      return {
        operation: request.operation,
        committed: true,
        evidence: {
          matchCount: 1,
          pullRequest: {
            number: 77,
            url: "https://github.com/owner/repo/pull/77",
          },
        },
      };
    },
    createPullRequest: async () => {
      throw new Error("reply lost after commit; token=opaque-create-token");
    },
  });

  assert.equal(result.status, "pr.opened");
  assert.equal(result.prNumber, 77);
  assert.equal(result.response?.recoveredByExactGenerationDiscovery, true);
  assert.equal((result.remoteWrites as any)?.pullRequestCreate?.committed, true);
  assert.equal(discoveryRequests, 1);
  assert.doesNotMatch(JSON.stringify(result), /opaque-create-token/);
  assert.match(JSON.stringify(result), /\[REDACTED\]/);
});

test("openDraftPullRequest verifies cleanup operationResult by number before discovery", async () => {
  let verifiedNumber: unknown = null;
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => {
      verifiedNumber = request.pullRequestNumber;
      return {
        operation: request.operation,
        committed: true,
        evidence: {
          pullRequest: { number: 78, url: "https://github.com/owner/repo/pull/78" },
        },
      };
    },
    createPullRequest: async () => {
      throw Object.assign(new Error("cleanup failed after creation"), {
        committed: true,
        operationResult: { number: 78, url: "https://github.com/owner/repo/pull/78" },
      });
    },
  });

  assert.equal(result.status, "pr.opened");
  assert.equal(result.prNumber, 78);
  assert.equal(verifiedNumber, 78);
});

test("openDraftPullRequest redacts arbitrary connector response secrets before returning evidence", async () => {
  const token = "opaque-response-token";
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    pushToken: token,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    createPullRequest: async () => ({
      url: "https://github.com/owner/repo/pull/79",
      number: 79,
      headers: { cookie: "session=raw-cookie", authorization: "Bearer raw-bearer-value" },
      diagnostic: `connector echoed ${token}`,
      apiKey: "sk-secret-response-value",
    }),
  });

  assert.equal(result.status, "pr.opened");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /opaque-response-token|raw-cookie|raw-bearer-value|sk-secret-response-value/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("openDraftPullRequest revalidates capability before branch push and PR creation", async () => {
  const order: string[] = [];
  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: false,
    dryRun: false,
    allowLive: true,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: async (request) => {
      order.push(`${request.operation}.authorize`);
      return request.operation === "pull_request.create"
        ? { authorLogin: "cpb-bot", authorId: "91" }
        : undefined;
    },
    remoteCommitVerifier: async (request) => {
      order.push(`${request.operation}.verify`);
      return { operation: request.operation, committed: true };
    },
    runCommand: async (_command, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "push") order.push("repository.push.write");
      return { stdout: "", stderr: "", code: 0 };
    },
    createPullRequest: async () => {
      order.push("pull_request.create.write");
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(result.status, "pr.opened");
  assert.equal(result.committed, true);
  assert.deepEqual(order, [
    "repository.push.authorize",
    "repository.push.authorize",
    "repository.push.authorize",
    "repository.push.write",
    "repository.push.verify",
    "pull_request.create.authorize",
    "pull_request.create.write",
    "pull_request.create.verify",
  ]);
});

test("preparePullRequestBranchWithGit rejects stale capability before git add or commit", async () => {
  const localMutations: string[] = [];
  let authorityChecks = 0;
  const result = await preparePullRequestBranchWithGit({
    repo: "owner/repo",
    head: "cpb/job-pr",
    base: "main",
  }, prReadyJob(), {
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: async () => {
      authorityChecks += 1;
      throw Object.assign(new Error("marker generation changed"), { committed: false });
    },
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    runCommand: async (_command, args) => {
      if (["add", "commit", "push"].includes(args[0])) localMutations.push(args[0]);
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.committed, false);
  assert.equal(authorityChecks, 1);
  assert.deepEqual(localMutations, []);
});

test("controlled PR push ignores hostile Git rewrites, SSH commands, proxies, and source config", async () => {
  const token = "github_pat_controlled_transport";
  let pushCalls = 0;
  const result = await preparePullRequestBranchWithGit({
    repo: "owner/repo",
    head: "cpb/job-pr",
    base: "main",
  }, prReadyJob(), {
    token,
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    env: {
      PATH: `/hostile/bin${path.delimiter}${process.env.PATH || ""}`,
      HOME: "/hostile/home",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url.ssh://attacker/.insteadOf",
      GIT_CONFIG_VALUE_0: "https://github.com/",
      GIT_SSH_COMMAND: "steal-token",
      HTTPS_PROXY: "https://attacker.invalid",
      OPENAI_API_KEY: "must-not-cross-boundary",
    },
    runCommand: async (command, args, options) => {
      assert.equal(command, "git");
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "push") {
        pushCalls += 1;
        assert.match(String(options?.cwd || ""), /cpb-git-askpass-.*\/push\.git$/);
        assert.equal(args[1], "--force-with-lease=refs/heads/cpb/job-pr:");
        assert.equal(args[2], "https://github.com/owner/repo.git");
        assert.equal(args[3], `${"b".repeat(40)}:refs/heads/cpb/job-pr`);
        const pushEnv = options?.env || {};
        assert.equal(pushEnv.GIT_CONFIG_NOSYSTEM, "1");
        assert.equal(pushEnv.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null");
        assert.equal(pushEnv.GIT_CONFIG_KEY_0, "core.hooksPath");
        assert.equal(pushEnv.GIT_NO_REPLACE_OBJECTS, "1");
        assert.equal(pushEnv.GIT_OBJECT_DIRECTORY, undefined);
        assert.equal(pushEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
        assert.equal(pushEnv.GIT_COMMON_DIR, undefined);
        assert.equal(pushEnv.GIT_DIR, undefined);
        assert.equal(pushEnv.GIT_WORK_TREE, undefined);
        assert.equal(pushEnv.GIT_SSH_COMMAND, undefined);
        assert.equal(pushEnv.HTTPS_PROXY, undefined);
        assert.equal(pushEnv.OPENAI_API_KEY, undefined);
        assert.notEqual(pushEnv.HOME, "/hostile/home");
        assert.equal(pushEnv.CPB_GIT_ASKPASS_TOKEN, token);
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(pushCalls, 1);
});

test("controlled PR push rejects a clean source worktree containing a Git replacement ref", async () => {
  let pushCalls = 0;
  let replacementChecks = 0;
  const result = await preparePullRequestBranchWithGit({
    repo: "owner/repo",
    head: "cpb/job-pr",
    base: "main",
  }, prReadyJob(), {
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    env: {
      PATH: process.env.PATH,
      GIT_OBJECT_DIRECTORY: "/attacker/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/attacker/alternates",
      GIT_COMMON_DIR: "/attacker/common",
      GIT_DIR: "/attacker/git-dir",
      GIT_WORK_TREE: "/attacker/work-tree",
      GIT_REPLACE_REF_BASE: "refs/attacker/",
    },
    runCommand: async (_command, args, options) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "for-each-ref") {
        replacementChecks += 1;
        assert.deepEqual(args, ["for-each-ref", "--format=%(refname)", "refs/replace/"]);
        const gitEnv = options?.env || {};
        assert.equal(gitEnv.GIT_NO_REPLACE_OBJECTS, "1");
        assert.equal(gitEnv.GIT_OBJECT_DIRECTORY, undefined);
        assert.equal(gitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES, undefined);
        assert.equal(gitEnv.GIT_COMMON_DIR, undefined);
        assert.equal(gitEnv.GIT_DIR, undefined);
        assert.equal(gitEnv.GIT_WORK_TREE, undefined);
        assert.equal(gitEnv.GIT_REPLACE_REF_BASE, undefined);
        return { stdout: "refs/replace/hostile\n", stderr: "", code: 0 };
      }
      if (args[0] === "push") pushCalls += 1;
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.committed, false);
  assert.equal(replacementChecks, 1);
  assert.equal(pushCalls, 0);
  assert.match(String((result.error as Record<string, unknown>)?.message || ""), /replacement refs/);
});

test("controlled PR push rejects local clean filters before creating a transport capsule", async () => {
  let pushCalls = 0;
  let cloneCalls = 0;
  const result = await preparePullRequestBranchWithGit({
    repo: "owner/repo",
    head: "cpb/job-pr",
    base: "main",
  }, prReadyJob(), {
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    runCommand: async (_command, args, options) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
      if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "config" && args[1] === "--local" && options?.env?.GIT_NO_REPLACE_OBJECTS === "1") {
        return { stdout: "filter.hostile.clean\n", stderr: "", code: 0 };
      }
      if (args[0] === "clone") cloneCalls += 1;
      if (args[0] === "push") pushCalls += 1;
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.committed, false);
  assert.equal(cloneCalls, 0);
  assert.equal(pushCalls, 0);
  assert.match(String((result.error as Record<string, unknown>)?.message || ""), /unsafe local Git configuration/);
});

test("controlled PR push rejects a source commit whose replacement-disabled tree differs from audit", async () => {
  let bundleCalls = 0;
  let pushCalls = 0;
  const commit = "b".repeat(40);
  const result = await preparePullRequestBranchWithGit({
    repo: "owner/repo",
    head: "cpb/job-pr",
    base: "main",
  }, {
    ...prReadyJob(),
    auditedCommit: commit,
    auditedTree: commit,
  }, {
    remoteCapability: remoteCapability(),
    remoteAuthorityValidator: boundActorAuthority,
    remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
    runCommand: async (_command, args, options) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "for-each-ref" || args[0] === "config") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") {
        if (args[1] === "--git-path") return { stdout: `missing-${args[2]}\n`, stderr: "", code: 0 };
        if (args[2] === `${commit}^{tree}` && options?.env?.GIT_NO_REPLACE_OBJECTS === "1") {
          return { stdout: `${"c".repeat(40)}\n`, stderr: "", code: 0 };
        }
        return { stdout: `${commit}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "bundle") bundleCalls += 1;
      if (args[0] === "push") pushCalls += 1;
      return { stdout: "", stderr: "", code: 0 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.evidence.committed, false);
  assert.equal(bundleCalls, 0);
  assert.equal(pushCalls, 0);
  assert.match(String((result.error as Record<string, unknown>)?.message || ""), /source tree does not match/);
});

test("closeGithubIssueWithGh rejects fulfilled non-zero results and confirms CLOSED state", async () => {
  await assert.rejects(
    closeGithubIssueWithGh({ repo: "owner/repo", number: 42 }, {
      runCommand: async () => ({ stdout: "", stderr: "not authorized", code: 1 }),
    }),
    /not authorized/,
  );

  let calls = 0;
  const closed = await closeGithubIssueWithGh({ repo: "owner/repo", number: 42 }, {
    runCommand: async (_command, args) => {
      calls += 1;
      if (args[1] === "view") {
        return { stdout: JSON.stringify({ number: 42, state: "CLOSED", url: "https://github.com/owner/repo/issues/42" }) };
      }
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(closed.ok, true);
  assert.equal(closed.state, "CLOSED");

  for (const observed of [
    { number: "42", state: "CLOSED", url: "https://github.com/owner/repo/issues/42" },
    { number: 42, state: "CLOSED", url: "https://github.com/attacker/foreign/issues/42" },
    { number: 42, state: "CLOSED", url: "https://github.com/owner/repo/pull/42" },
  ]) {
    let failure: unknown;
    try {
      await closeGithubIssueWithGh({ repo: "owner/repo", number: 42 }, {
        runCommand: async (_command, args) => args[1] === "view"
          ? { stdout: JSON.stringify(observed) }
          : { stdout: "", stderr: "" },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.equal((failure as Error & { committed?: boolean | null }).committed, null);
  }
});

test("createPullRequestWithGh transports the body through an owner-bound private workspace", async () => {
  let canonicalRoot = "";
  let quarantineRoot = "";
  try {
    const created = await _internalWithTemporaryWorkspaceHooks({
      afterQuarantineRename(context) {
        canonicalRoot = context.rootPath;
        quarantineRoot = context.quarantineRoot;
      },
    }, () => createPullRequestWithGh({
      repo: "owner/repo",
      title: "Owned temporary body",
      body: "private body transport\n",
      head: "cpb/job-pr",
      base: "main",
      draft: true,
    }, {
      runCommand: async (command, args) => {
        assert.equal(command, "gh");
        const bodyIndex = args.indexOf("--body-file");
        assert.notEqual(bodyIndex, -1);
        const bodyFile = args[bodyIndex + 1];
        assert.match(bodyFile, /cpb-pr-body-/);
        assert.equal(await readFile(bodyFile, "utf8"), "private body transport\n");
        const stats = await lstat(bodyFile);
        assert.equal(stats.mode & 0o777, 0o600);
        return {
          stdout: "https://github.com/owner/repo/pull/91\n",
          stderr: "",
          code: 0,
        };
      },
    }));

    assert.equal(created.number, 91);
    assert.notEqual(canonicalRoot, "");
    assert.notEqual(quarantineRoot, "");
    assert.equal(await exists(canonicalRoot), false);
    assert.equal(await exists(quarantineRoot), true);
  } finally {
    if (canonicalRoot) await disposeGithubTemporaryPath(canonicalRoot);
    if (quarantineRoot) await disposeGithubTemporaryPath(path.dirname(quarantineRoot));
  }
});

test("createPullRequestWithGh retains the verified PR identity when cleanup fails after creation", async () => {
  let canonicalRoot = "";
  let quarantineRoot = "";
  let failure: unknown;
  try {
    try {
      await _internalWithTemporaryWorkspaceHooks({
        async afterQuarantineRename(context) {
          canonicalRoot = context.rootPath;
          quarantineRoot = context.quarantineRoot;
          await mkdir(context.rootPath);
          await writeFile(path.join(context.rootPath, "successor.txt"), "preserve successor\n", "utf8");
        },
      }, () => createPullRequestWithGh({
        repo: "owner/repo",
        title: "Committed before cleanup",
        body: "body\n",
        head: "cpb/job-pr",
        base: "main",
      }, {
        runCommand: async () => ({
          stdout: "https://github.com/owner/repo/pull/92\n",
          stderr: "",
          code: 0,
        }),
      }));
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    const record = failure as Error & {
      code?: string;
      committed?: boolean;
      operationResult?: { url?: string; number?: number };
    };
    assert.equal(record.code, "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED");
    assert.equal(record.committed, true);
    assert.equal(record.operationResult?.url, "https://github.com/owner/repo/pull/92");
    assert.equal(record.operationResult?.number, 92);
    const cleanup = temporaryWorkspaceErrorDetails(record);
    assert.equal(cleanup?.code, "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED");
    assert.equal(cleanup?.successorPreserved, true);
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "preserve successor\n");
    assert.equal(await exists(quarantineRoot), true);
  } finally {
    if (canonicalRoot) await disposeGithubTemporaryPath(canonicalRoot);
    if (quarantineRoot) await disposeGithubTemporaryPath(path.dirname(quarantineRoot));
  }
});

test("createPullRequestWithGh preserves both command and hostile-successor cleanup failures", async () => {
  let canonicalRoot = "";
  let quarantineRoot = "";
  let failure: unknown;
  try {
    try {
      await _internalWithTemporaryWorkspaceHooks({
        async afterQuarantineRename(context) {
          canonicalRoot = context.rootPath;
          quarantineRoot = context.quarantineRoot;
          await mkdir(context.rootPath);
          await writeFile(path.join(context.rootPath, "successor.txt"), "preserve successor\n", "utf8");
        },
      }, () => createPullRequestWithGh({
        repo: "owner/repo",
        title: "Dual failure",
        body: "body\n",
        head: "cpb/job-pr",
        base: "main",
      }, {
        runCommand: async () => ({
          stdout: "",
          stderr: "primary gh failure",
          code: 1,
        }),
      }));
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof AggregateError);
    assert.equal(
      (failure as AggregateError & { code?: string }).code,
      "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED",
    );
    assert.equal(failure.errors.length, 2);
    assert.match(String(failure.errors[0]), /primary gh failure/);
    const cleanup = temporaryWorkspaceErrorDetails(failure);
    assert.equal(cleanup?.code, "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED");
    assert.equal(cleanup?.successorPreserved, true);
    assert.equal(cleanup?.quarantinePreserved, true);
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "preserve successor\n");
    assert.equal(await exists(quarantineRoot), true);
  } finally {
    if (canonicalRoot) await disposeGithubTemporaryPath(canonicalRoot);
    if (quarantineRoot) await disposeGithubTemporaryPath(path.dirname(quarantineRoot));
  }
});

test("token askpass transport never writes the secret and reports primary plus cleanup evidence", async () => {
  const token = "opaque-value-0123456789";
  let canonicalRoot = "";
  let quarantineRoot = "";
  let askpassScript = "";
  try {
    const result = await _internalWithTemporaryWorkspaceHooks({
      async afterQuarantineRename(context) {
        canonicalRoot = context.rootPath;
        quarantineRoot = context.quarantineRoot;
        await mkdir(context.rootPath);
        await writeFile(path.join(context.rootPath, "successor.txt"), "preserve successor\n", "utf8");
      },
    }, () => preparePullRequestBranchWithGit({
      repo: "owner/repo",
      head: "cpb/job-pr",
      base: "main",
    }, prReadyJob(), {
      token,
      remoteCapability: remoteCapability(),
      remoteAuthorityValidator: boundActorAuthority,
      remoteCommitVerifier: async (request) => ({ operation: request.operation, committed: true }),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "sk-unrelated-provider-secret",
      },
      runCommand: async (command, args, options) => {
        assert.equal(command, "git");
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
        if (args[0] === "push") {
          const env = options?.env || {};
          const askpass = String(env.GIT_ASKPASS || "");
          askpassScript = await readFile(askpass, "utf8");
          assert.doesNotMatch(askpassScript, new RegExp(token));
          assert.equal(env.CPB_GIT_ASKPASS_TOKEN, token);
          assert.equal(env.OPENAI_API_KEY, undefined);
          assert.doesNotMatch(JSON.stringify(args), new RegExp(token));
          return { stdout: "", stderr: `push rejected for ${token}`, code: 1 };
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    }));

    assert.equal(result.ok, false);
    assert.match(askpassScript, /CPB_GIT_ASKPASS_TOKEN/);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, new RegExp(token));
    assert.match(serialized, /\[REDACTED\]/);
    const error = result.error as Record<string, unknown>;
    assert.equal(error.code, "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED");
    const operationResult = error.operationResult as Record<string, unknown>;
    assert.equal(operationResult.committed, true);
    assert.match(JSON.stringify(operationResult), /transportWarning/);
    const cleanup = temporaryWorkspaceErrorDetails(error.cleanup);
    assert.equal(cleanup?.code, "TEMPORARY_WORKSPACE_QUARANTINE_PRESERVED");
    assert.equal(cleanup?.successorPreserved, true);
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "preserve successor\n");
    assert.equal(await exists(quarantineRoot), true);
  } finally {
    if (canonicalRoot) await disposeGithubTemporaryPath(canonicalRoot);
    if (quarantineRoot) await disposeGithubTemporaryPath(path.dirname(quarantineRoot));
  }
});

test("token push revalidates remote truth before a hostile cleanup failure", async () => {
  let canonicalRoot = "";
  let quarantineRoot = "";
  let remoteVerified = false;
  try {
    const result = await _internalWithTemporaryWorkspaceHooks({
      async afterQuarantineRename(context) {
        assert.equal(remoteVerified, true);
        canonicalRoot = context.rootPath;
        quarantineRoot = context.quarantineRoot;
        await mkdir(context.rootPath);
        await writeFile(path.join(context.rootPath, "successor.txt"), "preserve successor\n", "utf8");
      },
    }, () => preparePullRequestBranchWithGit({
      repo: "owner/repo",
      head: "cpb/job-pr",
      base: "main",
    }, prReadyJob(), {
      token: "github_pat_remote_truth_before_cleanup",
      remoteCapability: remoteCapability(),
      remoteAuthorityValidator: boundActorAuthority,
      remoteCommitVerifier: async (request) => {
        remoteVerified = true;
        return {
          operation: request.operation,
          committed: false,
          reason: "remote ref did not match",
        };
      },
      runCommand: async (_command, args) => {
        if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
        if (args[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
    }));

    assert.equal(result.ok, false);
    assert.equal(result.evidence.committed, false);
    const error = result.error as Record<string, unknown>;
    assert.equal(error.code, "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED");
    assert.deepEqual(error.operationResult, {
      operation: "repository.push",
      committed: false,
      reason: "remote ref did not match",
    });
    const cleanup = temporaryWorkspaceErrorDetails(error.cleanup);
    assert.equal(cleanup?.successorPreserved, true);
    assert.equal(await readFile(path.join(canonicalRoot, "successor.txt"), "utf8"), "preserve successor\n");
    assert.equal(await exists(quarantineRoot), true);
  } finally {
    if (canonicalRoot) await disposeGithubTemporaryPath(canonicalRoot);
    if (quarantineRoot) await disposeGithubTemporaryPath(path.dirname(quarantineRoot));
  }
});
